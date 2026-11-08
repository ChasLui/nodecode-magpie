// A persistent Common Lisp evaluator for the free NodeCode lane.
//
// `nodecode trial` reads one form from stdin and evaluates it in a complete
// NodeCode image.  A fresh trial per tool call would lose definitions and
// warm-up state, so this module starts one trial process and keeps a tiny
// Unix-socket REPL in it.  Requests and responses are JSON lines; the Lisp
// side uses NodeCode's own `nlk:encode-json-object` encoder.

import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import net from "node:net"

const DEFAULT_START_TIMEOUT_MS = 15_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const servers = new Map()

function lispString(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

export function makeServerForm(socketPath) {
  return `(progn
  (require :sb-bsd-sockets)
  (let* ((path ${lispString(socketPath)})
         (sock (make-instance 'sb-bsd-sockets:local-socket :type :stream :protocol 0)))
    (when (probe-file path) (delete-file path))
    (sb-bsd-sockets:socket-bind sock path)
    (sb-bsd-sockets:socket-listen sock 8)
    (loop
      (let ((conn (sb-bsd-sockets:socket-accept sock)))
        (unwind-protect
             (with-open-stream
                 (stream (sb-bsd-sockets:socket-make-stream conn :input t :output t
                                                           :element-type 'character
                                                           :buffering :full))
               (loop
                 (let ((form (read stream nil :eof)))
                   (when (eq form :eof) (return))
                   (let ((payload
                           (handler-case
                               (let ((h (make-hash-table :test 'equal)))
                                 (setf (gethash "ok" h) t
                                       (gethash "value" h)
                                       (princ-to-string (eval form)))
                                 h)
                             (error (e)
                               (let ((h (make-hash-table :test 'equal)))
                                 (setf (gethash "ok" h) nil
                                       (gethash "error" h) (format nil "~a" e))
                                 h)))))
                     (format stream "~a~%" (nlk:encode-json-object payload))
                     (finish-output stream))))))
          (sb-bsd-sockets:socket-close conn))))))
`
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
    this.buffer = ""
    this.queue = Promise.resolve()
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
    // the persistent evaluator is warm.  The host process has its own handles;
    // when this process exits, the `exit` hook below kills the child.
    this.child.unref()
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk
    })
    this.child.stderr.unref?.()
    this.child.on("error", (error) => {
      this.startError = error
    })
    this.child.stdin.end(makeServerForm(this.socketPath))

    const deadline = Date.now() + this.startTimeoutMs
    while (Date.now() < deadline) {
      if (this.startError) throw this.startError
      if (this.child.exitCode !== null) {
        throw new Error(`nodecode trial exited ${this.child.exitCode}${this.stderr ? `: ${this.stderr.trim()}` : ""}`)
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
        resolve(socket)
      })
    })
  }

  async ensureSocket() {
    if (this.socket && !this.socket.destroyed) return
    this.socket = await this.connect()
  }

  request(form, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const run = () => this._request(form, timeoutMs)
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => {})
    return result
  }

  async _request(form, timeoutMs) {
    await this.ensureSocket()
    return new Promise((resolve, reject) => {
      let settled = false
      let buffer = this.buffer
      this.buffer = ""
      const socket = this.socket
      socket.ref()

      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeListener("data", onData)
        socket.removeListener("error", onError)
        socket.removeListener("close", onClose)
        socket.unref()
        fn(value)
      }

      const consume = () => {
        const index = buffer.indexOf("\n")
        if (index < 0) return
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        this.buffer = buffer
        let payload
        try {
          payload = JSON.parse(line)
        } catch (error) {
          finish(reject, new Error(`bad eval-server response: ${line}`))
          return
        }
        if (!payload.ok) {
          finish(reject, new Error(payload.error || "eval failed"))
          return
        }
        finish(resolve, String(payload.value ?? ""))
      }

      const onData = (chunk) => {
        buffer += chunk
        consume()
      }
      const onError = (error) => finish(reject, error)
      const onClose = () => finish(reject, new Error("eval-server connection closed"))
      const timer = setTimeout(() => {
        try {
          socket.destroy()
        } catch {}
        this.socket = null
        finish(reject, new Error(`eval timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      socket.on("data", onData)
      socket.on("error", onError)
      socket.on("close", onClose)
      socket.write(`${form}\n`)
    })
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

function keyFor(binary, cwd, env) {
  return `${binary}\u0000${cwd}\u0000${env.NODECODE_HOME || env.HOME || homedir()}`
}

export async function getEvalServer({ binary, cwd, env = process.env, startTimeoutMs = DEFAULT_START_TIMEOUT_MS } = {}) {
  const home = env.NODECODE_HOME || env.HOME || homedir()
  const resolvedBinary = binary || pickBinary(env, home)
  const resolvedCwd = cwd && existsSync(cwd) ? cwd : process.cwd()
  const key = keyFor(resolvedBinary, resolvedCwd, env)
  let entry = servers.get(key)
  if (!entry) {
    entry = new EvalServer({ binary: resolvedBinary, cwd: resolvedCwd, env, startTimeoutMs })
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
