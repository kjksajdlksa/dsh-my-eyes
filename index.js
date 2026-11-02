/**
 * 我的眼睛 (My Eyes) — the model's own eyes on this Windows desktop.
 *
 * One `eyes` tool with an action discriminator:
 *   info       engine + screen + foreground window snapshot
 *   look       one snapshot of the desktop / a monitor / a region / a window,
 *              returned as an image block so the model sees it in the same step
 *   windows    visible top-level windows with geometry, so a window can be targeted
 *   watch      a short dynamic clip: N frames over a duration, returned as an
 *              animated GIF (for humans) plus a contact sheet (for the model)
 *   selfcheck  real smoke test of the capture + encode chain, recorded in state.json
 *   update     pull a newer copy from a GitHub repository or a local source directory,
 *              validate it, roll back on failure
 *
 * Design constraints behind the shape of this plugin:
 *   - zero third-party runtime dependencies: PowerShell 5.1 + Node built-ins only,
 *     so there is no binary to break after an upgrade and no npm supply chain;
 *   - every artefact lands on the D: drive (workDir defaults inside DSH_HOME);
 *   - the engine is a persistent host, restarted at most 3 times per 10 minutes;
 *   - all state needed to keep it healthy lives in `<workDir>/state.json`.
 *
 * @module @local/dsh-my-eyes
 */
import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { EyeEngine, reapOrphanEngines } from './tools/engine.mjs'
import { readBmp24 } from './tools/bmp.mjs'
import { writeGif } from './tools/gif.mjs'
import { writeContactSheet } from './tools/sheet.mjs'
import { fetchGitHubSource, maskSecret, parseSourceSpec, readJsonFile, versionOfSource } from './tools/github.mjs'

export const name = 'my-eyes'
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_MAX_WIDTH = 1280
const DEFAULT_CLIP_WIDTH = 720
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
const SHEET_FRAME_CAP = 12

function readOwnVersion() {
  try {
    return readJsonFile(join(HERE, 'package.json')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? 'C:\\', '.dsh')
  const workDir = typeof src.workDir === 'string' && src.workDir.trim() !== ''
    ? (isAbsolute(src.workDir) ? src.workDir : resolve(src.workDir))
    : join(dshHome, 'eyes')
  return {
    workDir,
    scriptPath: typeof src.scriptPath === 'string' && src.scriptPath.trim() !== ''
      ? resolve(src.scriptPath)
      : join(HERE, 'eyes.ps1'),
    defaultMaxWidth: Number.isFinite(src.defaultMaxWidth) ? src.defaultMaxWidth : DEFAULT_MAX_WIDTH,
    clipMaxWidth: Number.isFinite(src.clipMaxWidth) ? src.clipMaxWidth : DEFAULT_CLIP_WIDTH,
    maxRestarts: Number.isFinite(src.maxRestarts) ? src.maxRestarts : 3,
    restartWindowMs: Number.isFinite(src.restartWindowMs) ? src.restartWindowMs : 10 * 60 * 1000,
    callTimeoutMs: Number.isFinite(src.callTimeoutMs) ? src.callTimeoutMs : 120000,
    keepClips: Number.isFinite(src.keepClips) ? src.keepClips : 30,
    // A GitHub source is kept verbatim (it is a spec, not a path); a local source is
    // resolved relative to the current working directory.
    updateSource: typeof src.updateSource === 'string' && src.updateSource.trim() !== ''
      ? src.updateSource.trim()
      : join(HERE, 'updates', 'latest'),
    updateCache: typeof src.updateCache === 'string' && src.updateCache.trim() !== ''
      ? (isAbsolute(src.updateCache) ? src.updateCache : resolve(src.updateCache))
      : join(workDir, 'update-cache'),
    githubToken: typeof src.githubToken === 'string' && src.githubToken.trim() !== ''
      ? src.githubToken.trim()
      : (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''),
    gitPath: typeof src.gitPath === 'string' && src.gitPath.trim() !== '' ? src.gitPath.trim() : 'git',
  }
}

/* --------------------------------------------------------------- state file */

class StateStore {
  constructor(dir) {
    this.dir = dir
    this.path = join(dir, 'state.json')
    this.data = this.#load()
  }

  #load() {
    const empty = { version: 1, createdAt: new Date().toISOString(), runs: 0, checks: [], clips: 0, errors: 0, updates: [] }
    try {
      if (!existsSync(this.path)) return empty
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      return { ...empty, ...parsed }
    } catch {
      return empty
    }
  }

  get() {
    return this.data
  }

  recordCheck(entry) {
    this.data.checks = [...(this.data.checks ?? []), entry].slice(-40)
    if (entry.ok !== true) this.data.errors = (this.data.errors ?? 0) + 1
    this.flush()
  }

  recordClip(entry) {
    this.data.clips = (this.data.clips ?? 0) + 1
    this.data.lastClip = entry
    this.flush()
  }

  recordError(message) {
    this.data.errors = (this.data.errors ?? 0) + 1
    this.data.lastError = { at: new Date().toISOString(), message: String(message).slice(0, 500) }
    this.flush()
  }

  recordUpdate(entry) {
    this.data.updates = [...(this.data.updates ?? []), entry].slice(-20)
    this.flush()
  }

  flush() {
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    } catch { /* state is diagnostics only; never fail a call for it */ }
  }
}

