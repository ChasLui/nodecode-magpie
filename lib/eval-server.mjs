// A persistent Common Lisp evaluator for the free NodeCode lane.
//
// `nodecode trial` reads one form from stdin and evaluates it in a complete
// NodeCode image.  A fresh trial per tool call would lose definitions and
// warm-up state, so this module keeps one trial process and runs a tiny
// JSON-lines service inside it (lib/eval-server.lisp).  Each form evaluates on
// its own thread, so a slow shell command never blocks the next request and a
// timeout interrupts only that form instead of killing the image.

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import net from "node:net"

const DEFAULT_START_TIMEOUT_MS = 20_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 100
const DEFAULT_HISTORY_LIMIT = 500
const HISTORY_COMPACT_LINES = 1_000
const servers = new Map()

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_LISP = join(HERE, "eval-server.lisp")
const SOCKET_PLACEHOLDER = "__MAGPIE_SOCKET__"
const LOOK_SOCKET_PLACEHOLDER = "__MAGPIE_LOOK_SOCKET__"

function lispString(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

/**
 * The form handed to `nodecode trial`: the service with its socket path filled
 * in.  Keeping the Lisp in its own file makes it readable and testable.
 */
export function makeServerForm(socketPath, lookSocketPath = "") {
  const template = readFileSync(SERVER_LISP, "utf8")
  if (!template.includes(SOCKET_PLACEHOLDER) || !template.includes(LOOK_SOCKET_PLACEHOLDER)) {
    throw new Error(`${SERVER_LISP} is missing a socket placeholder`)
  }
  return template
    .split(SOCKET_PLACEHOLDER).join(lispString(socketPath))
    .split(LOOK_SOCKET_PLACEHOLDER).join(lispString(lookSocketPath))
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

function directoryPath(value) {
  try {
    return statSync(value).isDirectory() ? realpathSync(value) : ""
  } catch {
    return ""
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Where the definition history lives.  A plugin host restart drops the Lisp
 * image; replaying the definitions the session kept restores the part of the
 * CLI contract the model actually relies on (a `defun` stays callable).
 */
export function historyDir(env = process.env) {
  return (
    env.NODECODE_MAGPIE_HISTORY ||
    join(env.NODECODE_HOME || env.HOME || homedir(), ".nodecode-magpie", "history")
  )
}

function historyPath(key, env) {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32)
  return join(historyDir(env), `${digest}.jsonl`)
}

/** Split a snippet into top-level forms without touching strings or comments. */
export function topLevelForms(snippet) {
  const forms = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  let inComment = false
  for (let index = 0; index < snippet.length; index += 1) {
    const char = snippet[index]
    if (inComment) {
      if (char === "\n") inComment = false
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === ";") {
      inComment = true
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === "(") {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === ")") {
      if (depth > 0) {
        depth -= 1
        if (depth === 0 && start >= 0) {
          forms.push(snippet.slice(start, index + 1))
          start = -1
        }
      }
    }
  }
  return forms
}

const DEFINITION_PATTERN =
  /^\(\s*(defun|defvar|defparameter|defconstant|defmacro|defgeneric|defmethod|defsetf|defclass|defstruct|deftype|defpackage|define(-[a-z0-9-]+)?)\b/i

/** Keep the forms NodeCode itself would keep in a layer, not shell effects. */
export function definitionForms(snippet) {
  return topLevelForms(snippet).filter((form) => DEFINITION_PATTERN.test(form))
}

export function readHistory(file, limit = DEFAULT_HISTORY_LIMIT) {
  if (!file || !existsSync(file)) return []
  let lines
  try {
    lines = readFileSync(file, "utf8").split("\n")
  } catch {
    return []
  }
  const forms = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry && typeof entry.form === "string" && entry.form.trim()) {
        forms.push(entry.form)
      }
    } catch {}
  }
  const unique = []
  const seen = new Set()
  for (let index = forms.length - 1; index >= 0; index -= 1) {
    const form = forms[index]
    if (seen.has(form)) continue
    seen.add(form)
    unique.push(form)
  }
  unique.reverse()
  return unique.slice(-limit)
}

export function appendHistory(file, forms) {
  if (!file || forms.length === 0) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    const lines = forms.map((form) => JSON.stringify({ at: new Date().toISOString(), form }))
    appendFileSync(file, `${lines.join("\n")}\n`)
    const existing = readFileSync(file, "utf8").split("\n").filter(Boolean)
    if (existing.length > HISTORY_COMPACT_LINES) {
      writeFileSync(file, `${existing.slice(-HISTORY_COMPACT_LINES).join("\n")}\n`)
    }
  } catch {}
}

class EvalServer {
  constructor({ binary, cwd, env, startTimeoutMs, historyFile, lookHandler }) {
    this.binary = binary
    this.cwd = cwd
    this.env = env
    this.startTimeoutMs = startTimeoutMs
    this.historyFile = historyFile
    this.lookHandler = lookHandler
    this.replaying = false
    this.child = null
    this.socket = null
    this.lookServer = null
    this.lookSockets = new Set()
    this.lookSocketPath = null
    this.dir = null
    this.stderr = ""
    this.pending = new Map()
    this.buffer = ""
    this.lookBuffers = new WeakMap()
    this.seq = 0
    this.dead = false
    this.onDead = null
  }

