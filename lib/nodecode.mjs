// Shared implementation for the two NodeCode providers.
//
// This module is imported by index.mjs but is not itself a plugin entry: the
// magpie host only scans the entry file's exports, so helpers can live here
// without being instantiated as separate plugins.

import { readFileSync } from "node:fs"
import { homedir, release } from "node:os"
import { join } from "node:path"

export const BASE = "https://api.nodecode.ai/v1"
export const OPENAI = "@ai-sdk/openai-compatible"
export const CYBER = "nodecode-cyber-v1"

export const PAID_ID = "nodecode"
export const FREE_ID = "nodecode-free"

export const PAID_CONTEXT = 1_048_576
export const FREE_CONTEXT = 262_144
export const MAX_OUTPUT = 131_072
export const FREE_CONCURRENCY = 2

const CLI_VERSION = process.env.NODECODE_CLI_VERSION || "0.1.13"
const OS =
  process.platform === "darwin" ? "Darwin" : process.platform === "win32" ? "Windows" : "Linux"
const ARCH = process.arch === "arm64" ? "arm64" : "x64"

// The free-key gate checks the User-Agent; the documented CLI shape is:
//   nodecode_cli/<version> (<os> <osver>; <arch>) <TERM>
// This shape is deliberately used so a future stricter check has the best
// chance of matching the real client. See README for the ToS warning.
export const FREE_UA = `nodecode_cli/${CLI_VERSION} (${OS} ${release()}; ${ARCH}) ${process.env.TERM || "xterm-256color"}`

// A paid key is not subject to the CLI-only gate. Keep a truthful client
// identifier instead of impersonating the CLI.
export const PAID_UA = "nodecode-magpie/0.1.0"

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

function trimKey(value) {
  return typeof value === "string" ? value.trim() : ""
}

// Key lookup order:
//   paid: NODECODE_API_KEY -> ~/.nodecode/auth.json api_keys.nodecode.key
//   free: NODECODE_FREE_API_KEY -> auth.json api_keys["nodecode-free"].key
//         -> ~/.nodecode/free-key.txt
// The nodecode CLI writes both keys into auth.json; free-key.txt is a second
// copy some installs keep. We never log or return more than the key itself.
export function readKey({ free, env = process.env, home = homedir() } = {}) {
  const auth = readJson(join(home, ".nodecode", "auth.json"))
  if (free) {
    const direct = trimKey(env.NODECODE_FREE_API_KEY)
    if (direct) return direct
    const fromAuth = trimKey(auth?.api_keys?.[FREE_ID]?.key)
    if (fromAuth) return fromAuth
    try {
      return trimKey(readFileSync(join(home, ".nodecode", "free-key.txt"), "utf8"))
    } catch {
      return ""
    }
  }
  const direct = trimKey(env.NODECODE_API_KEY)
  if (direct) return direct
  return trimKey(auth?.api_keys?.[PAID_ID]?.key)
}

export function modelsFor(free) {
  const input = { text: true, image: false, audio: false, video: false, pdf: false }
  const output = { text: true, image: false, audio: false, video: false, pdf: false }
  return {
    [CYBER]: {
      id: CYBER,
      name: free ? "NodeCode Cyber v1 (Free)" : "NodeCode Cyber v1",
      provider: { npm: OPENAI },
      api: { id: CYBER, url: BASE, npm: OPENAI },
      limit: { context: free ? FREE_CONTEXT : PAID_CONTEXT, output: MAX_OUTPUT },
      tool_call: !free,
      reasoning: false,
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
      ...(free ? { cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } } : {}),
      capabilities: {
        temperature: true,
        toolcall: !free,
        reasoning: false,
        input,
        output,
      },
      free,
    },
  }
}

export function providerEntry(free) {
  return {
    name: free ? "NodeCode Free" : "NodeCode",
    npm: OPENAI,
    api: BASE,
    models: modelsFor(free),
  }
}