/* ------------------------------------------------------------------ helpers */

function stamp() {
  const d = new Date()
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`
}

function pruneClips(dir, keep) {
  try {
    if (!existsSync(dir)) return 0
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^(watch|capture|selfcheck)-/.test(entry.name))
      .map((entry) => ({ name: entry.name, at: statSync(join(dir, entry.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    let removed = 0
    for (const entry of entries.slice(keep)) {
      rmSync(join(dir, entry.name), { recursive: true, force: true })
      removed += 1
    }
    return removed
  } catch {
    return 0
  }
}

function pickSheetFrames(frames, cap = SHEET_FRAME_CAP) {
  if (frames.length <= cap) return frames
  const picked = []
  for (let i = 0; i < cap; i += 1) picked.push(frames[Math.round((i * (frames.length - 1)) / (cap - 1))])
  return picked
}

function summarize(value, maxLength = 8000) {
  let text
  try { text = JSON.stringify(value, null, 2) } catch { text = String(value) }
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}\n… (truncated)`
  return text
}

/**
 * Copy a fixed file list from `source` into `target`, recursively for directories.
 *
 * Snapshot-then-write, and never "clear the target then walk the source": when the
 * two roots resolve to the same directory (an in-place update or a rehearsal) a
 * clear-first loop reads its own emptied directory and silently drops files.
 * Files already identical by real path are skipped instead.
 */
function copyTree(source, target, files) {
  mkdirSync(target, { recursive: true })
  const copied = []
  const staged = []
  for (const entry of files) {
    const from = join(source, entry)
    if (!existsSync(from)) continue
    const stat = statSync(from)
    if (stat.isDirectory()) {
      const nested = copyTree(from, join(target, entry), readdirSync(from))
      copied.push(...nested.map((item) => `${entry}/${item}`))
    } else {
      staged.push({ entry, from, data: readFileSync(from) })
    }
  }
  for (const item of staged) {
    const destination = join(target, item.entry)
    if (resolve(destination) === resolve(item.from)) {
      copied.push(item.entry)
      continue
    }
    if (existsSync(destination) && readFileSync(destination).equals(item.data)) {
      copied.push(item.entry)
      continue
    }
    writeFileSync(destination, item.data)
    copied.push(item.entry)
  }
  return copied
}

/* -------------------------------------------------------------------- apply */

