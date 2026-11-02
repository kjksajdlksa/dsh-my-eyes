#!/usr/bin/env node
/**
 * Standalone smoke test for 我的眼睛 (My Eyes).
 *
 * This runs the same code path as the agent tool — PowerShell engine, BMP decode,
 * GIF encode, contact sheet — without needing DeepSeek Harness, so the plugin can
 * be verified from a terminal after any change or update:
 *
 *   node scripts/selfcheck.mjs [workDir]
 *
 * Exit code 0 means every stage produced usable output; anything else means the
 * failing stage is printed and the artefact directory is kept for inspection.
 */
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EyeEngine } from '../tools/engine.mjs'
import { readBmp24 } from '../tools/bmp.mjs'
import { writeGif } from '../tools/gif.mjs'
import { writeContactSheet } from '../tools/sheet.mjs'

const HERE = dirname(dirname(fileURLToPath(import.meta.url)))
const workDir = resolve(process.argv[2] ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'eyes'))
const runDir = join(workDir, `selfcheck-${Date.now()}`)
mkdirSync(runDir, { recursive: true })

const results = []
let failed = false

async function stage(label, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    results.push({ label, ok: true, ms: Date.now() - started, detail })
    console.log(`  ok   ${label} (${Date.now() - started} ms) ${detail ? JSON.stringify(detail) : ''}`)
  } catch (error) {
    failed = true
    results.push({ label, ok: false, ms: Date.now() - started, error: String(error) })
    console.error(`  FAIL ${label} (${Date.now() - started} ms): ${String(error)}`)
  }
}

console.log(`我的眼睛 selfcheck — engine ${join(HERE, 'eyes.ps1')}`)
console.log(`artefacts ${runDir}`)

const engine = new EyeEngine({ scriptPath: join(HERE, 'eyes.ps1') })

await stage('engine.start', async () => {
  await engine.ensure()
  return { pid: engine.child?.pid }
})

await stage('engine.info', async () => {
  const info = await engine.request({ action: 'info' })
  if (!info?.ok) throw new Error(info?.error ?? 'info refused')
  return {
    engineVersion: info.engineVersion,
    screen: info.screen?.virtual,
    monitors: info.screen?.monitorCount,
    windows: info.windowCount,
    workingSetMB: info.workingSetMB,
  }
})

await stage('windows', async () => {
  const list = await engine.request({ action: 'windows' })
  if (!list?.ok) throw new Error(list?.error ?? 'windows refused')
  return { count: list.count, top: list.windows.slice(0, 3).map((w) => `${w.process}: ${w.title.slice(0, 40)}`) }
})

await stage('capture', async () => {
  const shot = await engine.request({ action: 'capture', maxWidth: 640, dir: join(runDir, 'shot') })
  if (!shot?.ok) throw new Error(shot?.error ?? 'capture refused')
  const decoded = readBmp24(shot.image)
  if (decoded.width !== shot.width || decoded.height !== shot.height) throw new Error('BMP dimensions disagree with capture metadata')
  return { px: `${decoded.width}x${decoded.height}`, bytes: statSync(shot.image).size }
})

await stage('clip.frames', async () => {
  const clipDir = join(runDir, 'clip')
  const captured = await engine.request({ action: 'frames', maxWidth: 480, durationMs: 1500, fps: 3, dir: clipDir })
  if (!captured?.ok) throw new Error(captured?.error ?? 'frames refused')
  if ((captured.frameCount ?? 0) < 2) throw new Error(`only ${captured.frameCount ?? 0} frames`)
  const decoded = captured.frames.map((frame) => ({ ...readBmp24(frame.file), atMs: frame.atMs, file: frame.file }))
  const delay = Math.max(40, Math.round((decoded.at(-1).atMs - decoded[0].atMs) / Math.max(1, decoded.length - 1)))
  const gif = writeGif(join(clipDir, 'clip.gif'), decoded.map((frame) => ({ data: frame.data, width: frame.width, height: frame.height, delayMs: delay })))
  const sheet = writeContactSheet(decoded.slice(0, 6), { path: join(clipDir, 'contact-sheet.png'), tileWidth: 300 })
  if (gif.bytes < 100) throw new Error('gif suspiciously small: ' + gif.bytes)
  return { frames: decoded.length, delayMs: delay, gifKB: Math.round(gif.bytes / 1024), sheet: `${sheet.width}x${sheet.height}`, clipDir }
})

await stage('cleanup', async () => {
  const result = await engine.request({ action: 'cleanup', keep: 20 })
  engine.kill()
  return result
})

engine.kill()

const summary = { ok: !failed, version: JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version, runDir, results }
await (await import('node:fs/promises')).writeFile(join(runDir, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
console.log(failed ? `\nFAILED — see ${join(runDir, 'result.json')}` : `\nPASSED — ${join(runDir, 'result.json')}`)
// Keep result.json as evidence; drop the frames so repeated checks do not pile up.
for (const dir of ['shot', 'clip']) rmSync(join(runDir, dir), { recursive: true, force: true })
process.exit(failed ? 1 : 0)