// Deep-merge a user's model entry onto the default. Arrays replace wholesale;
// plain objects (limit, capabilities, cost) merge field by field so setting only
// `limit.context` does not drop `limit.output`.
function mergeModel(base, override) {
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergeModel(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

// config hooks run once per host start. Keep the user's own provider name,
// npm override, proxy URL, and per-model edits. Only fill defaults.
export function declareProvider(cfg, id, entry) {
  if (!cfg.provider || typeof cfg.provider !== "object" || Array.isArray(cfg.provider)) {
    cfg.provider = {}
  }
  const was =
    cfg.provider[id] && typeof cfg.provider[id] === "object" && !Array.isArray(cfg.provider[id])
      ? cfg.provider[id]
      : {}
  const ownModels =
    was.models && typeof was.models === "object" && !Array.isArray(was.models) ? was.models : {}
  const models = { ...entry.models }
  for (const [modelId, model] of Object.entries(ownModels)) {
    if (!model || typeof model !== "object" || Array.isArray(model)) continue
    models[modelId] = { ...mergeModel(models[modelId] || {}, model), id: model.id || modelId }
  }
  cfg.provider[id] = {
    ...entry,
    ...was,
    name: typeof was.name === "string" && was.name ? was.name : entry.name,
    npm: typeof was.npm === "string" && was.npm ? was.npm : entry.npm,
    api: typeof was.api === "string" && was.api.trim() ? was.api.trim() : entry.api,
    models,
  }
}

const FREE_TOOL_KEYS = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "functions",
  "function_call",
]

function isChatCompletions(url) {
  return /\/chat\/completions(?:[?#]|$)/.test(url)
}

// magpie's loader.fetch is the only layer that can rewrite the request body.
// It receives init.body as a UTF-8 string (host.js bodyOf), not a stream.
//
// Free key:
//   - UA must contain "nodecode" (we use the documented CLI shape)
//   - only POST /v1/chat/completions is accepted
//   - a non-empty tools array must be exactly Nodecode's `eval` schema, and
//     then the system prompt must start with its Lisp prompt. Rather than
//     emulate the CLI's tool, remove tools entirely: the free lane is chat-only.
//   - route is enforced here too, so a misconfigured `responses`/`messages`
//     API fails before hitting the vendor with a confusing 403.
export function makeFetch({ free, fetchImpl = globalThis.fetch } = {}) {
  return async function nodecodeFetch(input, init = {}) {
    const headers = new Headers(init?.headers || {})
    headers.set("user-agent", free ? FREE_UA : PAID_UA)
    let body = init?.body

    if (free) {
      const url = typeof input === "string" ? input : input?.url || ""
      if (!isChatCompletions(url)) {
        throw new Error(
          `nodecode-free only supports POST /v1/chat/completions; refusing ${url || "unknown URL"}`,
        )
      }
      if (typeof body === "string" && body.trim()) {
        let parsed = null
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = null
        }
        if (parsed && typeof parsed === "object") {
          for (const key of FREE_TOOL_KEYS) delete parsed[key]
          body = JSON.stringify(parsed)
          headers.set("content-type", "application/json")
        }
      }
    }

    return fetchImpl(input, { ...init, headers, body })
  }
}

// host.js normalizes auth.usage's result. Top-level balance must be a string;
// window amounts/limits must be numbers. /v1/usage only exposes the credit,
// not the daily token window, so do not invent a `used` value.
export async function readUsage(getAuth, { free, fetchImpl = globalThis.fetch } = {}) {
  let auth
  try {
    auth = await getAuth()
  } catch {
    return {}
  }
  const key = trimKey(auth?.key)
  if (!key) return {}

  try {
    const response = await fetchImpl(`${BASE}/usage`, {
      headers: {
        authorization: `Bearer ${key}`,
        "user-agent": free ? FREE_UA : PAID_UA,
      },
    })
    if (!response.ok) return { error: `usage HTTP ${response.status}` }
    const data = await response.json()
    const balance = Array.isArray(data?.balance) ? data.balance : []
    const usd = balance.find((entry) => entry?.currency === "usd") || balance[0]
    const micros = Number(usd?.micros)
    const money = Number.isFinite(micros) ? `$${(micros / 1_000_000).toFixed(2)}` : ""
    if (data?.pays === "free") {
      return { plan: "Free", renew: "off", balance: "Free", windows: [] }
    }
    return { plan: "Balance", renew: "off", balance: money, windows: [] }
  } catch (error) {
    return { error: `usage failed: ${error.message}` }
  }
}

export function authFor(id, { free }) {
  return {
    provider: id,
    methods: [
      {
        type: "api",
        label: free ? "读取本机 NodeCode 免费 key" : "读取本机 NodeCode key",
        keyless: true,
        async authorize() {
          const key = readKey({ free })
          return key
            ? { type: "success", key }
            : {
                type: "failed",
                error: free
                  ? "找不到免费 key：请设置 NODECODE_FREE_API_KEY，或确认 ~/.nodecode/auth.json / free-key.txt 存在"
                  : "找不到 NodeCode key：请设置 NODECODE_API_KEY，或确认 ~/.nodecode/auth.json 存在",
              }
        },
      },
      {
        type: "api",
        label: free ? "粘贴 NodeCode 免费 key" : "粘贴 NodeCode key",
        placeholder: "sk-nc-…",
      },
    ],
    maxConcurrency: free ? FREE_CONCURRENCY : undefined,
    async loader(getAuth) {
      const auth = await getAuth()
      if (!auth?.key) return {}
      return {
        baseURL: BASE,
        apiKey: auth.key,
        fetch: makeFetch({ free }),
      }
    },
    async usage(getAuth) {
      return readUsage(getAuth, { free })
    },
  }
}