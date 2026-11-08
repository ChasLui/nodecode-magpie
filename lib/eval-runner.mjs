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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getEvalServer } from "./eval-server.mjs"

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 120_000
const MAX_RESULT_CHARS = 32_000

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
  // eval-string reads ONE form.  Wrap so a model that puts several top-level
  // forms in one eval call still gets all of them evaluated in order.
  const source = `(progn ${raw})`

  const env = options.env ?? process.env
  const home = env.NODECODE_HOME || env.HOME || homedir()
  const binary = pickBinary(env, home)
  const timeoutMs = Math.min(
    Math.max(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000),
    MAX_TIMEOUT_MS,
  )
  const cwd = options.cwd && existsSync(options.cwd) ? options.cwd : process.cwd()

  if (options.persistent === false) {
    return runEvalFormOneShot(source, { cwd, timeoutMs, env, binary })
  }

  try {
    const server = await getEvalServer({ binary, cwd, env, startTimeoutMs: 15_000 })
    const value = await server.request(source, timeoutMs)
    return cap(value)
  } catch (error) {
    // A persistent server failure must not take the tool down: fall back to a
    // clean one-shot process and surface its more actionable error if needed.
    if (options.server === true) return `ERROR: ${error.message}`
    return runEvalFormOneShot(source, { cwd, timeoutMs, env, binary })
  }
}
