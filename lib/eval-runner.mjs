// Execute NodeCode eval forms locally.
//
// Two engines are available:
//   * persistent (default): one `nodecode trial` process hosts a Unix-socket
//     REPL, so definitions, loaded files and warmed fasls survive across tool
//     calls in the same plugin process;
//   * one-shot (fallback): a fresh `nodecode trial` per form, used when the
//     persistent server cannot start.
//
// `nodecode trial` is the internal verb that reads Lisp from stdin and
// evaluates it in the full NodeCode image.  It silences the form's own
// output, so the server returns values over its socket as JSON lines.

import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getEvalServer } from "./eval-server.mjs"

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 120_000
const MAX_RESULT_CHARS = 32_000
// NodeCode's own yield window: 10s by default, 600s at most.  A form that is
// still running then keeps going in the image; the model polls it by id.
const DEFAULT_YIELD_MS = 10_000
const MAX_YIELD_MS = 600_000

export function nodecodeCandidates(env = process.env, home = homedir()) {
  const values = [
    env.NODECODE_BIN,
    join(home, ".local", "bin", "nodecode"),
    join(home, ".local", "share", "nodecode", "current", "nodecode"),
  ]
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))]
}

function lispString(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

function directoryPath(value) {
  try {
    return statSync(value).isDirectory() ? realpathSync(value) : ""
  } catch {
    return ""
  }
}

function pickBinary(env, home) {
  for (const candidate of nodecodeCandidates(env, home)) {
    if (candidate === "nodecode" || existsSync(candidate)) return candidate
  }
  return "nodecode"
}

function cap(text) {
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${text.slice(0, MAX_RESULT_CHARS)}\n… [truncated ${text.length - MAX_RESULT_CHARS} chars]`
}

function runningText({ evalId, output }) {
  const body = output ? `${output}\n` : ""
  return `${body}[running in the background · eval id ${evalId}]\nPoll it with eval: (magpie-eval-status ${evalId}), (magpie-eval-await ${evalId}), or stop it with (magpie-eval-interrupt ${evalId}).`
}

export function makeTrialForm(formFile, outFile) {
  return `(progn
  (let* ((text (uiop:read-file-string ${lispString(formFile)}))
         (result (multiple-value-list (eval-string text))))
    (with-open-file (s ${lispString(outFile)}
                        :direction :output
                        :if-exists :supersede
                        :external-format :utf-8)
      (write-string (if (second result)
                        (format nil "ERROR: ~a" (first result))
                        (or (first result) ""))
                    s)))
  0)`
}

async function runEvalFormOneShot(source, { cwd, timeoutMs, env, binary }) {
  const dir = mkdtempSync(join(tmpdir(), "nodecode-magpie-eval-"))
  const formFile = join(dir, "form.lisp")
  const outFile = join(dir, "out.txt")
  writeFileSync(formFile, source, "utf8")

  try {
    return await new Promise((resolve) => {
      let settled = false
      let stdout = ""
      let stderr = ""
      const child = spawn(binary, ["trial"], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      })

      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(cap(value))
      }

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {}
        finish(`ERROR: eval timed out after ${timeoutMs}ms`)
      }, timeoutMs)

      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk) => {
        stdout += chunk
      })
      child.stderr.on("data", (chunk) => {
        stderr += chunk
      })
      child.on("error", (error) => {
        finish(`ERROR: cannot run ${binary}: ${error.message}`)
      })
      child.on("close", (code) => {
        let output = ""
        try {
          output = readFileSync(outFile, "utf8")
        } catch {}
        if (code === 0) {
          finish(output.trimEnd() || "(no output)")
          return
        }
        const detail = (stderr || stdout).trim()
        finish(`ERROR: nodecode trial exited ${code}${detail ? `: ${detail}` : ""}`)
      })

      child.stdin.end(makeTrialForm(formFile, outFile))
    })
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

/**
 * Run one Common Lisp form through NodeCode.
 *
 * @param {string} form  Common Lisp source (one or more forms).
 * @param {{cwd?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv,
 *          persistent?: boolean, server?: boolean}} options
 * @returns {Promise<string>} printed value or `ERROR: ...`
 */
export async function runEvalForm(form, options = {}) {
  const raw = typeof form === "string" ? form.trim() : ""
  if (!raw) return "ERROR: eval requires a non-empty form"
  // eval-string takes the whole snippet: one or more toplevel forms, one =>
  // line each, the last value in full, and the snippet's own * and / history.
  const source = raw

  const env = options.env ?? process.env
  const home = env.NODECODE_HOME || env.HOME || homedir()
  const binary = pickBinary(env, home)
  const timeoutMs = Math.min(
    Math.max(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000),
    MAX_TIMEOUT_MS,
  )
  const yieldMs = Math.min(
    Math.max(Number(options.yieldMs) || DEFAULT_YIELD_MS, 0),
    MAX_YIELD_MS,
  )
  const cwd = directoryPath(options.cwd) || process.cwd()

  if (options.persistent === false) {
    return runEvalFormOneShot(source, { cwd, timeoutMs, env, binary })
  }

  try {
    const server = await getEvalServer({
      binary,
      cwd,
      env,
      scope: options.sessionId,
      startTimeoutMs: 15_000,
      lookHandler: options.lookRunner,
    })
    // An explicit timeout is the caller pinning a wall clock (tests, the
    // sparse tool path): wait, then interrupt.  Otherwise follow the CLI and
    // hand back a running envelope after the yield window.
    const pinned = Number(options.timeoutMs) > 0
    if (pinned) return cap(await server.run(source, timeoutMs))
    const result = await server.runWithYield(source, {
      yieldMs,
      strings: options.strings,
    })
    if (result.status === "exited") return cap(result.text)
    return cap(runningText(result))
  } catch (error) {
    // A timed-out form may still be running inside the image and could have
    // side effects (a build, a write).  Never replay it in a second process:
    // report the timeout and let the caller decide.
    if (/timed out/i.test(error.message)) return `ERROR: ${error.message}`
    // Any other server failure must not take the tool down: fall back to a
    // clean one-shot process and surface its more actionable error if needed.
    if (options.server === true) return `ERROR: ${error.message}`
    return runEvalFormOneShot(source, { cwd, timeoutMs, env, binary })
  }
}
