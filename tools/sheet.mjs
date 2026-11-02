/**
 * Contact-sheet compositor: many recorded frames in one still image.
 *
 * A text-only or single-image model sees one picture per tool result, so a
 * recording is only understandable if the motion is collapsed into a grid the
 * model can read in one look: frame index, timestamp, and a caption bar per tile,
 * sampled evenly across the clip.
 *
 * @module @local/dsh-my-eyes/sheet
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

/* ------------------------------------------------------------------- PNG out */

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'latin1')
  const crcInput = Buffer.concat([typeBuffer, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcInput) >>> 0, 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Write an RGB888 buffer as a PNG.
 * @param {string} path
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgb tightly packed, top-down
 */
export function writePng(path, width, height, rgb) {
  const stride = width * 3
  const raw = Buffer.allocUnsafe((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: truecolour
  header[10] = 0
  header[11] = 0
  header[12] = 0
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  writeFileSync(path, png)
  return png.length
}

/* --------------------------------------------------------------- tiny 5x7 font */

// Each glyph is 5 columns x 7 rows, one byte per column, bit 0 = top row.
const FONT = {
  '0': [0x3e, 0x51, 0x49, 0x45, 0x3e], '1': [0x00, 0x42, 0x7f, 0x40, 0x00],
  '2': [0x42, 0x61, 0x51, 0x49, 0x46], '3': [0x21, 0x41, 0x45, 0x4b, 0x31],
  '4': [0x18, 0x14, 0x12, 0x7f, 0x10], '5': [0x27, 0x45, 0x45, 0x45, 0x39],
  '6': [0x3c, 0x4a, 0x49, 0x49, 0x30], '7': [0x01, 0x71, 0x09, 0x05, 0x03],
  '8': [0x36, 0x49, 0x49, 0x49, 0x36], '9': [0x06, 0x49, 0x49, 0x29, 0x1e],
  A: [0x7e, 0x11, 0x11, 0x11, 0x7e], B: [0x7f, 0x49, 0x49, 0x49, 0x36],
  C: [0x3e, 0x41, 0x41, 0x41, 0x22], D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
  E: [0x7f, 0x49, 0x49, 0x49, 0x41], F: [0x7f, 0x09, 0x09, 0x09, 0x01],
  G: [0x3e, 0x41, 0x49, 0x49, 0x7a], H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
  I: [0x00, 0x41, 0x7f, 0x41, 0x00], J: [0x20, 0x40, 0x41, 0x3f, 0x01],
  K: [0x7f, 0x08, 0x14, 0x22, 0x41], L: [0x7f, 0x40, 0x40, 0x40, 0x40],
  M: [0x7f, 0x02, 0x0c, 0x02, 0x7f], N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
  O: [0x3e, 0x41, 0x41, 0x41, 0x3e], P: [0x7f, 0x09, 0x09, 0x09, 0x06],
  Q: [0x3e, 0x41, 0x51, 0x21, 0x5e], R: [0x7f, 0x09, 0x19, 0x29, 0x46],
  S: [0x46, 0x49, 0x49, 0x49, 0x31], T: [0x01, 0x01, 0x7f, 0x01, 0x01],
  U: [0x3f, 0x40, 0x40, 0x40, 0x3f], V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
  W: [0x3f, 0x40, 0x38, 0x40, 0x3f], X: [0x63, 0x14, 0x08, 0x14, 0x63],
  Y: [0x07, 0x08, 0x70, 0x08, 0x07], Z: [0x61, 0x51, 0x49, 0x45, 0x43],
  ' ': [0, 0, 0, 0, 0], ':': [0x00, 0x36, 0x36, 0x00, 0x00], '.': [0x00, 0x60, 0x60, 0x00, 0x00],
  '-': [0x08, 0x08, 0x08, 0x08, 0x08], '/': [0x20, 0x10, 0x08, 0x04, 0x02],
  '+': [0x08, 0x08, 0x3e, 0x08, 0x08], '#': [0x14, 0x7f, 0x14, 0x7f, 0x14],
  '?': [0x02, 0x01, 0x51, 0x09, 0x06], '%': [0x62, 0x64, 0x08, 0x13, 0x23],
}

function drawGlyph(target, width, x, y, scale, char, color) {
  const glyph = FONT[char] || FONT['?']
  for (let col = 0; col < 5; col += 1) {
    const bits = glyph[col]
    for (let row = 0; row < 7; row += 1) {
      if ((bits >> row) & 1) {
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const px = x + col * scale + sx
            const py = y + row * scale + sy
            if (px < 0 || py < 0 || px >= width) continue
            const offset = (py * width + px) * 3
            target[offset] = color[0]
            target[offset + 1] = color[1]
            target[offset + 2] = color[2]
          }
        }
      }
    }
  }
}

function drawText(target, width, x, y, scale, text, color = [235, 235, 240]) {
  let cursor = x
  for (const char of String(text)) {
    drawGlyph(target, width, cursor, y, scale, char, color)
    cursor += 6 * scale
  }
  return cursor
}

function fillRect(target, width, x0, y0, w, h, color) {
  const x1 = Math.min(width, x0 + w)
  for (let y = Math.max(0, y0); y < y0 + h; y += 1) {
    for (let x = Math.max(0, x0); x < x1; x += 1) {
      const offset = (y * width + x) * 3
      target[offset] = color[0]
      target[offset + 1] = color[1]
      target[offset + 2] = color[2]
    }
  }
}

/** Box-filter downscale of an RGB frame into a target rect. */
function blitScaled(target, targetWidth, frame, rect) {
  const { width: fw, height: fh, data } = frame
  const { x: dx, y: dy, width: dw, height: dh } = rect
  const sx = fw / dw
  const sy = fh / dh
  for (let y = 0; y < dh; y += 1) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.max(y0 + 1, Math.min(fh, Math.floor((y + 1) * sy)))
    for (let x = 0; x < dw; x += 1) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.min(fw, Math.floor((x + 1) * sx)))
      let r = 0
      let g = 0
      let b = 0
      let count = 0
      for (let fy = y0; fy < y1; fy += 1) {
        let offset = (fy * fw + x0) * 3
        for (let fx = x0; fx < x1; fx += 1) {
          r += data[offset]
          g += data[offset + 1]
          b += data[offset + 2]
          offset += 3
          count += 1
        }
      }
      const out = ((dy + y) * targetWidth + (dx + x)) * 3
      target[out] = r / count
      target[out + 1] = g / count
      target[out + 2] = b / count
    }
  }
}

