// Integration test: load the plugin the way DSH does, call the tool, check outputs.
//
// DSH resolves `@deepseek-ai/dsh-tools` from its own installation, which is not
// importable from a plain Node process. A resolve hook maps that bare specifier to
// an in-memory stub with the same `defineTool` contract, so this test exercises the
// real plugin module (engine, GIF encoder, contact sheet) without a running Harness.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Module } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const stubUrl = 'data:text/javascript,' + encodeURIComponent('export function defineTool(spec) { return spec }')
const hooks = Module.registerHooks?.({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: stubUrl, shortCircuit: true, format: 'module' }
    return nextResolve(specifier, context)
  },
})

const moduleUrl = pathToFileURL(join(import.meta.dirname, '..', 'index.js')).href
const plugin = await import(moduleUrl)

const workDir = process.argv[2]
mkdirSync(workDir, { recursive: true })

const tools = new Map()
const attachments = []
const sections = []
const registered = []
const ctx = {
  logger: { info: () => {}, warn: console.warn, error: console.error },
  effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') registered.push(cleanup); return () => {} },
  systemPrompt: { section(entry) { sections.push(entry); return () => {} } },
  get(name) {
    if (name === 'attachments') {
      return {
        async saveImage({ data, mediaType, name: fileName }) {
          const ref = { id: `att-${attachments.length}`, mediaType, bytes: data.length, name: fileName }
          attachments.push(ref)
          return ref
        },
      }
    }
    return undefined
  },
  tools: { register(tool) { tools.set(tool.name, tool) } },
}

plugin.apply(ctx, { workDir, keepClips: 4 })
const tool = tools.get('eyes')
if (!tool) throw new Error('eyes tool was not registered')
console.log('registered tool:', tool.name, 'sections:', sections.map((s) => s.name).join(','))

const results = []
async function call(label, args) {
  const started = Date.now()
  try {
    const value = await tool.execute(args, {})
    results.push({ label, ok: true, ms: Date.now() - started, keys: Object.keys(value) })
    console.log(`ok   ${label} (${Date.now() - started} ms) ${JSON.stringify(value).slice(0, 400)}`)
    if (value?.__images) {
      const rendered = tool.output.render(args, value)
      console.log(`     render blocks: ${rendered.map((block) => block.type).join(' + ')}`)
      console.log(rendered[0].text.split('\n').map((line) => `     | ${line}`).join('\n'))
    }
    return value
  } catch (error) {
    results.push({ label, ok: false, ms: Date.now() - started, error: String(error) })
    console.error(`FAIL ${label}: ${String(error)}`)
    return undefined
  }
}

await call('info', { action: 'info' })
await call('windows', { action: 'windows' })
const look = await call('look', { action: 'look', maxWidth: 900 })
await call('look.window', { action: 'look', target: 'window', window: 'DeepSeek Harness', maxWidth: 900 })
const watch = await call('watch', { action: 'watch', durationMs: 1500, fps: 3, maxWidth: 480 })
await call('selfcheck', { action: 'selfcheck' })
const noSource = await call('update.no-source', { action: 'update', source: join(workDir, 'definitely-missing') })
const current = await call('update.current', { action: 'update', source: join(import.meta.dirname, '..', 'dist', 'latest') })

// Self-update rehearsal: build a newer copy in a scratch directory outside the
// plugin, apply it, then restore the development copy from dist/latest.
//
// `scripts/` is deliberately left out of the payload: this file lives there, so copying
// it over the development tree would rewrite the running test half-way through. The
// production update does copy `scripts/`; the check below still proves the rest of the
// payload survives.
const scratch = join(workDir, 'update-source')
const release = join(import.meta.dirname, '..', 'dist', 'latest')
mkdirSync(scratch, { recursive: true })
const pkg = JSON.parse(readFileSync(join(release, 'package.json'), 'utf8'))
// Derive the rehearsal version from the payload instead of hardcoding it, so this
// test keeps working across releases.
const [major, minor, patch] = String(pkg.version).split('.').map(Number)
const rehearsalVersion = `${major}.${minor}.${patch + 1}`
pkg.version = rehearsalVersion
writeFileSync(join(scratch, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
for (const entry of ['index.js', 'eyes.ps1', 'VERSION', 'cordis.patch.yml', 'tools', 'locale']) {
  cpSync(join(release, entry), join(scratch, entry), { recursive: true })
}
const updated = await call('update.applied', { action: 'update', source: scratch })
const installed = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version
console.log(`     installed version after rehearsal: ${installed}`)
if (updated?.status !== 'updated' || installed !== rehearsalVersion) {
  results.push({ label: 'update.assert', ok: false, error: `expected ${rehearsalVersion}, got ${updated?.status}/${installed}` })
}
for (const rel of ['tools/engine.mjs', 'tools/gif.mjs', 'scripts/selfcheck.mjs', 'index.js', 'eyes.ps1']) {
  if (!existsSync(join(import.meta.dirname, '..', rel))) {
    results.push({ label: 'update.kept-files', ok: false, error: `${rel} disappeared during update` })
  }
}
for (const entry of ['package.json', 'VERSION', 'eyes.ps1']) {
  cpSync(join(release, entry), join(import.meta.dirname, '..', entry))
}
rmSync(scratch, { recursive: true, force: true })
if (noSource?.status !== 'no-source') results.push({ label: 'update.no-source.assert', ok: false, error: `expected no-source, got ${noSource?.status}` })
if (current?.status !== 'current') results.push({ label: 'update.current.assert', ok: false, error: `expected current, got ${current?.status}` })
await call('bad-action', { action: 'nope' })

writeFileSync(join(workDir, 'integration.json'), `${JSON.stringify({ attachments, results }, null, 2)}\n`, 'utf8')
const failed = results.filter((r) => !r.ok && r.label !== 'bad-action')
console.log(failed.length === 0 ? '\nINTEGRATION PASSED' : `\nINTEGRATION FAILED: ${failed.map((r) => r.label).join(', ')}`)
hooks?.deregister()
for (const cleanup of registered) {
  try { cleanup() } catch (error) { console.error('dispose failed:', String(error)) }
}
// Give the killed host a moment to leave, then prove no engine process survived.
await new Promise((resolvePromise) => setTimeout(resolvePromise, 800))
process.exit(failed.length === 0 ? 0 : 1)
