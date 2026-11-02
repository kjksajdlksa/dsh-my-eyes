/**
 * Persistent PowerShell host for the capture engine (eyes.ps1).
 *
 * A cold PowerShell start costs 2-3 s, so the engine is started once and then fed
 * one request per line. The host is spawned lazily, restarted at most
 * `maxRestarts` times per `restartWindowMs` when it dies, killed when idle, and
 * killed on dispose. Requests are strictly serialised: the engine owns a single
 * screen and a single stdout pipe, so overlapping calls would interleave frames.
 *
 * Orphan control: every host writes `<tmp>/dsh-my-eyes/engines/<host pid>.json`
 * naming its owning Node pid. A sweep at startup kills hosts whose owner is gone,
 * so a crashed previous Harness never leaves a 80 MB PowerShell behind.
 *
 * @module @local/dsh-my-eyes/engine
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CALL_TIMEOUT_MS = 120000
const START_TIMEOUT_MS = 45000
const MAX_STDERR = 4000
const DEFAULT_IDLE_KILL_MS = 8 * 60 * 1000

function registryDir() {
  return join(tmpdir(), 'dsh-my-eyes', 'engines')
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Kill engine hosts whose owning Node process no longer exists.
 * @returns {{ killed: number, scanned: number }}
 */
export function reapOrphanEngines() {
  const dir = registryDir()
  if (!existsSync(dir)) return { killed: 0, scanned: 0 }
  let killed = 0
  let scanned = 0
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    scanned += 1
    const path = join(dir, entry)
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'))
      if (record?.ownerPid === process.pid) continue
      if (isAlive(record?.ownerPid) && record.ownerPid !== process.pid) continue
      if (isAlive(record?.hostPid)) {
        try {
          process.kill(record.hostPid)
          killed += 1
        } catch { /* already gone */ }
      }
      unlinkSync(path)
    } catch {
      try { unlinkSync(path) } catch { /* ignore */ }
    }
  }
  return { killed, scanned }
}

