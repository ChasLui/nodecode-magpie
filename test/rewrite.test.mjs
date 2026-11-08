import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  FREE_UA,
  PAID_UA,
  declareProvider,
  makeFetch,
  modelsFor,
  providerEntry,
  readKey,
} from "../lib/nodecode.mjs"

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => handler(req, res))
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

async function capture(fetchImpl, body, path = "/v1/chat/completions") {
  let seen = null
  const server = await listen((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      seen = { url: req.url, headers: req.headers, body: raw }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  try {
    await fetchImpl(`http://127.0.0.1:${server.address().port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  } finally {
    await close(server)
  }
  return seen
}

test("free lane sets the nodecode CLI User-Agent and removes every tool field", async () => {
  const seen = await capture(makeFetch({ free: true }), {
    model: "nodecode-cyber-v1",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "read_file" } }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    functions: [{ name: "legacy" }],
    function_call: "auto",
  })
  assert.equal(seen.headers["user-agent"], FREE_UA)
  const body = JSON.parse(seen.body)
  assert.equal(body.model, "nodecode-cyber-v1")
  for (const key of ["tools", "tool_choice", "parallel_tool_calls", "functions", "function_call"]) {
    assert.equal(key in body, false, `${key} leaked`)
  }
})

test("paid lane keeps tools and uses an honest magpie User-Agent", async () => {
  const seen = await capture(makeFetch({ free: false }), {
    model: "nodecode-cyber-v1",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "read_file" } }],
  })
  assert.equal(seen.headers["user-agent"], PAID_UA)
  const body = JSON.parse(seen.body)
  assert.equal(body.tools.length, 1)
})

test("free lane refuses a non chat-completions route before the vendor sees it", async () => {
  await assert.rejects(
    () => makeFetch({ free: true })("https://api.nodecode.ai/v1/responses", { method: "POST", body: "{}" }),
    /only supports POST \/v1\/chat\/completions/,
  )
})

test("static model metadata reflects the free/paid limits", () => {
  const free = modelsFor(true)["nodecode-cyber-v1"]
  const paid = modelsFor(false)["nodecode-cyber-v1"]
  assert.equal(free.limit.context, 262_144)
  assert.equal(paid.limit.context, 1_048_576)
  assert.equal(free.tool_call, false)
  assert.equal(paid.tool_call, true)
})

test("key lookup uses the documented env/auth.json/free-key.txt order", () => {
  const home = mkdtempSync(join(tmpdir(), "nodecode-plugin-test-"))
  mkdirSync(join(home, ".nodecode"))
  writeFileSync(
    join(home, ".nodecode", "auth.json"),
    JSON.stringify({ api_keys: { nodecode: { key: "paid-auth" }, "nodecode-free": { key: "free-auth" } } }),
  )
  writeFileSync(join(home, ".nodecode", "free-key.txt"), "free-file\n")
  assert.equal(readKey({ free: false, env: {}, home }), "paid-auth")
  assert.equal(readKey({ free: true, env: {}, home }), "free-auth")
  assert.equal(readKey({ free: true, env: { NODECODE_FREE_API_KEY: "free-env" }, home }), "free-env")
})
test("config merge keeps user provider settings and per-model overrides", () => {
  const cfg = {
    provider: {
      nodecode: {
        name: "My NodeCode",
        api: "http://127.0.0.1:8080/v1",
        models: {
          "nodecode-cyber-v1": { name: "My Cyber", limit: { context: 1234 } },
          "user-model": { name: "User Model", limit: { context: 42 } },
        },
      },
    },
  }
  declareProvider(cfg, "nodecode", providerEntry(false))
  assert.equal(cfg.provider.nodecode.name, "My NodeCode")
  assert.equal(cfg.provider.nodecode.api, "http://127.0.0.1:8080/v1")
  assert.equal(cfg.provider.nodecode.models["nodecode-cyber-v1"].name, "My Cyber")
  assert.equal(cfg.provider.nodecode.models["nodecode-cyber-v1"].limit.context, 1234)
  assert.equal(cfg.provider.nodecode.models["nodecode-cyber-v1"].limit.output, 131_072)
  assert.equal(cfg.provider.nodecode.models["user-model"].name, "User Model")
})

test("free key falls back to free-key.txt when auth.json has no key", () => {
  const home = mkdtempSync(join(tmpdir(), "nodecode-plugin-test-"))
  mkdirSync(join(home, ".nodecode"))
  writeFileSync(join(home, ".nodecode", "auth.json"), JSON.stringify({ api_keys: {} }))
  writeFileSync(join(home, ".nodecode", "free-key.txt"), "  free-file  \n")
  assert.equal(readKey({ free: true, env: {}, home }), "free-file")
  assert.equal(readKey({ free: false, env: {}, home }), "")
})

test("usage maps free and paid responses without inventing token windows", async () => {
  const { readUsage } = await import("../lib/nodecode.mjs")
  const free = await readUsage(async () => ({ key: "k" }), {
    free: true,
    fetchImpl: async () =>
      new Response(JSON.stringify({ pays: "free", balance: [] }), { status: 200 }),
  })
  assert.deepEqual(free, { plan: "Free", renew: "off", balance: "Free", windows: [] })

  const paid = await readUsage(async () => ({ key: "k" }), {
    free: false,
    fetchImpl: async () =>
      new Response(JSON.stringify({ pays: "balance", balance: [{ currency: "usd", micros: 4_000_000 }] }), {
        status: 200,
      }),
  })
  assert.deepEqual(paid, { plan: "Balance", renew: "off", balance: "$4.00", windows: [] })
})
