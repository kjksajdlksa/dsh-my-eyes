#!/usr/bin/env node
/**
 * Build the self-update payload for 我的眼睛 (My Eyes).
 *
 *   node scripts/release.mjs [--dest <dir>] [--bump <x.y.z>]
 *
 * Copies the plugin files into `<dest>/latest` (default `dist/latest`), writes a
 * manifest with the version and SHA-256 of every packaged file, and bumps the
 * version in package.json, VERSION and the engine's `$script:EngineVersion` when
 * `--bump` is given. `eyes { action: "update" }` reads exactly this layout, so the
 * release step and the update step cannot drift apart.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(dirname(fileURLToPath(import.meta.url)))
const FILES = ['index.js', 'eyes.ps1', 'package.json', 'cordis.patch.yml', 'README.md', 'VERSION', 'icon.svg']
const DIRS = ['tools', 'locale', 'scripts']
const EXPECTED = [...FILES, ...DIRS]

const args = process.argv.slice(2)
const destArg = args.indexOf('--dest')
const bumpArg = args.indexOf('--bump')
const bump = bumpArg >= 0 ? args[bumpArg + 1] : undefined
const dest = destArg >= 0 ? resolve(args[destArg + 1]) : join(HERE, 'dist')
const latest = join(dest, 'latest')

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function collect(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...collect(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}

function bumpVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`--bump needs x.y.z, got "${version}"`)
  const pkgPath = join(HERE, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.version = version
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  writeFileSync(join(HERE, 'VERSION'), `${version}\n`, 'utf8')
  const enginePath = join(HERE, 'eyes.ps1')
  const engine = readFileSync(enginePath, 'utf8').replace(/\$script:EngineVersion = '[^']*'/, `$script:EngineVersion = '${version}'`)
  writeFileSync(enginePath, engine, 'utf8')
  console.log(`bumped to ${version} (package.json, VERSION, eyes.ps1)`)
}

if (bump) bumpVersion(bump)

const version = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version

rmSync(latest, { recursive: true, force: true })
mkdirSync(latest, { recursive: true })

const checksums = {}
for (const file of FILES) {
  const from = join(HERE, file)
  if (!statSync(from, { throwIfNoEntry: false })) continue
  copyFileSync(from, join(latest, file))
  checksums[file] = sha256(from)
}
for (const dir of DIRS) {
  const from = join(HERE, dir)
  if (!statSync(from, { throwIfNoEntry: false })) continue
  const out = join(latest, dir)
  mkdirSync(out, { recursive: true })
  for (const rel of collect(from)) {
    copyFileSync(join(from, rel), join(latest, dir, rel))
    checksums[`${dir}/${rel}`] = sha256(join(from, rel))
  }
}

const manifest = {
  schema: 'dsh-my-eyes/release/v1',
  name: '@local/dsh-my-eyes',
  version,
  releasedAt: new Date().toISOString(),
  files: Object.keys(checksums).sort(),
  sha256: checksums,
}
writeFileSync(join(latest, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const unknown = EXPECTED.filter((entry) => !statSync(join(HERE, entry), { throwIfNoEntry: false }))
if (unknown.length > 0) console.warn(`warning: expected entries missing: ${unknown.join(', ')}`)

console.log(`released ${version} -> ${latest}`)
console.log(`files: ${Object.keys(checksums).length}`)
