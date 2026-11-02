#!/usr/bin/env node
/**
 * Validate a built self-update payload (the `dist/latest` layout).
 *
 *   node scripts/check-release.mjs <payload dir>
 *
 * Used by CI after `node scripts/release.mjs`: the payload must declare the same
 * version as package.json, carry the engine and the modules the updater copies, and
 * have a manifest whose SHA-256 list matches the files actually present.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const payload = process.argv[2]
if (!payload) {
  console.error('usage: node scripts/check-release.mjs <payload dir>')
  process.exit(2)
}

const problems = []
const fail = (message) => problems.push(message)

const manifestPath = join(payload, 'MANIFEST.json')
if (!existsSync(manifestPath)) {
  console.error(`FAIL  no MANIFEST.json in ${payload}`)
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8').replace(/^\uFEFF/, ''))

if (manifest.version !== pkg.version) fail(`manifest version ${manifest.version} != package.json ${pkg.version}`)
for (const required of ['index.js', 'eyes.ps1', 'package.json', 'cordis.patch.yml', 'tools/github.mjs', 'tools/engine.mjs']) {
  if (!manifest.files.includes(required)) fail(`manifest does not list ${required}`)
  if (!existsSync(join(payload, required))) fail(`payload is missing ${required}`)
}

const bad = []
for (const [rel, expected] of Object.entries(manifest.sha256 ?? {})) {
  const file = join(payload, rel)
  if (!existsSync(file)) { bad.push(`${rel} (missing)`); continue }
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (actual !== expected) bad.push(`${rel} (hash mismatch)`)
}
if (bad.length > 0) fail(`checksum problems: ${bad.slice(0, 5).join(', ')}`)

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL  ${problem}`)
  console.error(`RELEASE PAYLOAD INVALID (${problems.length})`)
  process.exit(1)
}
console.log(`RELEASE PAYLOAD OK — ${manifest.version}, ${Object.keys(manifest.sha256 ?? {}).length} checksums verified`)
