/**
 * GitHub source channel for the 我的眼睛 (My Eyes) self-update.
 *
 * `eyes { action: "update" }` accepts either a local directory (the original
 * behaviour) or a GitHub repository: `github:owner/repo`, `github:owner/repo@ref`,
 * `owner/repo`, or `https://github.com/owner/repo` (optionally `#ref` or `/tree/ref`).
 * A repository is materialised into a cache directory under the plugin work
 * directory, so nothing but plugin files ever lands outside it.
 *
 * Two fetching strategies, tried in this order:
 *   1. `git` — shallow fetch of exactly one ref into `<cache>/<repo>@<ref>`. Cheap to
 *      refresh (a fetch of one commit), and a tag can be pinned for reproducible
 *      installs. Works with a token through an ephemeral `http.extraheader`, which is
 *      never written into the repository's `.git/config`.
 *   2. HTTPS zip from `codeload.github.com` + `Expand-Archive` — used when git is not
 *      installed. Costs a full download per update, so it is only a fallback.
 *
 * Every failure is reported with the command that failed and a redacted stderr tail;
 * a token in a spec or an error string is masked before it reaches a log or a result.
 */

import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { join, resolve } from 'node:path'

const DEFAULT_TIMEOUT_MS = 180_000
const GITHUB_PREFIX = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[@#](.+))?$/
const GITHUB_URL = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/(.+?))?(?:[?#](.+))?\/?$/

export function maskSecret(text, secret) {
  if (!secret) return String(text)
  return String(text).split(secret).join('***')
}

/**
 * Classify an update source string.
 * @returns {{kind:'local', path:string} | {kind:'github', repo:string, ref?:string, spec:string}}
 */
export function parseSourceSpec(spec) {
  const raw = String(spec ?? '').trim()
  if (raw === '') return { kind: 'local', path: '' }

  if (/^github:/i.test(raw)) {
    const match = GITHUB_PREFIX.exec(raw)
    if (!match) throw new Error(`malformed GitHub source "${raw}"; expected github:owner/repo[@ref]`)
    return { kind: 'github', repo: `${match[1]}/${match[2]}`, ref: match[3] || undefined, spec: raw }
  }

  if (/^https?:\/\/(?:www\.)?github\.com\//i.test(raw)) {
    const match = GITHUB_URL.exec(raw.split('#')[0])
    if (!match) throw new Error(`malformed GitHub URL "${raw}"; expected https://github.com/owner/repo[/tree/ref]`)
    const hash = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : undefined
    return { kind: 'github', repo: `${match[1]}/${match[2]}`, ref: match[3] || hash || undefined, spec: raw }
  }

  return { kind: 'local', path: resolve(raw) }
}

function safeSlug(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '-')
}

function gitEnv(token) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: 'echo' }
  // A token is handed to git as an ephemeral config entry, never in the remote URL,
  // so it cannot end up persisted in `.git/config`.
  if (token) {
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  }
  return env
}

function runGit(gitPath, args, { token, cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const result = spawnSync(gitPath, args, {
    cwd,
    env: gitEnv(token),
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  const stderr = maskSecret(result.stderr ?? '', token)
  if (result.error) {
    const code = result.error.code ?? ''
    const hint = code === 'ENOENT' ? `git was not found at "${gitPath}"` : `${code} ${result.error.message}`
    throw new Error(`git ${args[0]} failed: ${hint}`)
  }
  if (result.status !== 0) {
    const detail = stderr.trim().split('\n').slice(-4).join(' | ').slice(0, 600)
    throw new Error(`git ${args[0]} exited ${result.status}: ${detail}`)
  }
  return { stdout: result.stdout ?? '', stderr }
}

function commitOf(gitPath, dir, token) {
  try {
    return runGit(gitPath, ['-C', dir, 'rev-parse', '--short', 'HEAD'], { token, timeoutMs: 20_000 }).stdout.trim()
  } catch {
    return undefined
  }
}

function looksLikeSource(dir) {
  return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'eyes.ps1'))
}

function freshDir(dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

/**
 * Fetch `repo` at `ref` through git into `dest`, reusing an existing shallow clone.
 */
export function fetchWithGit({ repo, ref, dest, token, gitPath = 'git', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const url = `https://github.com/${repo}.git`
  const branch = ref || undefined
  const refspec = ref ? ref : 'HEAD'

  if (existsSync(join(dest, '.git'))) {
    try {
      runGit(gitPath, ['-C', dest, 'fetch', '--depth', '1', 'origin', refspec], { token, timeoutMs })
      runGit(gitPath, ['-C', dest, 'reset', '--hard', 'FETCH_HEAD'], { token, timeoutMs: 60_000 })
      runGit(gitPath, ['-C', dest, 'clean', '-ffdx'], { token, timeoutMs: 60_000 })
      if (looksLikeSource(dest)) return { path: dest, commit: commitOf(gitPath, dest, token), method: 'git-fetch' }
    } catch {
      // A stale or half-broken cache is not worth repairing; re-clone below.
      freshDir(dest)
    }
  } else {
    freshDir(dest)
  }

  const cloneArgs = ['clone', '--depth', '1', '--no-tags']
  if (branch) cloneArgs.push('--branch', branch, '--single-branch')
  cloneArgs.push(url, dest)
  runGit(gitPath, cloneArgs, { token, timeoutMs })
  if (!looksLikeSource(dest)) {
    // Do not keep a directory that failed validation: a later attempt must start clean
    // instead of reusing (and re-validating) the same wrong checkout.
    rmSync(dest, { recursive: true, force: true })
    throw new Error(`"${repo}" does not look like a my-eyes package (no package.json + eyes.ps1 at the root)`)
  }
  return { path: dest, commit: commitOf(gitPath, dest, token), method: 'git-clone' }
}

function download(url, target, token, redirects = 0) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (redirects > 5) { rejectPromise(new Error('too many redirects')); return }
    const headers = { 'User-Agent': 'dsh-my-eyes-update', Accept: 'application/zip' }
    if (token) headers.Authorization = `Bearer ${token}`
    const request = httpsGet(url, { headers }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        download(response.headers.location, target, token, redirects + 1).then(resolvePromise, rejectPromise)
        return
      }
      if (status === 401 || status === 403) {
        response.resume()
        rejectPromise(new Error(`GitHub refused the download (HTTP ${status}); the repository may be private (set GITHUB_TOKEN) or the ref may not exist`))
        return
      }
      if (status === 404) {
        response.resume()
        rejectPromise(new Error('GitHub returned 404 for that repository/ref'))
        return
      }
      if (status !== 200) {
        response.resume()
        rejectPromise(new Error(`GitHub download failed with HTTP ${status}`))
        return
      }
      const out = createWriteStream(target)
      response.pipe(out)
      out.on('finish', () => out.close(() => resolvePromise(target)))
      out.on('error', rejectPromise)
    })
    request.on('error', rejectPromise)
    request.setTimeout(60_000, () => { request.destroy(new Error('download timed out')) })
  })
}

