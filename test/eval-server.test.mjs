// The persistent eval service is what makes the free lane behave like the
// NodeCode CLI: definitions survive between tool calls, a slow shell command
// does not block the next one, and a timeout interrupts only that form instead
// of discarding the image.  These tests drive a real `nodecode trial` process,
// so they are skipped when the binary is not installed.

import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { makeServerForm, closeEvalServers } from "../lib/eval-server.mjs"
import { runEvalForm } from "../lib/eval-runner.mjs"

// Keep the definition history out of the real home directory during tests.
const historyDir = mkdtempSync(join(tmpdir(), "nodecode-magpie-history-"))
process.env.NODECODE_MAGPIE_HISTORY = historyDir
test.after(async () => {
  await closeEvalServers()
  rmSync(historyDir, { recursive: true, force: true })
})

function nodecodeBinary() {
  const candidates = [
    process.env.NODECODE_BIN,
    join(homedir(), ".local", "bin", "nodecode"),
    join(homedir(), ".local", "share", "nodecode", "current", "nodecode"),
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

const binary = nodecodeBinary()
const skip = binary ? false : "nodecode is not installed"

test("makeServerForm injects the eval and look socket paths", () => {
  const form = makeServerForm("/tmp/example/eval.sock", "/tmp/example/look.sock")
  assert.doesNotMatch(form, /__MAGPIE_SOCKET__/)
  assert.doesNotMatch(form, /__MAGPIE_LOOK_SOCKET__/)
  assert.match(form, /"\/tmp\/example\/eval\.sock"/)
  assert.match(form, /"\/tmp\/example\/look\.sock"/)
})

test("definitions survive across eval calls", { skip }, async () => {
  const env = { ...process.env, NODECODE_BIN: binary }
  const defined = await runEvalForm("(defun magpie-persist (x) (* x 7))", { env })
  assert.match(defined, /MAGPIE-PERSIST/)
  const called = await runEvalForm("(magpie-persist 6)", { env })
  assert.match(called, /42/)
  await closeEvalServers()
})

test("session scopes do not share definitions", { skip }, async () => {
  const env = { ...process.env, NODECODE_BIN: binary }
  const defined = await runEvalForm("(defun magpie-scope-probe (x) (+ x 1))", {
    env,
    sessionId: "scope-test-a",
  })
  assert.match(defined, /MAGPIE-SCOPE-PROBE/)
  assert.equal(await runEvalForm("(magpie-scope-probe 41)", { env, sessionId: "scope-test-a" }), "42")
  const other = await runEvalForm("(magpie-scope-probe 41)", { env, sessionId: "scope-test-b" })
  assert.match(other, /UNDEFINED-FUNCTION/)
  await closeEvalServers()
})

test("a slow form does not block the next eval", { skip }, async () => {
  const env = { ...process.env, NODECODE_BIN: binary }
  const slow = runEvalForm('(progn (sleep 4) "slow-finished")', { env, timeoutMs: 30_000 })
  await new Promise((resolve) => setTimeout(resolve, 400))
  const started = Date.now()
  const fast = await runEvalForm('(sh "echo fast-path")', { env, timeoutMs: 30_000 })
  const elapsed = Date.now() - started
  assert.match(fast, /fast-path/)
  // The slow form still owns the image for seconds; the fast one must not wait.
  assert.ok(elapsed < 3_000, `fast eval waited ${elapsed}ms behind the slow form`)
  assert.match(await slow, /slow-finished/)
  await closeEvalServers()
})

test("a timeout interrupts the form but keeps the image usable", { skip }, async () => {
  const env = { ...process.env, NODECODE_BIN: binary }
  const timedOut = await runEvalForm('(sh "sleep 30")', { env, timeoutMs: 1_200 })
  assert.match(timedOut, /ERROR: eval timed out/)
  const after = await runEvalForm('(sh "echo still-alive")', { env, timeoutMs: 30_000 })
  assert.match(after, /still-alive/)
  await closeEvalServers()
})

test("a form past its yield window becomes a pollable background eval", { skip }, async () => {
  const env = process.env
  const started = await runEvalForm('(progn (sleep 3) "background-done")', {
    env,
    yieldMs: 300,
  })
  assert.match(started, /running in the background · eval id \d+/)
  const id = started.match(/eval id (\d+)/)[1]

  const status = await runEvalForm(`(magpie-eval-status ${id})`, { env, yieldMs: 5_000 })
  assert.match(status, /^eval \d+: running$/m)

  const awaited = await runEvalForm(`(magpie-eval-await ${id} :until-exit t)`, {
    env,
    yieldMs: 10_000,
  })
  assert.match(awaited, /^eval \d+: exited$/m)
  assert.match(awaited, /value: background-done/)
})

test("the strings side channel feeds ($ \"name\")", { skip }, async () => {
  const env = process.env
  const value = await runEvalForm('($ "greeting")', {
    env,
    yieldMs: 5_000,
    strings: { greeting: "hello-from-strings" },
  })
  assert.equal(value, "hello-from-strings")
})

test("a snippet keeps the CLI's per-form => lines and * / history", { skip }, async () => {
  const env = process.env
  const multi = await runEvalForm("(+ 1 2) (+ 3 4)", { env, yieldMs: 5_000 })
  assert.equal(multi, "=> 3\n=> 7")
  assert.equal(await runEvalForm("*", { env, yieldMs: 5_000 }), "7")
  assert.equal(await runEvalForm('(format nil "~s" /)', { env, yieldMs: 5_000 }), "(7)")
})


test("a form can call (look ...) and reach the vision handler", { skip }, async () => {
  const env = { ...process.env, NODECODE_BIN: binary }
  const seen = []
  const defined = await runEvalForm('(defun look-probe (x) (+ x 1))', { env, sessionId: "look-probe" })
  assert.match(defined, /LOOK-PROBE/)
  const called = await runEvalForm('(look-probe 41)', { env, sessionId: "look-probe" })
  assert.match(called, /42/)
  const result = await runEvalForm('(list "before" (look "/tmp/pic.png" :prompt "read the card"))', {
    env,
    sessionId: "look-probe",
    lookRunner: async (args) => {
      seen.push(args)
      return "LOOK-LISP-OK"
    },
  })
  assert.match(result, /LOOK-LISP-OK/)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].path, "/tmp/pic.png")
  assert.equal(seen[0].prompt, "read the card")
  await closeEvalServers()
})
