/**
 * GitHub source channel for the 我的眼睛 (My Eyes) self-update.
 *
 * `eyes { action: "update" }` accepts either a local directory (the original
 * behaviour) or a GitHub repository: `github:owner/repo`, `github:owner/repo@ref`,
 * `owner/repo`, or `https://github.com/owner/repo` (optionally `#ref` or `/tree/ref`).
 * A repository is materialised into a cache directory under the plugin work
 * directory, so nothing but plugin files ever lands outside it.
 *
 * Two fetching strategies:
 *   1. REST API zipball (default) — `api.github.com` resolves the ref and returns a
 *      signed codeload archive, then `Expand-Archive` unpacks it. Needs no git, works
 *      on networks where git-over-HTTPS is reset or missing, accepts a token, and the
 *      commit is resolved through the API so an upgrade stays traceable.
 *   2. `git` shallow clone/fetch (opt-in via `preferGit`, or automatic fallback) — one
 *      commit per fetch, reuses the cache, and pins tags. A token reaches git through an
 *      ephemeral `http.extraheader`, never through `.git/config` or a remote URL.
 *
 * Every failure is reported with the command that failed and a redacted stderr tail;
 * a token in a spec or an error string is masked before it reaches a log or a result.
 */

import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { join, resolve } from 'node:path'

const DEFAULT_TIMEOUT_MS = 180_000
const API_ROOT = 'https://api.github.com'
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
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

export function looksLikeSource(dir) {
  return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'eyes.ps1'))
}

function freshDir(dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

/* ------------------------------------------------------------ REST API channel */

function apiHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-my-eyes-update',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function describeApiFailure(status, body, token) {
  const message = typeof body === 'object' && body ? body.message : String(body ?? '')
  if (status === 404) {
    return `GitHub returned 404 (repository or ref not found${token ? '' : '; private repositories need GITHUB_TOKEN'})`
  }
  if (status === 403 || status === 429) {
    return `GitHub refused the request (HTTP ${status}${token ? '' : ', unauthenticated rate limit is 60 requests/hour — set GITHUB_TOKEN'}): ${maskSecret(message, token)}`
  }
  return `GitHub API HTTP ${status}: ${maskSecret(message, token)}`
}

async function apiRequest(path, { token, timeoutMs = 30_000 } = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: apiHeaders(token),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: response.status, ok: response.ok, body }
}

/** Resolve a ref (default branch when omitted) to a commit via the API. */
export async function resolveCommit({ repo, ref, token }) {
  const path = ref
    ? `/repos/${repo}/commits/${encodeURIComponent(ref)}`
    : `/repos/${repo}/commits?per_page=1`
  const response = await apiRequest(path, { token })
  if (!response.ok) return undefined
  const commit = Array.isArray(response.body) ? response.body[0] : response.body
  const sha = commit?.sha
  return typeof sha === 'string' ? sha.slice(0, 7) : undefined
}

async function downloadToFile(url, target, { token, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    headers: apiHeaders(token),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let body = text
    try { body = JSON.parse(text) } catch { /* keep text */ }
    throw new Error(describeApiFailure(response.status, body, token))
  }
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_ARCHIVE_BYTES) {
    throw new Error(`archive is ${Math.round(declared / 1024 / 1024)} MB, which is larger than the ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB limit`)
  }
  await new Promise((resolvePromise, rejectPromise) => {
    const out = createWriteStream(target)
    let written = 0
    const stream = Readable.fromWeb(response.body)
    stream.on('data', (chunk) => {
      written += chunk.length
      if (written > MAX_ARCHIVE_BYTES) {
        stream.destroy(new Error('archive exceeded the size limit while downloading'))
      }
    })
    stream.on('error', rejectPromise)
    out.on('error', rejectPromise)
    out.on('finish', () => out.close(() => resolvePromise()))
    stream.pipe(out)
  })
  return target
}

function expandZip(dest, zipPath) {
  const script = [
    "$ErrorActionPreference='Stop'",
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
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

/** Move the single `repo-ref/` folder produced by a zipball up into `dest`. */
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

/** Fetch through the REST API zipball (no git required). */
export async function fetchWithApiZip({ repo, ref, dest, token, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const commit = await resolveCommit({ repo, ref, token }).catch(() => undefined)
  const url = ref
    ? `${API_ROOT}/repos/${repo}/zipball/${encodeURIComponent(ref)}`
    : `${API_ROOT}/repos/${repo}/zipball`
  const zipPath = `${dest}.zip`
  freshDir(dest)
  await downloadToFile(url, zipPath, { token, timeoutMs })
  try {
    expandZip(dest, zipPath)
  } finally {
    rmSync(zipPath, { force: true })
  }
  flattenZipRoot(dest)
  if (!looksLikeSource(dest)) {
    rmSync(dest, { recursive: true, force: true })
    throw new Error(`"${repo}" does not look like a my-eyes package (no package.json + eyes.ps1 at the root)`)
  }
  return { path: dest, commit, method: 'api-zip' }
}

/* ----------------------------------------------------------------- git channel */

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

/** Fetch `repo` at `ref` through git into `dest`, reusing an existing shallow clone. */
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

/**
 * Materialise a GitHub repository at `ref` inside `cacheDir`.
 *
 * Order matters: the REST API path is tried first because it survives networks that
 * reset git-over-HTTPS, and because it is the only path that works without git at all.
 * `preferGit` flips the order for machines that want the cheap incremental fetch.
 *
 * @returns {Promise<{path:string, repo:string, ref?:string, commit?:string, method:string}>}
 */
export async function fetchGitHubSource({ repo, ref, cacheDir, token, gitPath = 'git', preferGit = false, timeoutMs = DEFAULT_TIMEOUT_MS, logger } = {}) {
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`invalid repository "${repo}"; expected owner/name`)
  }
  mkdirSync(cacheDir, { recursive: true })
  const dest = join(cacheDir, `${safeSlug(repo)}@${safeSlug(ref || 'default')}`)

  const api = async () => {
    const result = await fetchWithApiZip({ repo, ref, dest, token, timeoutMs })
    return { ...result, repo, ref }
  }
  const git = async () => {
    const result = fetchWithGit({ repo, ref, dest, token, gitPath, timeoutMs })
    return { ...result, repo, ref }
  }

  const attempts = preferGit ? [['git', git], ['api', api]] : [['api', api], ['git', git]]
  const failures = []
  for (const [name, attempt] of attempts) {
    try {
      return await attempt()
    } catch (error) {
      const message = maskSecret(error.message ?? String(error), token)
      failures.push(`${name}: ${message}`)
      logger?.warn?.(`[my-eyes] ${name} fetch failed, trying the other channel: ${message}`)
    }
  }
  throw new Error(`could not fetch ${repo}${ref ? `@${ref}` : ''} — ${failures.join(' | ')}`)
}