/**
 * Compose sampled frames into one contact sheet.
 * @param {Array<{ data: Buffer, width: number, height: number, atMs?: number }>} frames evenly sampled frames
 * @param {{ tileWidth?: number, columns?: number, path?: string, title?: string }} [options]
 * @returns {{ path: string, width: number, height: number, bytes: number, columns: number, rows: number }}
 */
export function writeContactSheet(frames, options = {}) {
  if (frames.length === 0) throw new Error('contact sheet needs at least one frame')
  const tileWidth = Math.max(160, Math.min(480, options.tileWidth ?? 360))
  const columns = Math.max(1, Math.min(frames.length, options.columns ?? (frames.length <= 4 ? 2 : frames.length <= 9 ? 3 : 4)))
  const rows = Math.ceil(frames.length / columns)
  const pad = 10
  const captionHeight = 16
  const first = frames[0]
  const aspect = first.height / first.width
  const tileHeight = Math.round(tileWidth * aspect)
  const headerHeight = options.title ? 22 : 0
  const width = pad + columns * (tileWidth + pad)
  const height = headerHeight + pad + rows * (tileHeight + captionHeight + pad)
  const canvas = Buffer.alloc(width * height * 3, 24)

  if (options.title) drawText(canvas, width, pad, 6, 2, options.title, [200, 210, 255])

  const sheetFrames = frames.slice(0, columns * rows)
  for (let i = 0; i < sheetFrames.length; i += 1) {
    const col = i % columns
    const row = Math.floor(i / columns)
    const x = pad + col * (tileWidth + pad)
    const y = headerHeight + pad + row * (tileHeight + captionHeight + pad)
    blitScaled(canvas, width, sheetFrames[i], { x, y, width: tileWidth, height: tileHeight })
    fillRect(canvas, width, x, y + tileHeight, tileWidth, captionHeight, [18, 18, 26])
    fillRect(canvas, width, x, y + tileHeight, tileWidth, 1, [70, 70, 96])
    const stamp = typeof sheetFrames[i].atMs === 'number' ? `  +${(sheetFrames[i].atMs / 1000).toFixed(1)}s` : ''
    drawText(canvas, width, x + 4, y + tileHeight + 5, 1, `#${i + 1}/${sheetFrames.length}${stamp}`, [180, 220, 255])
  }

  const path = options.path
  if (!path) throw new Error('writeContactSheet needs options.path')
  const bytes = writePng(path, width, height, canvas)
  return { path, width, height, bytes, columns, rows }
}
