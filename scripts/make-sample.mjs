// Produce reviewable artefacts (frames, GIF, contact sheet, PNG) for visual inspection.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { EyeEngine } from '../tools/engine.mjs'
import { readBmp24 } from '../tools/bmp.mjs'
import { writeGif } from '../tools/gif.mjs'
import { writeContactSheet } from '../tools/sheet.mjs'

const out = process.argv[2]
mkdirSync(out, { recursive: true })
const engine = new EyeEngine({ scriptPath: process.argv[3] })
await engine.ensure()
const clip = await engine.request({ action: 'frames', maxWidth: 640, durationMs: 2500, fps: 4, dir: join(out, 'clip') })
console.log('frames', clip.frameCount, clip.actualMs, clip.errors)
const decoded = clip.frames.map((frame) => ({ ...readBmp24(frame.file), atMs: frame.atMs, file: frame.file }))
const delay = Math.max(40, Math.round((decoded.at(-1).atMs - decoded[0].atMs) / Math.max(1, decoded.length - 1)))
const gif = writeGif(join(out, 'clip', 'clip.gif'), decoded.map((frame) => ({ data: frame.data, width: frame.width, height: frame.height, delayMs: delay })))
const sheet = writeContactSheet(decoded.slice(0, 8), { path: join(out, 'clip', 'contact-sheet.png'), tileWidth: 420, title: '我的眼睛 sample' })
console.log('gif', gif.path, gif.bytes, 'sheet', sheet.path, sheet.width, sheet.height)
engine.kill()