function expandZip(gitlessDir, zipPath) {
  const script = [
    "$ErrorActionPreference='Stop'",
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${gitlessDir.replace(/'/g, "''")}' -Force`,
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`unzip failed: ${(result.stderr ?? result.error?.message ?? '').slice(0, 400)}`)
  }
}

/** Move the single `repo-ref/` folder produced by a codeload zip up into `dest`. */
function flattenZipRoot(dest) {
  const entries = readdirSync(dest)
  if (entries.length !== 1) return
  const only = join(dest, entries[0])
  if (!statSync(only).isDirectory() || !existsSync(join(only, 'package.json'))) return
  for (const name of readdirSync(only)) {
    const to = join(dest, name)
    rmSync(to, { recursive: true, force: true })
    renameSync(join(only, name), to)
  }
  rmSync(only, { recursive: true, force: true })
}

function fetchWithZip({ repo, ref, dest, token }) {
  const branch = ref || 'HEAD'
  const url = branch === 'HEAD'
    ? `https://codeload.github.com/${repo}/zip/HEAD`
    : `https://codeload.github.com/${repo}/zip/${encodeURIComponent(branch)}`
  const zipPath = join(dest, '..', `${safeSlug(repo)}-${safeSlug(branch)}.zip`)
  return download(url, zipPath, token).then(() => {
    // A previous git attempt may have left a partial checkout here; the archive must
    // land in an empty directory or its single root folder cannot be flattened.
    freshDir(dest)
    expandZip(dest, zipPath)
    rmSync(zipPath, { force: true })
    flattenZipRoot(dest)
    if (!looksLikeSource(dest)) {
      throw new Error(`"${repo}" does not look like a my-eyes package (no package.json + eyes.ps1 at the root)`)
    }
    return { path: dest, commit: undefined, method: 'zip' }
  })
}

/**
 * Materialise a GitHub repository at `ref` inside `cacheDir`.
 * @returns {Promise<{path:string, repo:string, ref?:string, commit?:string, method:string}>}
 */
export async function fetchGitHubSource({ repo, ref, cacheDir, token, gitPath = 'git', timeoutMs = DEFAULT_TIMEOUT_MS, logger } = {}) {
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`invalid repository "${repo}"; expected owner/name`)
  }
  mkdirSync(cacheDir, { recursive: true })
  const dest = join(cacheDir, `${safeSlug(repo)}@${safeSlug(ref || 'default')}`)

  let gitError
  try {
    const result = fetchWithGit({ repo, ref, dest, token, gitPath, timeoutMs })
    return { ...result, repo, ref }
  } catch (error) {
    gitError = error
    logger?.warn?.(`[my-eyes] git fetch failed (${maskSecret(error.message, token)}), falling back to zip`)
  }

  try {
    const result = await fetchWithZip({ repo, ref, dest, token })
    return { ...result, repo, ref }
  } catch (error) {
    // Both channels failed: report the more actionable of the two messages.
    throw new Error(`could not fetch ${repo}${ref ? `@${ref}` : ''}: ${maskSecret(error.message, token)} (git: ${maskSecret(gitError.message, token)})`)
  }
}

/** Read JSON that may carry a UTF-8 BOM (Windows editors and some exporters add one). */
export function readJsonFile(path) {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

/** Read the version a fetched source advertises. */
export function versionOfSource(dir) {
  try {
    const pkg = readJsonFile(join(dir, 'package.json'))
    return { version: pkg.version, name: pkg.name }
  } catch (error) {
    throw new Error(`cannot read package.json in ${dir}: ${String(error.message ?? error)}`)
  }
}