export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  mkdirSync(settings.workDir, { recursive: true })
  const state = new StateStore(settings.workDir)
  const version = readOwnVersion()

  const engine = new EyeEngine({
    scriptPath: settings.scriptPath,
    callTimeoutMs: settings.callTimeoutMs,
    maxRestarts: settings.maxRestarts,
    restartWindowMs: settings.restartWindowMs,
    logger: ctx.logger,
  })
  // Collect hosts left by an earlier process of this plugin before starting ours,
  // and never leave one behind when this process exits.
  const reaped = reapOrphanEngines()
  if (reaped.killed > 0) ctx.logger?.info?.(`[my-eyes] reaped ${reaped.killed} orphaned capture engine(s)`)
  const shutdown = () => engine.kill()
  process.once('exit', shutdown)
  ctx.effect(() => () => {
    process.removeListener('exit', shutdown)
    engine.kill()
  })

  if (typeof ctx.systemPrompt?.section === 'function') {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'my-eyes',
      order: 118,
      text: [
        '### 我的眼睛 (eyes)',
        '',
        'You have your own eyes on this Windows desktop through the `eyes` tool. Use them instead of asking the user to describe their screen, and instead of guessing.',
        '`eyes { action: "look" }` returns a screenshot as an image block plus its path. Add `target: "window"` with `windowId`/`window` to see one window (occluded windows still render themselves), or `monitor`, `x`, `y`, `width`, `height` for a region.',
        '`eyes { action: "watch", durationMs }` records motion and returns an animated GIF plus a contact sheet; use it for transitions, video, animations and anything where one still is ambiguous. Describe what changed between frames, not just the last frame.',
        'Screenshots are of the real desktop and can contain private data: look only at what the task needs, never transcribe secrets, and say what you saw rather than what you expected.',
      ].join('\n'),
    }))
  }

  async function attach(ctx, path, mediaType = 'image/png') {
    try {
      const attachments = ctx.get('attachments')
      if (!attachments || typeof attachments.saveImage !== 'function') return []
      if (!existsSync(path)) return []
      const size = statSync(path).size
      if (size === 0 || size > MAX_ATTACHMENT_BYTES) return []
      const ref = await attachments.saveImage({
        data: readFileSync(path),
        mediaType,
        name: path.split(/[\\/]/).pop() ?? 'eyes.png',
      })
      return [{ type: 'image', attachment: ref }]
    } catch (error) {
      state.recordError(`attach failed: ${String(error)}`)
      return []
    }
  }

  function imageResult(text, images) {
    return { ok: true, __images: { text, blocks: images } }
  }

  function readFrames(frames) {
    return frames.map((frame) => {
      const decoded = readBmp24(frame.file)
      return { ...decoded, atMs: frame.atMs, file: frame.file }
    })
  }

  const tool = defineTool({
    name: 'eyes',
    description:
      'See this Windows desktop. Actions: info (engine/screen/foreground state), look (snapshot of the desktop, a monitor, a region, or one window; returned as an image plus path), windows (visible windows with id/title/process/bounds so a window can be targeted), watch (record a short clip: frames + animated GIF for humans + contact sheet for you), selfcheck (real smoke test, recorded), update (self-update from a GitHub repository — github:owner/repo[@ref] — or a local source directory). Use look before describing a screen, and watch when motion matters.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['info', 'look', 'windows', 'watch', 'selfcheck', 'update'],
        description: 'Which eye operation to perform.',
      },
      target: {
        type: 'string',
        enum: ['screen', 'window'],
        description: 'look/watch: "screen" (default) captures the desktop; "window" captures one window via PrintWindow.',
      },
      window: { type: 'string', description: 'Window title, exact first then substring, for target "window".' },
      windowId: { type: 'number', description: 'Window handle from action "windows".' },
      pid: { type: 'number', description: 'Target window by owning process id.' },
      process: { type: 'string', description: 'Target window by process name (e.g. chrome); also filters action "windows".' },
      monitor: { type: 'number', description: 'Monitor index from action "info" (0-based); omit for the whole virtual desktop.' },
      title: { type: 'string', description: 'action "windows": title filter.' },
      x: { type: 'number', description: 'Region left edge in physical pixels.' },
      y: { type: 'number', description: 'Region top edge in physical pixels.' },
      width: { type: 'number', description: 'Region width in physical pixels.' },
      height: { type: 'number', description: 'Region height in physical pixels.' },
      maxWidth: { type: 'number', description: 'Downscale so the image is at most this wide (look default 1280, watch default 720).' },
      scale: { type: 'number', description: 'Downscale factor in (0,1]; overrides maxWidth.' },
      durationMs: { type: 'number', description: 'watch: clip length in ms (default 4000, max 60000).' },
      fps: { type: 'number', description: 'watch: frames per second (default 3, max 10).' },
      maxFrames: { type: 'number', description: 'watch: hard frame cap (default 40).' },
      gif: { type: 'boolean', description: 'watch: write the animated GIF (default true).' },
      frames: { type: 'boolean', description: 'watch: expose per-frame paths for later read_image calls (default false).' },
      source: {
        type: 'string',
        description: 'update: "github:owner/repo", "github:owner/repo@v1.2.0", "https://github.com/owner/repo", or a local directory holding a newer copy; defaults to config.updateSource.',
      },
      ref: { type: 'string', description: 'update: branch, tag or commit when source is a GitHub repository (default: the repository default branch).' },
      keep: { type: 'number', description: 'watch: how many recent clip directories to keep (default 30).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => {
        if (value && value.__images) return [{ type: 'text', text: value.__images.text }, ...value.__images.blocks]
        return [{ type: 'text', text: summarize(value) }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = String(args.action)
      state.data.runs = (state.data.runs ?? 0) + 1
      try {
        switch (action) {
          case 'info': {
            const info = await engine.request({ action: 'info' })
            return {
              ...info,
              plugin: { name: '@local/dsh-my-eyes', version, workDir: settings.workDir, stateFile: state.path },
              update: {
                source: settings.updateSource,
                cache: settings.updateCache,
                channel: /^(?:github:|https?:\/\/(?:www\.)?github\.com\/|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$)/i.test(settings.updateSource) ? 'github' : 'local',
                credential: settings.githubToken ? 'GITHUB_TOKEN' : 'none',
              },
              engineRuntime: engine.stats,
              history: {
                runs: state.get().runs,
                clips: state.get().clips ?? 0,
                errors: state.get().errors ?? 0,
                lastError: state.get().lastError,
                lastUpdate: (state.get().updates ?? []).slice(-1)[0],
              },
            }
          }

          case 'look': {
            const maxWidth = args.maxWidth ?? settings.defaultMaxWidth
            const lookDir = join(settings.workDir, `capture-${stamp()}`)
            const result = await engine.request({
              action: 'capture',
              target: args.target ?? 'screen',
              window: args.window,
              windowId: args.windowId,
              pid: args.pid,
              process: args.process,
              monitor: args.monitor,
              x: args.x,
              y: args.y,
              width: args.width,
              height: args.height,
              maxWidth,
              scale: args.scale,
              dir: lookDir,
            })
            if (!result?.ok) throw new Error(result?.error ?? 'capture failed')
            const blocks = await attach(ctx, result.image, 'image/png')
            const visible = args.target === 'window' && result.window
              ? `window "${result.window.title}" (${result.window.process})`
              : `desktop region x=${result.x} y=${result.y} ${result.sourceWidth}x${result.sourceHeight}`
            const text = [
              `<path>${result.image}</path>`,
              '<type>image</type>',
              '<content>',
              `我的眼睛 snapshot: ${visible}, delivered ${result.width}x${result.height} px`,
              result.window ? `window bounds x=${result.window.x} y=${result.window.y} ${result.window.width}x${result.window.height}; captured by the window itself (occluded content included)` : undefined,
              result.foreground ? `foreground: "${result.foreground.title}"` : undefined,
              'Coordinates in this image are physical screen pixels scaled by the stated factor; click targets must be mapped back before use.',
              '</content>',
            ].filter(Boolean).join('\n')
            if (blocks.length > 0) return imageResult(text, blocks)
            return { ...result, note: 'image could not be attached; call read_image on the path' }
          }

          case 'windows': {
            const result = await engine.request({ action: 'windows', title: args.title, process: args.process })
            if (!result?.ok) throw new Error(result?.error ?? 'window enumeration failed')
            return result
          }

          case 'watch': {
            const durationMs = Math.max(200, Math.min(60000, args.durationMs ?? 4000))
            const fps = Math.max(0.2, Math.min(10, args.fps ?? 3))
            const clipDir = join(settings.workDir, `watch-${stamp()}`)
            const captured = await engine.request({
              action: 'frames',
              target: args.target ?? 'screen',
              window: args.window,
              windowId: args.windowId,
              pid: args.pid,
              process: args.process,
              monitor: args.monitor,
              x: args.x,
              y: args.y,
              width: args.width,
              height: args.height,
              maxWidth: args.maxWidth ?? settings.clipMaxWidth,
              scale: args.scale,
              durationMs,
              fps,
              maxFrames: Math.max(2, Math.min(60, args.maxFrames ?? 40)),
              dir: clipDir,
            })
            if (!captured?.ok) throw new Error(captured?.error ?? 'frame capture failed')
            if (!Array.isArray(captured.frames) || captured.frames.length === 0) {
              throw new Error(`no frames captured${captured.errors?.length ? `: ${captured.errors.join('; ')}` : ''}`)
            }
            pruneClips(settings.workDir, Math.max(1, args.keep ?? settings.keepClips))

            const decoded = readFrames(captured.frames)
            const frameDelay = decoded.length > 1
              ? Math.max(40, Math.round((decoded[decoded.length - 1].atMs - decoded[0].atMs) / (decoded.length - 1)))
              : Math.round(1000 / fps)

            const gifPath = join(clipDir, 'clip.gif')
            const wantGif = args.gif !== false
            const gif = wantGif
              ? writeGif(gifPath, decoded.map((frame) => ({ data: frame.data, width: frame.width, height: frame.height, delayMs: frameDelay })))
              : undefined

            const sheetPath = join(clipDir, 'contact-sheet.png')
            const sheet = writeContactSheet(pickSheetFrames(decoded), {
              path: sheetPath,
              tileWidth: 340,
              title: `我的眼睛  ${decoded.length} frames / ${(captured.actualMs / 1000).toFixed(1)}s @ ${fps}fps`,
            })

            const blocks = await attach(ctx, sheet.path, 'image/png')
            const text = [
              `<path>${sheet.path}</path>`,
              '<type>image</type>',
              '<content>',
              `我的眼睛 clip: ${decoded.length} frames over ${(captured.actualMs / 1000).toFixed(1)}s at ~${fps} fps, ${decoded[0].width}x${decoded[0].height} px each, frame delay ${frameDelay} ms`,
              `contact sheet: ${sheet.width}x${sheet.height} px, ${sheet.columns}x${sheet.rows} tiles sampled evenly from the clip`,
              gif ? `animated GIF: ${gif.path} (${Math.round(gif.bytes / 1024)} KB, loops forever) — the user can open it to watch the motion` : undefined,
              args.frames === true ? `frame files: ${decoded.map((frame) => frame.file).join(', ')}` : 'pass frames: true to get per-frame paths for read_image',
              '</content>',
            ].filter(Boolean).join('\n')

            state.recordClip({ at: new Date().toISOString(), frames: decoded.length, ms: captured.actualMs, dir: clipDir })
            if (blocks.length > 0) {
              return imageResult(text, blocks)
            }
            return {
              ok: true,
              action: 'watch',
              dir: clipDir,
              frames: decoded.length,
              gif: gif?.path,
              contactSheet: sheet.path,
              note: 'contact sheet could not be attached; read_image the contactSheet path',
            }
          }

          case 'selfcheck': {
            const steps = []
            const runStep = async (label, fn) => {
              const started = Date.now()
              try {
                const detail = await fn()
                steps.push({ step: label, ok: true, ms: Date.now() - started, detail })
              } catch (error) {
                steps.push({ step: label, ok: false, ms: Date.now() - started, error: String(error).slice(0, 300) })
              }
            }
            await runStep('engine', async () => {
              const info = await engine.request({ action: 'info' })
              if (!info?.ok) throw new Error(info?.error ?? 'engine refused info')
              return { engineVersion: info.engineVersion, screen: info.screen?.virtual, monitors: info.screen?.monitorCount, workingSetMB: info.workingSetMB }
            })
            await runStep('capture', async () => {
              const shot = await engine.request({ action: 'capture', maxWidth: 640 })
              if (!shot?.ok) throw new Error(shot?.error ?? 'capture refused')
              readBmp24(shot.image)
              rmSync(dirname(shot.image), { recursive: true, force: true })
              return { px: `${shot.width}x${shot.height}` }
            })
            await runStep('clip', async () => {
              const dir = join(settings.workDir, `selfcheck-${stamp()}`)
              const captured = await engine.request({ action: 'frames', maxWidth: 480, durationMs: 700, fps: 3, dir })
              if (!captured?.ok || captured.frameCount < 2) throw new Error(`clip produced ${captured?.frameCount ?? 0} frames`)
              const decoded = readFrames(captured.frames)
              const gif = writeGif(join(dir, 'clip.gif'), decoded.map((frame) => ({ data: frame.data, width: frame.width, height: frame.height, delayMs: 200 })))
              const sheet = writeContactSheet(decoded, { path: join(dir, 'contact-sheet.png'), tileWidth: 240 })
              rmSync(dir, { recursive: true, force: true })
              return { frames: decoded.length, gifKB: Math.round(gif.bytes / 1024), sheet: `${sheet.width}x${sheet.height}` }
            })
            const ok = steps.every((step) => step.ok)
            const entry = { at: new Date().toISOString(), ok, version, steps }
            state.recordCheck(entry)
            return { ok, action: 'selfcheck', version, steps, stateFile: state.path }
          }

          case 'update': {
            let spec
            try {
              spec = parseSourceSpec(args.source ?? settings.updateSource)
            } catch (error) {
              return { ok: false, action: 'update', status: 'bad-source', message: String(error.message ?? error), installed: version }
            }

            let source
            let channel
            if (spec.kind === 'github') {
              const ref = args.ref ?? spec.ref
              try {
                channel = await fetchGitHubSource({
                  repo: spec.repo,
                  ref,
                  cacheDir: settings.updateCache,
                  token: settings.githubToken,
                  gitPath: settings.gitPath,
                  logger: ctx.logger,
                })
              } catch (error) {
                const message = maskSecret(error.message ?? String(error), settings.githubToken)
                state.recordError(`update fetch failed: ${message}`)
                return {
                  ok: false,
                  action: 'update',
                  status: 'fetch-failed',
                  repo: spec.repo,
                  ref,
                  message,
                  hint: 'private repositories need GITHUB_TOKEN (or config.githubToken); public ones need no credentials',
                  installed: version,
                }
              }
              source = channel.path
            } else {
              source = spec.path
              channel = { path: source, method: 'local' }
            }

            if (resolve(source) === resolve(HERE)) {
              return { ok: true, action: 'update', status: 'not-applicable', message: 'source and installed copy are the same directory', source, installed: version }
            }
            if (!existsSync(join(source, 'package.json'))) {
              return { ok: false, action: 'update', status: 'no-source', message: `no update source at ${source}; set config.updateSource or pass source`, source, installed: version }
            }
            let remote
            try {
              remote = versionOfSource(source)
            } catch (error) {
              return { ok: false, action: 'update', status: 'invalid-package', message: String(error.message ?? error), source, installed: version }
            }            const comparable = (v) => String(v).split(/[.-]/).map((part) => Number(part)).filter((n) => Number.isFinite(n))
            const cmp = (a, b) => {
              const x = comparable(a)
              const y = comparable(b)
              for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
                const d = (x[i] ?? 0) - (y[i] ?? 0)
                if (d !== 0) return d
              }
              return 0
            }
            const origin = spec.kind === 'github'
              ? { repo: spec.repo, ref: args.ref ?? spec.ref, commit: channel.commit, fetched: channel.method, cache: settings.updateCache }
              : undefined
            if (cmp(remote.version, version) <= 0) {
              return { ok: true, action: 'update', status: 'current', installed: version, available: remote.version, source, origin }
            }
            const backup = join(settings.workDir, `backup-${version}-${stamp()}`)
            copyTree(HERE, backup, ['index.js', 'eyes.ps1', 'tools', 'package.json', 'cordis.patch.yml', 'VERSION', 'README.md', 'locale', 'scripts', 'icon.svg'])
            let copied
            try {
              copied = copyTree(source, HERE, ['index.js', 'eyes.ps1', 'tools', 'package.json', 'cordis.patch.yml', 'VERSION', 'README.md', 'locale', 'scripts', 'icon.svg'])
            } catch (error) {
              copyTree(backup, HERE, ['index.js', 'eyes.ps1', 'tools', 'package.json', 'cordis.patch.yml'])
              state.recordUpdate({ at: new Date().toISOString(), ok: false, from: version, to: remote.version, origin, error: String(error) })
              throw new Error(`copy failed, restored ${version}: ${String(error)}`)
            }
            const verify = await new Promise((resolvePromise) => {
              const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'eyes.ps1')], { windowsHide: true })
              let out = ''
              child.stdout?.on('data', (chunk) => { out += chunk })
              child.on('exit', () => resolvePromise(out.trim()))
              setTimeout(() => { try { child.kill() } catch { /* ignore */ } resolvePromise('timeout') }, 15000)
            })
            const healthy = verify.includes('missing request JSON path')
            if (!healthy) {
              copyTree(backup, HERE, ['index.js', 'eyes.ps1', 'tools', 'package.json', 'cordis.patch.yml'])
              state.recordUpdate({ at: new Date().toISOString(), ok: false, from: version, to: remote.version, origin, verify })
              return { ok: false, action: 'update', status: 'rolled-back', from: version, attempted: remote.version, verify: verify.slice(0, 300), backup, origin }
            }
            state.recordUpdate({ at: new Date().toISOString(), ok: true, from: version, to: remote.version, origin, files: copied.length })
            return {
              ok: true,
              action: 'update',
              status: 'updated',
              from: version,
              to: remote.version,
              files: copied.length,
              backup,
              origin,
              note: 'restart DeepSeek Harness (or open a new session after reloading) so the new code is loaded',
            }
          }

          default:
            throw new Error(`unknown action "${action}"`)
        }
      } catch (error) {
        state.recordError(error?.message ?? String(error))
        throw error
      }
    },
  })

  ctx.tools.register(tool)
}
