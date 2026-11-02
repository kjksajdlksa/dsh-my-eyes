#!/usr/bin/env node
/**
 * Static gate for 我的眼睛 (My Eyes): everything CI can prove without a desktop.
 *
 *   node scripts/verify.mjs
 *
 * The screen-dependent checks live in `scripts/selfcheck.mjs` (needs a real session)
 * and `scripts/integration.mjs` (loads the plugin the way DSH does). This file is the
 * part that runs headless on GitHub Actions, on any OS: version consistency across the
 * three places a version lives, the runtime file set, syntax of every module, locale
 * JSON, and the cordis patch manifest.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(dirname(fileURLToPath(import.meta.url)))
const SKIP_DIRS = new Set(['dist', 'node_modules', 'updates', 'update-cache', '.git', 'backups'])
const REQUIRED = [
  'index.js',
  'eyes.ps1',
  'cordis.patch.yml',
  'package.json',
  'VERSION',
  'README.md',
  'icon.svg',
  'tools/engine.mjs',
  'tools/bmp.mjs',
  'tools/gif.mjs',
  'tools/sheet.mjs',
  'tools/github.mjs',
  'locale/zh.json',
  'locale/en.json',
  'scripts/selfcheck.mjs',
  'scripts/integration.mjs',
  'scripts/release.mjs',
  'scripts/check-release.mjs',
  'scripts/verify.mjs',
]

const failures = []
const passes = []

function check(name, fn) {
  try {
    const detail = fn()
    passes.push(detail ? `${name}: ${detail}` : name)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(join(dir, entry.name), out)
    } else {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

/** Parse a module without running it (`.js` is ESM here, so check it through stdin). */
function checkSyntax(file) {
  const isModule = file.endsWith('.mjs')
  const result = isModule
    ? spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    : spawnSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(file, 'utf8'), encoding: 'utf8' })
  if (result.error) throw new Error(result.error.message)
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim().split('\n').slice(0, 3).join(' | ')
    throw new Error(detail || `node --check exited ${result.status}`)
  }
}

const pkg = readJson(join(HERE, 'package.json'))
const versionFile = readFileSync(join(HERE, 'VERSION'), 'utf8').trim()
const engineVersion = /\$script:EngineVersion\s*=\s*'([^']+)'/.exec(readFileSync(join(HERE, 'eyes.ps1'), 'utf8'))?.[1]

check('package name', () => {
  if (pkg.name !== '@local/dsh-my-eyes') throw new Error(`unexpected name ${pkg.name}`)
  return pkg.name
})

check('version is semver', () => {
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? '')) throw new Error(`package.json version "${pkg.version}" is not x.y.z`)
  return pkg.version
})

check('version consistency (package.json / VERSION / eyes.ps1)', () => {
  const seen = { 'package.json': pkg.version, VERSION: versionFile, 'eyes.ps1': engineVersion }
  const distinct = new Set(Object.values(seen))
  if (distinct.size !== 1) throw new Error(JSON.stringify(seen))
  return pkg.version
})

check('required files exist', () => {
  const missing = REQUIRED.filter((rel) => !existsSync(join(HERE, rel)))
  if (missing.length > 0) throw new Error(`missing ${missing.join(', ')}`)
  return `${REQUIRED.length} files`
})

check('package.json files[] matches disk', () => {
  const entries = pkg.files ?? []
  if (entries.length === 0) throw new Error('files[] is empty')
  const missing = entries.filter((entry) => {
    const base = entry.split('*')[0].replace(/\/$/, '')
    return !existsSync(join(HERE, base || '.'))
  })
  if (missing.length > 0) throw new Error(`declared but missing: ${missing.join(', ')}`)
  const shipped = REQUIRED.filter((rel) => rel !== 'scripts/verify.mjs' && rel !== 'package.json')
  const undeclared = shipped.filter((rel) => !entries.some((entry) => rel === entry || rel.startsWith(`${entry}/`) || (entry.includes('*') && rel.startsWith(entry.split('*')[0]))))
  if (undeclared.length > 0) throw new Error(`not published: ${undeclared.join(', ')}`)
  return `${entries.length} entries`
})

check('every module parses', () => {
  const files = walk(HERE).filter((file) => /\.(mjs|js)$/.test(file))
  for (const file of files) checkSyntax(file)
  return `${files.length} modules`
})

check('locale JSON files parse', () => {
  const files = walk(join(HERE, 'locale'))
  for (const file of files) readJson(file)
  return `${files.length} files`
})

check('cordis patch wires the eyes tool', () => {
  const patch = readFileSync(join(HERE, 'cordis.patch.yml'), 'utf8')
  for (const needle of ['my-eyes', "'@local/dsh-my-eyes'"]) {
    if (!patch.includes(needle)) throw new Error(`cordis.patch.yml does not mention ${needle}`)
  }
  return 'ok'
})

check('no absolute paths in package.json', () => {
  const text = readFileSync(join(HERE, 'package.json'), 'utf8')
  if (/[A-Za-z]:\\\\/.test(text) || text.includes('/Users/')) throw new Error('absolute path found')
  return 'ok'
})

check('no secrets staged in the working tree', () => {
  const suspicious = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/
  const hits = walk(HERE).filter((file) => /\.(mjs|js|json|md|yml|ps1)$/.test(file) && suspicious.test(readFileSync(file, 'utf8')))
  if (hits.length > 0) throw new Error(`possible token in ${hits.map((file) => relative(HERE, file)).join(', ')}`)
  return 'ok'
})

check('no byte-order marks in shipped text', () => {
  // A BOM makes `JSON.parse` throw on strict readers (including DSH's own package
  // loader), so a release must never carry one.
  const hits = walk(HERE).filter((file) => {
    if (!/\.(mjs|js|json|md|yml|ps1|txt)$/.test(file)) return false
    const head = readFileSync(file).subarray(0, 3)
    return head.length === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
  })
  if (hits.length > 0) throw new Error(`BOM in ${hits.map((file) => relative(HERE, file)).join(', ')}`)
  return 'ok'
})

const total = passes.length + failures.length
for (const line of passes) console.log(`PASS  ${line}`)
for (const line of failures) console.log(`FAIL  ${line}`)
console.log(`\n${failures.length === 0 ? 'VERIFY PASSED' : 'VERIFY FAILED'} (${passes.length}/${total} checks)`)
process.exit(failures.length === 0 ? 0 : 1)