function writeRegistryRecord(hostPid) {
  try {
    const dir = registryDir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${hostPid}.json`)
    writeFileSync(path, `${JSON.stringify({ hostPid, ownerPid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8')
    return path
  } catch {
    return undefined
  }
}

function removeRegistryRecord(hostPid) {
  try {
    unlinkSync(join(registryDir(), `${hostPid}.json`))
  } catch { /* ignore */ }
}

export class EyeEngine {
  /**
   * @param {{ scriptPath: string, callTimeoutMs?: number, maxRestarts?: number, restartWindowMs?: number, idleKillMs?: number, logger?: any }} options
   */
  constructor(options) {
    this.scriptPath = options.scriptPath
    this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS
    this.maxRestarts = options.maxRestarts ?? 3
    this.restartWindowMs = options.restartWindowMs ?? 10 * 60 * 1000
    this.idleKillMs = options.idleKillMs ?? DEFAULT_IDLE_KILL_MS
    this.logger = options.logger

    this.child = undefined
    this.buffer = ''
    this.pending = undefined
    this.seq = 0
    this.starting = undefined
    this.restarts = []
    this.lastError = undefined
    this.ready = false
    this.lastActivity = 0
    this.idleTimer = undefined
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null)
  }

  get stats() {
    return {
      running: this.running,
      ready: this.ready,
      pid: this.child?.pid,
      restarts: this.restarts.length,
      lastError: this.lastError,
      idleMs: this.lastActivity > 0 ? Date.now() - this.lastActivity : undefined,
    }
  }

  /** Start the host if needed and resolve once its ready line arrived. */
  async ensure() {
    if (this.running) return
    if (this.starting) return this.starting
    if (!existsSync(this.scriptPath)) throw new Error(`capture engine not found: ${this.scriptPath}`)

    this.starting = new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      const child = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-Serve'],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
      this.child = child
      this.ready = false
      this.lastActivity = Date.now()
      if (typeof child.pid === 'number') writeRegistryRecord(child.pid)
      let stderr = ''
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { child.kill() } catch { /* already gone */ }
        rejectPromise(new Error(`capture engine did not start within ${START_TIMEOUT_MS} ms`))
      }, START_TIMEOUT_MS)
      timer.unref?.()

      const settle = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.starting = undefined
        if (error) {
          this.lastError = error.message
          rejectPromise(error)
        } else {
          this.ready = true
          this.#armIdleTimer()
          resolvePromise()
        }
      }

      child.on('error', (error) => {
        this.lastError = error.message
        settle(error)
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderr += chunk
        if (stderr.length > MAX_STDERR) stderr = stderr.slice(-MAX_STDERR)
      })
      child.on('exit', (code, signal) => {
        const pending = this.pending
        this.pending = undefined
        this.child = undefined
        this.ready = false
        this.#clearIdleTimer()
        if (typeof child.pid === 'number') removeRegistryRecord(child.pid)
        const suffix = stderr.trim() ? `: ${stderr.trim()}` : ''
        if (pending) {
          clearTimeout(pending.timer)
          pending.reject(new Error(`capture engine exited while a call was pending (${String(code ?? signal)})${suffix}`))
        }
        settle(new Error(`capture engine exited during startup (${String(code ?? signal)})${suffix}`))
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => this.#onData(chunk, () => settle(undefined)))
    }).finally(() => { this.starting = undefined })

    return this.starting
  }

  #onData(chunk, onReady) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf('\n')
      if (line.length === 0) continue
      const bar = line.indexOf('|')
      if (bar < 0) {
        try {
          const ready = JSON.parse(line)
          if (ready && ready.ready === true) onReady()
        } catch { /* ignore stray output */ }
        continue
      }
      const id = line.slice(0, bar)
      const payload = line.slice(bar + 1)
      const pending = this.pending
      if (!pending || pending.id !== id) continue
      this.pending = undefined
      clearTimeout(pending.timer)
      try {
        pending.resolve(JSON.parse(payload))
      } catch (error) {
        pending.reject(new Error(`capture engine returned malformed JSON: ${String(error)}`))
      }
    }
  }

  /** Account for one host death in the restart window. */
  #noteRestart() {
    const now = Date.now()
    this.restarts = this.restarts.filter((at) => now - at < this.restartWindowMs)
    if (this.restarts.length >= this.maxRestarts) {
      throw new Error(`capture engine crashed ${this.restarts.length} times in ${Math.round(this.restartWindowMs / 60000)} min; refusing to restart after ${this.maxRestarts} attempts`)
    }
    this.restarts.push(now)
  }

  #clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }

  #armIdleTimer() {
    this.#clearIdleTimer()
    if (!(this.idleKillMs > 0)) return
    this.idleTimer = setTimeout(() => {
      if (!this.running) return
      if (Date.now() - this.lastActivity < this.idleKillMs) {
        this.#armIdleTimer()
        return
      }
      this.logger?.info?.(`[my-eyes] idle for ${Math.round(this.idleKillMs / 1000)}s; stopping capture engine pid ${this.child?.pid}`)
      this.kill()
    }, this.idleKillMs)
    this.idleTimer.unref?.()
  }

  /** Run one request and resolve its parsed result object. */
  async request(request) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.ensure()
      } catch (error) {
        if (attempt === 0) {
          this.#noteRestart()
          continue
        }
        throw error
      }
      const child = this.child
      if (!child || child.exitCode !== null) continue
      this.lastActivity = Date.now()
      const id = String(++this.seq)
      const line = `${id}|${JSON.stringify(request)}\n`
      return await new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          if (this.pending && this.pending.id === id) this.pending = undefined
          this.kill()
          rejectPromise(new Error(`capture engine call timed out after ${this.callTimeoutMs} ms`))
        }, this.callTimeoutMs)
        timer.unref?.()
        this.pending = { id, resolve: resolvePromise, reject: rejectPromise, timer }
        try {
          child.stdin.write(line)
        } catch (error) {
          clearTimeout(timer)
          this.pending = undefined
          rejectPromise(error)
        }
      }).finally(() => {
        this.lastActivity = Date.now()
        if (this.running) this.#armIdleTimer()
      })
    }
    throw new Error('capture engine could not accept the request')
  }

  kill() {
    const child = this.child
    this.child = undefined
    this.ready = false
    this.#clearIdleTimer()
    if (!child) return
    if (typeof child.pid === 'number') removeRegistryRecord(child.pid)
    try { child.stdin.end() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
  }
}
