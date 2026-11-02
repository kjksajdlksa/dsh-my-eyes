/**
 * A small, dependency-free animated GIF89a encoder.
 *
 * The plugin has to work on a bare Windows box with no ffmpeg, no ImageMagick and
 * no Python, so the recording path cannot lean on an external encoder. GIF89a is
 * compact enough to implement directly: a fixed 256-entry palette (6x6x6 colour
 * cube + grey ramp), one LZW-coded image per frame, one graphic control
 * extension per frame for the delay, and a NETSCAPE2.0 loop block.
 *
 * Colour reduction uses a 15-bit lookup table built once per process, with an
 * optional ordered (Bayer 4x4) dither that keeps UI gradients from banding.
 *
 * @module @local/dsh-my-eyes/gif
 */
import { writeFileSync } from 'node:fs'

const CUBE = [0, 51, 102, 153, 204, 255]
const GREY_STEPS = [
  0, 6, 13, 19, 26, 32, 38, 45, 51, 57, 64, 70, 76, 83, 89, 95, 102, 108, 114, 121,
  127, 133, 140, 146, 152, 159, 165, 171, 178, 184, 190, 197, 203, 209, 216, 222, 228, 235, 241, 247,
]

/** Build the global colour table and the 15-bit nearest-colour cache. */
function buildPalette() {
  const palette = Buffer.alloc(256 * 3)
  let n = 0
  for (const r of CUBE) {
    for (const g of CUBE) {
      for (const b of CUBE) {
        palette[n * 3] = r
        palette[n * 3 + 1] = g
        palette[n * 3 + 2] = b
        n += 1
      }
    }
  }
  for (const v of GREY_STEPS) {
    palette[n * 3] = v
    palette[n * 3 + 1] = v
    palette[n * 3 + 2] = v
    n += 1
  }
  while (n < 256) {
    palette[n * 3] = 0
    palette[n * 3 + 1] = 0
    palette[n * 3 + 2] = 0
    n += 1
  }

  // index = (r>>3)<<10 | (g>>3)<<5 | (b>>3); each axis 0..31
  const lut = new Uint8Array(32768)
  for (let r = 0; r < 32; r += 1) {
    const rv = r * 8 + 4
    for (let g = 0; g < 32; g += 1) {
      const gv = g * 8 + 4
      for (let b = 0; b < 32; b += 1) {
        const bv = b * 8 + 4
        let best = 0
        let bestDistance = Infinity
        for (let i = 0; i < 256; i += 1) {
          const dr = rv - palette[i * 3]
          const dg = gv - palette[i * 3 + 1]
          const db = bv - palette[i * 3 + 2]
          const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db
          if (d < bestDistance) { bestDistance = d; best = i }
        }
        lut[(r << 10) | (g << 5) | b] = best
      }
    }
  }
  return { palette, lut }
}

const BAYER_4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

let cached
function palette() {
  if (cached === undefined) cached = buildPalette()
  return cached
}

/** Quantise one RGB frame into palette indices. */
export function quantize({ width, height, data }, dither = 6) {
  const { lut } = palette()
  const indices = new Uint8Array(width * height)
  if (dither <= 0) {
    for (let i = 0, p = 0; i < indices.length; i += 1, p += 3) {
      indices[i] = lut[((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3)]
    }
    return indices
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x
      const p = i * 3
      const bias = ((BAYER_4[((y & 3) << 2) | (x & 3)] / 16) - 0.5) * dither * 2
      const r = Math.min(255, Math.max(0, data[p] + bias))
      const g = Math.min(255, Math.max(0, data[p + 1] + bias))
      const b = Math.min(255, Math.max(0, data[p + 2] + bias))
      indices[i] = lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)]
    }
  }
  return indices
}

class ByteSink {
  constructor(size = 1 << 20) {
    this.buf = Buffer.allocUnsafe(size)
    this.length = 0
    this.blocks = []
  }
  ensure(extra) {
    if (this.length + extra <= this.buf.length) return
    this.blocks.push(this.buf.subarray(0, this.length))
    this.buf = Buffer.allocUnsafe(Math.max(extra, this.buf.length))
    this.length = 0
  }
  pushByte(value) {
    this.ensure(1)
    this.buf[this.length++] = value & 0xff
  }
  pushUShort(value) {
    this.ensure(2)
    this.buf[this.length++] = value & 0xff
    this.buf[this.length++] = (value >> 8) & 0xff
  }
  pushBytes(buffer) {
    this.ensure(buffer.length)
    for (let i = 0; i < buffer.length; i += 1) this.buf[this.length + i] = buffer[i]
    this.length += buffer.length
  }
  pushString(text) {
    this.pushBytes(Buffer.from(text, 'latin1'))
  }
  toBuffer() {
    const tail = this.buf.subarray(0, this.length)
    return this.blocks.length === 0 ? Buffer.from(tail) : Buffer.concat([...this.blocks, tail])
  }
}

