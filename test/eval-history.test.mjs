// A plugin-host restart drops the Lisp image.  NodeCode's CLI keeps `defun`
// and friends in a layer, so the free lane keeps the same definition forms in
// a per-session history file and replays them into a fresh image.  Shell
// commands and other side effects are deliberately not replayed.

import test, { after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { closeEvalServers, dropEvalServer, definitionForms, topLevelForms } from "../lib/eval-server.mjs"
import { runEvalForm } from "../lib/eval-runner.mjs"

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
const historyDir = mkdtempSync(join(tmpdir(), "nodecode-magpie-history-"))
const env = { ...process.env, NODECODE_BIN: binary, NODECODE_MAGPIE_HISTORY: historyDir }

after(async () => {
  await closeEvalServers()
  rmSync(historyDir, { recursive: true, force: true })
})

test("only definition forms are kept", () => {
  assert.deepEqual(topLevelForms('(defun f (x) (+ x 1)) (sh "echo hi")'), [
    "(defun f (x) (+ x 1))",
    '(sh "echo hi")',
  ])
  assert.deepEqual(definitionForms('(defun f (x) (+ x 1)) (sh "echo hi")'), [
    "(defun f (x) (+ x 1))",
  ])
  assert.deepEqual(definitionForms('(sh "echo hi")'), [])
  assert.deepEqual(definitionForms("(defparameter *x* \"a ; b\")"), ['(defparameter *x* "a ; b")'])
})

test("definitions replay into a fresh image but side effects do not", { skip }, async () => {
  const scope = `history-${Date.now()}`
  const defined = await runEvalForm("(defun magpie-history-fn (x) (+ x 100))", {
    env,
    scope,
    yieldMs: 5_000,
  })
  assert.match(defined, /MAGPIE-HISTORY-FN/)

  const marked = await runEvalForm('(sh "echo side-effect-marker")', { env, scope, yieldMs: 5_000 })
  assert.match(marked, /side-effect-marker/)

  const files = readdirSync(historyDir).filter((name) => name.endsWith(".jsonl"))
  assert.equal(files.length, 1)
  const history = readFileSync(join(historyDir, files[0]), "utf8")
  assert.match(history, /magpie-history-fn/)
  assert.doesNotMatch(history, /side-effect-marker/)

  await dropEvalServer({ env, scope })
  const replayed = await runEvalForm("(magpie-history-fn 1)", { env, scope, yieldMs: 5_000 })
  assert.match(replayed, /101/)
})
