// Free-lane request/response bridge for NodeCode.
//
// A NodeCode free key only accepts a stateless, single-turn request: at most
// one system message followed by one final user message, and no tool history.
// Magpie, however, sends full multi-turn agent transcripts and native tools.
//
// This module collapses the transcript into one user message and, when tools
// are present, describes them to the model with a tiny JSON protocol. Responses
// that follow that protocol are converted back into native OpenAI tool_calls so
// magpie's agent loop sees the shape it expects.

const TOOL_PROTOCOL = `You are responding through an OpenAI-compatible gateway that currently has native function calling disabled.
When a tool is needed, answer with exactly one JSON object and no surrounding prose:
{"type":"tool_call","name":"<tool name>","arguments":{<arguments>}}
To call several tools at once:
{"type":"tool_calls","tool_calls":[{"name":"<tool name>","arguments":{<arguments>}}]}
Use only the tools listed below. Put every argument inside "arguments".
When no tool is needed, answer in plain text instead of JSON.

Available tools:
`

const CONTINUE_INSTRUCTION =
  "Continue from the last message as the assistant. If the task is unfinished, take the next step."

export function contentText(content) {
  if (typeof content === "string") return content
  if (content == null) return ""
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part?.type === "text" || part?.type === "input_text") return part.text ?? ""
        if (part?.type === "image_url" || part?.type === "input_image") return "[image omitted]"
        return ""
      })
      .join("")
  }
  if (typeof content === "object") return JSON.stringify(content)
  return String(content)
}

function normalizeParameters(parameters) {
  if (parameters && typeof parameters === "object") return parameters
  return { type: "object", properties: {} }
}

export function normalizeTools(body = {}) {
  const byName = new Map()
  const add = (tool) => {
    const fn = tool?.type === "function" ? tool.function : tool
    if (!fn || typeof fn.name !== "string" || fn.name.length === 0) return
    byName.set(fn.name, {
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: normalizeParameters(fn.parameters),
    })
  }
  if (Array.isArray(body.tools)) body.tools.forEach(add)
  if (Array.isArray(body.functions)) body.functions.forEach(add)
  return [...byName.values()]
}

function isSimpleTurn(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 2) return false
  let sawUser = false
  for (const message of messages) {
    if (message?.role === "system") continue
    if (message?.role !== "user") return false
    if (sawUser) return false
    sawUser = true
  }
  return sawUser
}

function systemText(messages) {
  return messages
    .filter((message) => message?.role === "system" || message?.role === "developer")
    .map((message) => contentText(message.content))
    .filter(Boolean)
    .join("\n\n")
}

function toolCallNameMap(messages) {
  const names = new Map()
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      if (call?.id && call?.function?.name) names.set(call.id, call.function.name)
    }
  }
  return names
}

export function serializeTranscript(messages) {
  const names = toolCallNameMap(messages)
  const lines = []
  for (const message of messages) {
    const role = message?.role
    if (!role || role === "system" || role === "developer") continue
    if (role === "user") {
      lines.push(`User: ${contentText(message.content)}`)
      continue
    }
    if (role === "assistant") {
      const text = contentText(message.content)
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      const rendered = calls
        .map((call) => {
          const name = call?.function?.name ?? call?.name ?? "unknown_tool"
          const args = call?.function?.arguments ?? call?.arguments ?? "{}"
          return `${name}(${typeof args === "string" ? args : JSON.stringify(args)})`
        })
        .join(", ")
      if (text && rendered) lines.push(`Assistant: ${text}\nAssistant tool calls: ${rendered}`)
      else if (rendered) lines.push(`Assistant tool calls: ${rendered}`)
      else lines.push(`Assistant: ${text}`)
      continue
    }
    if (role === "tool" || role === "function") {
      const name = names.get(message.tool_call_id) ?? message.name ?? "tool"
      lines.push(`Tool result (${name}): ${contentText(message.content)}`)
      continue
    }
    lines.push(`${role}: ${contentText(message.content)}`)
  }
  return { systems: messages.filter((m) => m?.role === "system").map((m) => contentText(m.content)), transcript: lines.join("\n\n") }
}

function toolCatalog(tools) {
  return tools.map((tool) => `- ${tool.name}: ${tool.description || "(no description)"}\n  parameters: ${JSON.stringify(tool.parameters)}`).join("\n")
}

export function rewriteFreeRequest(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const tools = normalizeTools(body)
  const toolChoiceNone = body.tool_choice === "none" || body.tool_choice?.type === "none"
  const wantsStream = body.stream === true
  const bridge = !isSimpleTurn(messages) || (tools.length > 0 && !toolChoiceNone)
  const system = systemText(messages)
  const { transcript } = serializeTranscript(messages)
  const useTools = tools.length > 0 && !toolChoiceNone

  const next = { ...body }
  delete next.tools
  delete next.tool_choice
  delete next.parallel_tool_calls
  delete next.functions
  delete next.function_call
  delete next.stream_options

  if (!bridge) {
    next.messages = messages
    return { body: next, bridge, tools: toolChoiceNone ? [] : tools, stream: wantsStream }
  }

  let user
  if (useTools) {
    user = `${TOOL_PROTOCOL}${toolCatalog(tools)}\n\nConversation so far:\n${transcript}\n\n${CONTINUE_INSTRUCTION}`
  } else {
    user = `The conversation is provided as a single transcript.\n\nConversation so far:\n${transcript}\n\n${CONTINUE_INSTRUCTION}`
  }
  const bridged = []
  if (system) bridged.push({ role: "system", content: system })
  bridged.push({ role: "user", content: user })
  next.messages = bridged
  next.stream = false

  return { body: next, bridge, tools: useTools ? tools : [], stream: wantsStream }
}