/**
 * LZW-compress one indexed frame into GIF data sub-blocks.
 * Codes are packed LSB-first; every 255 bytes are flushed as a sub-block.
 */
function lzwEncode(indices, minCodeSize, sink) {
  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1
  let codeSize = minCodeSize + 1
  let nextCode = eoiCode + 1
  let dict = new Map()
  let resetPending = false

  let bitBuffer = 0
  let bitCount = 0
  const block = Buffer.allocUnsafe(255)
  let blockLength = 0

  const flushBlock = () => {
    if (blockLength === 0) return
    sink.pushByte(blockLength)
    sink.pushBytes(block.subarray(0, blockLength))
    blockLength = 0
  }
  const putCode = (code) => {
    bitBuffer |= code << bitCount
    bitCount += codeSize
    while (bitCount >= 8) {
      block[blockLength++] = bitBuffer & 0xff
      if (blockLength === 255) flushBlock()
      bitBuffer >>>= 8
      bitCount -= 8
    }
  }

  sink.pushByte(minCodeSize)
  putCode(clearCode)

  let prefix = indices[0]
  for (let i = 1; i < indices.length; i += 1) {
    if (resetPending) {
      putCode(clearCode)
      dict = new Map()
      codeSize = minCodeSize + 1
      nextCode = eoiCode + 1
      resetPending = false
    }
    const k = indices[i]
    const key = (prefix << 8) | k
    const found = dict.get(key)
    if (found !== undefined) {
      prefix = found
      continue
    }
    putCode(prefix)
    if (nextCode < 4096) {
      dict.set(key, nextCode)
      nextCode += 1
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize += 1
    } else {
      resetPending = true
    }
    prefix = k
  }
  putCode(prefix)
  if (resetPending) {
    putCode(clearCode)
    codeSize = minCodeSize + 1
  }
  putCode(eoiCode)
  if (bitCount > 0) {
    block[blockLength++] = bitBuffer & 0xff
    if (blockLength === 255) flushBlock()
  }
  flushBlock()
  sink.pushByte(0)
}

/**
 * Encode an animated GIF.
 * @param {Array<{ data: Buffer, width: number, height: number, delayMs?: number }>} frames
 * @param {{ dither?: number, loop?: boolean }} [options]
 * @returns {Buffer}
 */
export function encodeGif(frames, options = {}) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('encodeGif needs at least one frame')
  const width = frames[0].width
  const height = frames[0].height
  const dither = options.dither ?? 6
  const sink = new ByteSink()

  sink.pushString('GIF89a')
  sink.pushUShort(width)
  sink.pushUShort(height)
  sink.pushByte(0xf7) // global colour table present, 8-bit colour resolution, 256 entries
  sink.pushByte(0) // background index
  sink.pushByte(0) // pixel aspect ratio
  sink.pushBytes(palette().palette)

  if (options.loop !== false) {
    sink.pushBytes(Buffer.from([0x21, 0xff, 0x0b]))
    sink.pushString('NETSCAPE2.0')
    sink.pushBytes(Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]))
  }

  for (const frame of frames) {
    if (frame.width !== width || frame.height !== height) throw new Error('encodeGif frames must share one size')
    const delay = Math.max(2, Math.round((frame.delayMs ?? 200) / 10))
    sink.pushBytes(Buffer.from([0x21, 0xf9, 0x04, 0x04]))
    sink.pushUShort(delay)
    sink.pushBytes(Buffer.from([0x00, 0x00]))
    sink.pushByte(0x2c)
    sink.pushUShort(0)
    sink.pushUShort(0)
    sink.pushUShort(width)
    sink.pushUShort(height)
    sink.pushByte(0)
    lzwEncode(quantize(frame, dither), 8, sink)
  }

  sink.pushByte(0x3b)
  return sink.toBuffer()
}

/**
 * Encode frames into an animated GIF on disk.
 * @returns {{ path: string, bytes: number, frames: number, width: number, height: number }}
 */
export function writeGif(path, frames, options = {}) {
  const buffer = encodeGif(frames, options)
  writeFileSync(path, buffer)
  return { path, bytes: buffer.length, frames: frames.length, width: frames[0].width, height: frames[0].height }
}
