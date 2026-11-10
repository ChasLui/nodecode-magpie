// The free lane keeps one Lisp image per workspace/session.  Subagents and
// long-running hosts can accumulate images, so an idle image is closed after a
// TTL; its definitions are already in the history file and replay on rebuild.

import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import {
  closeEvalServers,
  getEvalServer,
  listEvalServers,
  sweepIdleServers,
} from "../lib/eval-server.mjs"

const historyDir = mkdtempSync(join(tmpdir(), "nodecode-magpie-idle-"))
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

test("an idle image is swept and its definitions replay", { skip }, async () => {
  const env = {
    ...process.env,
    NODECODE_MAGPIE_IDLE_MS: "50",
    NODECODE_MAGPIE_HISTORY: historyDir,
  }
  const scope = `idle-sweep-${process.pid}-${Date.now()}`
  const mine = () => listEvalServers().filter((entry) => entry.key.includes(scope))
  const first = await getEvalServer({ binary, cwd: tmpdir(), env, scope })
  await first.run("(defun idle-probe (x) (* x 3))", 20_000)
  assert.equal(mine().length, 1)

  await sweepIdleServers(Date.now() + 10_000)
  assert.equal(mine().length, 0)

  const second = await getEvalServer({ binary, cwd: tmpdir(), env, scope })
  assert.notEqual(first, second)
  assert.match(await second.run("(idle-probe 4)", 20_000), /12/)
})

test("a pending eval keeps its image alive", { skip }, async () => {
  const env = {
    ...process.env,
    NODECODE_MAGPIE_IDLE_MS: "50",
    NODECODE_MAGPIE_HISTORY: historyDir,
  }
  const scope = `idle-busy-${process.pid}-${Date.now()}`
  const mine = () => listEvalServers().filter((entry) => entry.key.includes(scope))
  const server = await getEvalServer({ binary, cwd: tmpdir(), env, scope })
  const pending = server.run('(progn (sh "sleep 2") "busy-done")', 20_000)
  await sweepIdleServers(Date.now() + 10_000)
  assert.equal(mine().length, 1)
  assert.match(await pending, /busy-done/)
  await sweepIdleServers(Date.now() + 10_000)
})
