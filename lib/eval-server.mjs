// A persistent Common Lisp evaluator for the free NodeCode lane.
//
// `nodecode trial` reads one form from stdin and evaluates it in a complete
// NodeCode image.  A fresh trial per tool call would lose definitions and
// warm-up state, so this module keeps one trial process and runs a tiny
// JSON-lines service inside it (lib/eval-server.lisp).  Each form evaluates on
// its own thread, so a slow shell command never blocks the next request and a
// timeout interrupts only that form instead of killing the image.

import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import net from "node:net"

const DEFAULT_START_TIMEOUT_MS = 20_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 100
const servers = new Map()

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_LISP = join(HERE, "eval-server.lisp")
const SOCKET_PLACEHOLDER = "__MAGPIE_SOCKET__"

function lispString(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

/**
 * The form handed to `nodecode trial`: the service with its socket path filled
 * in.  Keeping the Lisp in its own file makes it readable and testable.
 */
export function makeServerForm(socketPath) {
  const template = readFileSync(SERVER_LISP, "utf8")
  if (!template.includes(SOCKET_PLACEHOLDER)) {
    throw new Error(`${SERVER_LISP} is missing ${SOCKET_PLACEHOLDER}`)
  }
  return template.split(SOCKET_PLACEHOLDER).join(lispString(socketPath))
}

function binaryCandidates(env, home) {
  return [...new Set([
    env.NODECODE_BIN,
    join(home, ".local", "bin", "nodecode"),
    join(home, ".local", "share", "nodecode", "current", "nodecode"),
    "nodecode",
  ].filter((value) => typeof value === "string" && value.length > 0))]
}

function pickBinary(env, home) {
  for (const candidate of binaryCandidates(env, home)) {
    if (candidate === "nodecode" || existsSync(candidate)) return candidate
  }
  return "nodecode"
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class EvalServer {
  constructor({ binary, cwd, env, startTimeoutMs }) {
    this.binary = binary
    this.cwd = cwd
    this.env = env
    this.startTimeoutMs = startTimeoutMs
    this.child = null
    this.socket = null
    this.dir = null
    this.stderr = ""
    this.pending = new Map()
    this.buffer = ""
    this.seq = 0
    this.dead = false
    this.onDead = null
  }

  async start() {
    this.dir = mkdtempSync(join(tmpdir(), "nodecode-magpie-evalserver-"))
    this.socketPath = join(this.dir, "eval.sock")
    this.child = spawn(this.binary, ["trial"], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "ignore", "pipe"],
    })
    // Do not keep a short-lived CLI provider-test process alive just because
    // the persistent evaluator is warm; the exit hook below kills the child.
    this.child.unref()
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk
      if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000)
    })
    this.child.stderr.unref?.()
    this.child.on("error", (error) => {
      this.startError = error
    })
    this.child.on("exit", () => {
      this.markDead("nodecode trial exited")
    })
    this.child.stdin.end(makeServerForm(this.socketPath))

    const deadline = Date.now() + this.startTimeoutMs
    while (Date.now() < deadline) {
      if (this.startError) throw this.startError
      if (this.child.exitCode !== null) {
        throw new Error(
          `nodecode trial exited ${this.child.exitCode}${this.stderr ? `: ${this.stderr.trim()}` : ""}`,
        )
      }
      if (existsSync(this.socketPath)) {
        this.socket = await this.connect()
        return this
      }
      await delay(100)
    }
    throw new Error(`timed out waiting for ${this.socketPath}`)
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath })
      socket.setEncoding("utf8")
      socket.once("error", reject)
      socket.once("connect", () => {
        socket.removeListener("error", reject)
        socket.unref()
        socket.on("data", (chunk) => this.onData(chunk))
        socket.on("error", (error) => this.failAll(error))
        socket.on("close", () => {
          this.markDead("eval-server connection closed")
        })
        resolve(socket)
      })
    })
  }

  onData(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf("\n")
    while (index >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf("\n")
      if (!line.trim()) continue
      let payload
      try {
        payload = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = this.pending.get(payload.req_id)
      if (!waiter) continue
      this.pending.delete(payload.req_id)
      waiter(payload)
    }
  }

  failAll(error) {
    for (const [, waiter] of this.pending) {
      try {
        waiter({ status: "error", message: error.message })
      } catch {}
    }
    this.pending.clear()
  }

  /**
   * Retire this server permanently.  A dead image cannot answer anything, and
   * the next call starts a clean one.
   */
  markDead(reason) {
    if (this.dead) return
    this.dead = true
    this.deadReason = reason
    this.failAll(new Error(reason))
    try {
      this.socket?.destroy()
    } catch {}
    try {
      if (this.child && this.child.exitCode === null) this.child.kill("SIGKILL")
    } catch {}
    try {
      this.onDead?.(this)
    } catch {}
  }

  async ensureSocket() {
    if (this.dead) throw new Error(this.deadReason || "eval server is dead")
    if (this.socket && !this.socket.destroyed) return
    this.socket = await this.connect()
  }

  async send(request, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    await this.ensureSocket()
    const reqId = String(++this.seq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        reject(new Error(`eval service did not answer within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(reqId, (payload) => {
        clearTimeout(timer)
        resolve(payload)
      })
      this.socket.ref()
      this.socket.write(`${JSON.stringify({ ...request, req_id: reqId })}\n`, () => {
        this.socket.unref()
      })
    })
  }

  /** One request/response round trip against the Lisp service. */
  async request(request, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    return this.send(request, timeoutMs)
  }

  /**
   * Evaluate FORM and wait for it to finish.
   *
   * The eval is started with a zero yield window, so the Lisp accept loop stays
   * free for other calls, then polled until it exits or the timeout expires.
   * On timeout the form is interrupted in place: the image, its definitions
   * and any other running eval survive.
   */
  async run(form, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const started = await this.request(
      { op: "eval", form, yield_time_ms: 0 },
      Math.min(timeoutMs, 30_000),
    )
    if (started.status === "error") throw new Error(started.message || "eval failed")
    if (started.status === "exited") return finishedText(started)
    const id = started.eval_id
    let output = started.output ?? ""
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await delay(POLL_INTERVAL_MS)
      const status = await this.request({ op: "status", id }, 10_000)
      if (status.status === "error") throw new Error(status.message || "eval status failed")
      output += status.output ?? ""
      if (status.status === "exited") return finishedText({ ...status, output })
      if (status.status === "unknown") throw new Error(`eval ${id} vanished`)
    }
    // Soft interrupt, then force if the form refuses to die.
    await this.request({ op: "interrupt", id }, 5_000).catch(() => {})
    await delay(500)
    const last = await this.request({ op: "status", id }, 5_000).catch(() => null)
    if (last && last.status === "running") {
      await this.request({ op: "interrupt", id, force: true }, 5_000).catch(() => {})
    }
    throw new Error(`eval timed out after ${timeoutMs}ms`)
  }

  /**
   * Evaluate FORM the way the NodeCode CLI does: wait YIELD-MS for an answer,
   * then return a running envelope instead of killing the work.  The form keeps
   * going in the image and the model polls it with (magpie-eval-status N).
   */
  async runWithYield(form, { yieldMs = 10_000, strings } = {}) {
    const request = { op: "eval", form, yield_time_ms: 0 }
    if (strings && typeof strings === "object") request.strings = strings
    const started = await this.request(request, Math.min(yieldMs + 30_000, 60_000))
    if (started.status === "error") throw new Error(started.message || "eval failed")
    if (started.status === "exited") return { status: "exited", text: finishedText(started) }
    const id = started.eval_id
    let output = started.output ?? ""
    const deadline = Date.now() + yieldMs
    while (Date.now() < deadline) {
      await delay(POLL_INTERVAL_MS)
      const status = await this.request({ op: "status", id }, 10_000)
      if (status.status === "error") throw new Error(status.message || "eval status failed")
      output += status.output ?? ""
      if (status.status === "exited") return { status: "exited", text: finishedText({ ...status, output }) }
      if (status.status === "unknown") throw new Error(`eval ${id} vanished`)
    }
    return { status: "running", evalId: id, output }
  }

  async close() {
    try {
      this.socket?.destroy()
    } catch {}
    try {
      if (this.child && this.child.exitCode === null) this.child.kill("SIGKILL")
    } catch {}
    try {
      if (this.dir) rmSync(this.dir, { recursive: true, force: true })
    } catch {}
  }
}

function finishedText(payload) {
  const output = payload.output ?? ""
  const value = payload.value ?? ""
  if (output && value) return `${output}\n${value}`
  return value || output
}

function keyFor(binary, cwd, env) {
  return `${binary}\u0000${cwd}\u0000${env.NODECODE_HOME || env.HOME || homedir()}`
}

export async function getEvalServer({ binary, cwd, env = process.env, startTimeoutMs = DEFAULT_START_TIMEOUT_MS } = {}) {
  const home = env.NODECODE_HOME || env.HOME || homedir()
  const resolvedBinary = binary || pickBinary(env, home)
  const resolvedCwd = cwd && existsSync(cwd) ? cwd : process.cwd()
  const key = keyFor(resolvedBinary, resolvedCwd, env)
  let entry = servers.get(key)
  if (!entry || entry.dead) {
    entry = new EvalServer({ binary: resolvedBinary, cwd: resolvedCwd, env, startTimeoutMs })
    entry.onDead = () => {
      if (servers.get(key) === entry) servers.delete(key)
      entry.close().catch(() => {})
    }
    entry.startPromise = entry.start()
    servers.set(key, entry)
    try {
      await entry.startPromise
    } catch (error) {
      servers.delete(key)
      await entry.close()
      throw error
    }
  } else {
    await entry.startPromise
  }
  return entry
}

export async function dropEvalServer({ binary, cwd, env = process.env } = {}) {
  const home = env.NODECODE_HOME || env.HOME || homedir()
  const resolvedBinary = binary || pickBinary(env, home)
  const resolvedCwd = cwd && existsSync(cwd) ? cwd : process.cwd()
  const key = keyFor(resolvedBinary, resolvedCwd, env)
  const entry = servers.get(key)
  if (!entry) return
  servers.delete(key)
  await entry.close()
}

export async function closeEvalServers() {
  const entries = [...servers.values()]
  servers.clear()
  await Promise.all(entries.map((entry) => entry.close()))
}

process.once("exit", () => {
  for (const entry of servers.values()) {
    try {
      entry.socket?.destroy()
      if (entry.child && entry.child.exitCode === null) entry.child.kill("SIGKILL")
      if (entry.dir) rmSync(entry.dir, { recursive: true, force: true })
    } catch {}
  }
})

export { EvalServer }