  setLookHandler(handler) {
    if (handler) this.lookHandler = handler
  }

  async startLookServer() {
    this.lookSocketPath = join(this.dir, "look.sock")
    this.lookServer = net.createServer((socket) => {
      this.lookSockets.add(socket)
      socket.on("close", () => this.lookSockets.delete(socket))
      socket.setEncoding("utf8")
      socket.on("data", (chunk) => {
        const previous = this.lookBuffers.get(socket) ?? ""
        const buffer = previous + chunk
        let index = buffer.indexOf("\n")
        let rest = buffer
        while (index >= 0) {
          const line = rest.slice(0, index)
          rest = rest.slice(index + 1)
          index = rest.indexOf("\n")
          if (line.trim()) this.answerLook(socket, line).catch(() => {})
        }
        this.lookBuffers.set(socket, rest)
      })
      socket.on("error", () => {})
    })
    await new Promise((resolve, reject) => {
      this.lookServer.once("error", reject)
      this.lookServer.listen(this.lookSocketPath, () => {
        this.lookServer.unref()
        resolve()
      })
    })
  }

  async answerLook(socket, line) {
    let request
    try {
      request = JSON.parse(line)
    } catch {
      request = {}
    }
    let response
    try {
      if (!this.lookHandler) throw new Error("look is not configured")
      const text = await this.lookHandler({
        path: request.path,
        prompt: request.prompt,
        cwd: this.cwd,
      })
      response = { ok: true, text: typeof text === "string" ? text : JSON.stringify(text) }
    } catch (error) {
      response = { ok: false, error: error.message }
    }
    try {
      socket.write(`${JSON.stringify(response)}\n`)
    } catch {}
  }

  async start() {
    this.dir = mkdtempSync(join(tmpdir(), "nodecode-magpie-evalserver-"))
    this.socketPath = join(this.dir, "eval.sock")
    await this.startLookServer()
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
    this.child.stdin.end(makeServerForm(this.socketPath, this.lookSocketPath))

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
  /** Keep definition forms so a restarted image can replay them. */
  remember(form) {
    if (this.replaying || !this.historyFile) return
    appendHistory(this.historyFile, definitionForms(String(form)))
  }

  /**
   * Rebuild the layer a previous image had.  Only definition forms are
   * replayed, so shell commands and other side effects never run twice.
   */
  async replayHistory() {
    const forms = readHistory(this.historyFile)
    if (forms.length === 0) return
    this.replaying = true
    try {
      for (const form of forms) {
        try {
          await this.run(form, 15_000)
        } catch {}
      }
    } finally {
      this.replaying = false
    }
  }

  async run(form, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const started = await this.request(
      { op: "eval", form, yield_time_ms: 0 },
      Math.min(timeoutMs, 30_000),
    )
    if (started.status === "error") throw new Error(started.message || "eval failed")
    this.remember(form)
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
    this.remember(form)
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
      this.lookServer?.close()
    } catch {}
    for (const socket of this.lookSockets) {
      try {
        socket.destroy()
      } catch {}
    }
    this.lookSockets.clear()
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

function keyFor(binary, cwd, env, scope = "") {
  return `${binary}\u0000${cwd}\u0000${scope}\u0000${env.NODECODE_HOME || env.HOME || homedir()}`
}

export async function getEvalServer({ binary, cwd, env = process.env, scope = "", startTimeoutMs = DEFAULT_START_TIMEOUT_MS, lookHandler } = {}) {
  const home = env.NODECODE_HOME || env.HOME || homedir()
  const resolvedBinary = binary || pickBinary(env, home)
  const resolvedCwd = directoryPath(cwd) || process.cwd()
  const key = keyFor(resolvedBinary, resolvedCwd, env, scope)
  let entry = servers.get(key)
  if (!entry || entry.dead) {
    entry = new EvalServer({
      binary: resolvedBinary,
      cwd: resolvedCwd,
      env,
      startTimeoutMs,
      historyFile: historyPath(key, env),
      lookHandler,
    })
    entry.onDead = () => {
      if (servers.get(key) === entry) servers.delete(key)
      entry.close().catch(() => {})
    }
    entry.startPromise = entry.start().then(async () => {
      await entry.replayHistory()
      return entry
    })
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
    entry.setLookHandler(lookHandler)
  }
  return entry
}

export async function dropEvalServer({ binary, cwd, env = process.env, scope = "" } = {}) {
  const home = env.NODECODE_HOME || env.HOME || homedir()
  const resolvedBinary = binary || pickBinary(env, home)
  const resolvedCwd = directoryPath(cwd) || process.cwd()
  const key = keyFor(resolvedBinary, resolvedCwd, env, scope)
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
      entry.lookServer?.close()
      if (entry.child && entry.child.exitCode === null) entry.child.kill("SIGKILL")
      if (entry.dir) rmSync(entry.dir, { recursive: true, force: true })
    } catch {}
  }
})

export { EvalServer }