function parseJsonAt(text, start) {
  const open = text[start]
  const close = open === "{" ? "}" : "]"
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) {
        try {
          return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 }
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function jsonCandidates(text) {
  const found = []
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{" && text[i] !== "[") continue
    const parsed = parseJsonAt(text, i)
    if (!parsed) continue
    found.push(parsed.value)
    i = parsed.end - 1
  }
  return found
}

function singleCall(candidate, allowed) {
  if (!candidate || typeof candidate !== "object") return null
  const name = candidate.name ?? candidate.function?.name
  if (typeof name !== "string" || name.length === 0) return null
  if (allowed.size > 0 && !allowed.has(name)) return null
  let args = candidate.arguments ?? candidate.function?.arguments ?? candidate.parameters ?? candidate.input ?? {}
  if (typeof args === "string") {
    try {
      JSON.parse(args)
    } catch {
      args = { input: args }
    }
  }
  return {
    id: typeof candidate.id === "string" && candidate.id.length > 0 ? candidate.id : `call_nodecode_free_${Math.random().toString(36).slice(2, 12)}`,
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  }
}

export function parseToolCalls(text, tools = []) {
  const allowed = new Set(tools.map((tool) => tool.name))
  const calls = []
  for (const candidate of jsonCandidates(String(text ?? ""))) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const call = singleCall(item, allowed)
        if (call) calls.push(call)
      }
      continue
    }
    if (candidate.type === "tool_calls") {
      const list = candidate.tool_calls ?? candidate.calls
      if (Array.isArray(list)) {
        for (const item of list) {
          const call = singleCall(item, allowed)
          if (call) calls.push(call)
        }
      }
      continue
    }
    if (candidate.type === "tool_call" || (candidate.name && candidate.arguments !== undefined)) {
      const call = singleCall(candidate, allowed)
      if (call) calls.push(call)
    }
  }
  if (calls.length > 0) return { calls, content: null }
  return { calls: [], content: String(text ?? "") }
}

export function transformFreeResponse(data, plan = {}) {
  const tools = plan.tools ?? []
  const choices = Array.isArray(data?.choices) ? data.choices : []
  data.choices = choices.map((choice) => {
    const message = choice?.message ?? {}
    const parsed = parseToolCalls(contentText(message.content), tools)
    if (parsed.calls.length === 0) {
      return { ...choice, message: { ...message, role: "assistant" }, finish_reason: choice?.finish_reason ?? "stop" }
    }
    return {
      ...choice,
      message: { ...message, role: "assistant", content: parsed.content, tool_calls: parsed.calls },
      finish_reason: "tool_calls",
    }
  })
  return data
}

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

export function buildFreeSse(data, plan = {}) {
  const transformed = transformFreeResponse(data, plan)
  const id = transformed?.id ?? `chatcmpl-nodecode-free-${Date.now()}`
  const created = transformed?.created ?? Math.floor(Date.now() / 1000)
  const model = transformed?.model ?? plan.model ?? "nodecode-cyber-v1"
  const choice = transformed?.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const chunks = []
  const base = { id, object: "chat.completion.chunk", created, model }

  chunks.push(
    sseChunk({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    }),
  )

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    chunks.push(
      sseChunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })),
            },
            finish_reason: null,
          },
        ],
      }),
    )
    chunks.push(
      sseChunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        ...(transformed?.usage ? { usage: transformed.usage } : {}),
      }),
    )
  } else {
    const text = contentText(message.content)
    if (text) {
      chunks.push(
        sseChunk({
          ...base,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        }),
      )
    }
    chunks.push(
      sseChunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? "stop" }],
        ...(transformed?.usage ? { usage: transformed.usage } : {}),
      }),
    )
  }

  return new Response(`${chunks.join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  })
}

function jsonResponse(data, upstream) {
  const headers = new Headers(upstream.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.delete("transfer-encoding")
  headers.set("content-type", "application/json; charset=utf-8")
  return new Response(JSON.stringify(data), { status: upstream.status, statusText: upstream.statusText, headers })
}

export async function rewriteUpstreamResponse(response, plan) {
  if (!plan.bridge) return response
  const copy = response.clone()
  let data
  try {
    data = await response.json()
  } catch {
    return copy
  }
  const transformed = transformFreeResponse(data, plan)
  if (plan.stream) return buildFreeSse(transformed, plan)
  return jsonResponse(transformed, response)
}