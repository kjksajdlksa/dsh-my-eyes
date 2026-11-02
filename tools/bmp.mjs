/**
 * Reading 24-bit BMP screenshots produced by eyes.ps1.
 *
 * The engine writes uncompressed Windows BMP (`BI_RGB`, 24bpp, bottom-up or
 * top-down) so this parser stays trivial: header validation, then a stride-aware
 * copy into a tightly packed RGB buffer.
 *
 * @module @local/dsh-my-eyes/bmp
 */
import { readFileSync } from 'node:fs'

/**
 * Decode one 24-bit BMP file.
 * @param {string} path
 * @returns {{ width: number, height: number, data: Buffer }} RGB888, top-down rows
 */
export function readBmp24(path) {
  const buf = readFileSync(path)
  if (buf.length < 54) throw new Error(`BMP too short: ${path}`)
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error(`not a BMP: ${path}`)
  const dataOffset = buf.readUInt32LE(10)
  const headerSize = buf.readUInt32LE(14)
  if (headerSize < 40) throw new Error(`unsupported BMP header size ${headerSize}: ${path}`)
  const width = buf.readInt32LE(18)
  const rawHeight = buf.readInt32LE(22)
  const planes = buf.readUInt16LE(26)
  const bits = buf.readUInt16LE(28)
  const compression = buf.readUInt32LE(30)
  if (planes !== 1) throw new Error(`unsupported BMP planes ${planes}: ${path}`)
  if (bits !== 24) throw new Error(`unsupported BMP bit depth ${bits} (expected 24): ${path}`)
  if (compression !== 0) throw new Error(`unsupported BMP compression ${compression}: ${path}`)
  if (width <= 0 || rawHeight === 0) throw new Error(`bad BMP dimensions ${width}x${rawHeight}: ${path}`)

  const height = Math.abs(rawHeight)
  const bottomUp = rawHeight > 0
  const stride = Math.ceil((width * 3) / 4) * 4
  if (dataOffset + stride * height > buf.length) throw new Error(`truncated BMP pixel data: ${path}`)

  const out = Buffer.allocUnsafe(width * height * 3)
  for (let row = 0; row < height; row += 1) {
    const srcRow = bottomUp ? height - 1 - row : row
    const src = dataOffset + srcRow * stride
    const dst = row * width * 3
    for (let x = 0; x < width; x += 1) {
      const s = src + x * 3
      const d = dst + x * 3
      // BMP stores BGR
      out[d] = buf[s + 2]
      out[d + 1] = buf[s + 1]
      out[d + 2] = buf[s]
    }
  }
  return { width, height, data: out }
}
