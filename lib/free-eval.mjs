// Free-lane agent bridge built around NodeCode's native `eval` tool.
//
// The free key has five server-side checks.  When a request carries tools the
// vendor requires exactly one tool named `eval` with NodeCode's own schema, and
// the system message must start with the four-line NodeCode prompt.  This
// module satisfies those checks honestly and turns the free lane into a real
// agent: the model calls `eval`, the plugin executes the form in the local
// NodeCode image with `nodecode trial`, and the loop continues until the model
// produces an answer.
//
// Client tools (read_file/write_file/bash/...) cannot be sent to the vendor,
// so they are described in the system prompt and carried through eval:
//
//   (magpie-tool "read_file" "{\"path\":\"/tmp/a\"}")
//
// The plugin turns those eval calls back into normal OpenAI tool_calls for the
// magpie client.  Direct eval forms such as `(sh "ls")`, `(write-file ...)` and
// `(edit ...)` run locally in the full NodeCode image.

import { contentText, normalizeTools, parseToolCalls } from "./free-bridge.mjs"
import { runEvalForm } from "./eval-runner.mjs"
import { describeImage, parseLookArguments } from "./vision.mjs"

export const LISP_PREFIX = `You are a living Common Lisp image, an organism that adapts to its environment (the operator and their work) through mutation and selection, so each task leaves you fitter for the next.
eval runs forms in you, what you define persists across boots, and (help) is your manual.
Most tokens go to finding things out, so spend them once: reuse before you rebuild, define what will recur, remove what no longer fits, and prefer one form that answers over several that probe.
Keep the operator posted, briefly, as you go: what you found, what's next.
In this lane the image lives as long as the client session: definitions and files persist while it runs. NodeCode's (look ...) is bridged by the client to a vision model, so use it exactly like the CLI when an image matters.`

// A turn may need many eval round-trips (read, inspect, edit, test, repeat).
// Six was too tight for real repository work; the CLI itself does not cut a
// turn at six.  Keep a bound so a broken model cannot spin forever.
export const DEFAULT_MAX_ROUNDS = 32

export const EVAL_TOOL = {
  type: "function",
  function: {
    name: "eval",
    description:
      "Evaluate Common Lisp forms in the live NodeCode image and return their printed values. " +
      '(sh "ls -la") runs a shell command; (edit path old new) replaces text; ' +
      '(write-file path text) writes a file; (look path :prompt "question") is bridged to a vision model.',
    parameters: {
      type: "object",
      properties: {
        form: {
          type: "string",
          description: "One or more Common Lisp forms, evaluated in order.",
        },
        yield_time_ms: {
          type: "integer",
          description: "Milliseconds to wait before the form continues in the background.",
        },
        strings: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Named literal texts sent beside the form, read with ($ \"name\").",
        },
      },
      required: ["form"],
    },
  },
}

const TOOL_PROTOCOL = `You act through the eval tool, exactly as the NodeCode CLI does.
Call eval with Common Lisp forms.  The image is persistent for this session:
definitions made by one eval call are available to the next.  Built-in helpers:
  (sh "command")                 run a shell command, return stdout+stderr
  (sh (list "git" "status"))     run a program without a shell
  (write-file "path" "text")     write a whole file
  (edit "path" "old" "new")      replace one occurrence in a file
  ($ "name")                     read a string from the eval tool's strings object
The image runs in the client agent's workspace: (sh "pwd") starts there.
The NodeCode manual is available too:
  (help)                         list the image's verbs and topics
  (help 'sh) / (help :eval)      read one verb or topic
  (slash "/status")              headless CLI commands such as /status,
  (slash "/models")              /models, /usage, /doctor, /cells and /help
This trial image has no NodeCode session: (fork ...), (define-memory ...) and
(define-skill ...) need a session and are unavailable here; use the client's
subagent or memory tools when it offers them.
Long forms: eval waits yield_time_ms (default 10s) and then answers
"running in the background · eval id N" instead of killing the work.  Poll that
id with (magpie-eval-status N), wait with (magpie-eval-await N :until-exit t),
or stop it with (magpie-eval-interrupt N).
A finished background eval is written to a log the plugin keeps per session, so
(magpie-eval-log) still lists it after the plugin host restarts and the image is
rebuilt.
Keep the operator posted briefly, then act.

Call the "eval" tool with its arguments object; never write a tool call as
text and never wrap one in XML such as <tool_call>...</tool_call>.  The argument
that carries the code is "form": {"form": "(sh \"ls -la\")"}.  Shell commands
must be wrapped as (sh "...") inside form.

The client's own tools are not exposed as native functions in this lane.
"magpie-tool" is NOT a tool you can call directly; the only native tool is
"eval".  To call a client tool, call "eval" with this form:
  (magpie-tool "tool_name" "json-arguments")
where json-arguments is a JSON object string.  The client executes it and sends
the result back as a normal tool result.  Do not emit a tool call named
"magpie-tool"; do not wrap the form in prose; do not add a second form.

Images: this text-only model cannot see images, so call (look ...) in Lisp:
  (look "relative/or/absolute.png" :prompt "optional question")
The client sends the image to a vision model and returns its description as the
eval result.  Relative paths resolve against the workspace.  Ask for exact
visible text when it matters.  The older carrier
(magpie-tool "look" "{\"path\":\"...\",\"prompt\":\"...\"}") also works.

Client tools:
`

function systemText(messages) {
  return messages
    .filter((message) => message?.role === "system" || message?.role === "developer")
    .map((message) => contentText(message.content))
    .filter(Boolean)
    .join("\n\n")
}

function toolCatalog(tools) {
  return tools
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description || "(no description)"}\n  parameters: ${JSON.stringify(tool.parameters)}`,
    )
    .join("\n")
}

function lispString(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

function argumentsText(value) {
  if (typeof value === "string") return value
  if (value == null) return "{}"
  try {
    return JSON.stringify(value)
  } catch {
    return "{}"
  }
}

export function magpieToolForm(name, args) {
  return `(magpie-tool ${lispString(name)} ${lispString(argumentsText(args))})`
}

/**
 * Rewrite a magpie request for the free eval lane.
 * The returned body is a normal OpenAI chat-completions body with exactly one
 * tool (`eval`).  All original messages are preserved, but assistant tool calls
 * are translated to eval calls that carry (magpie-tool ...) forms.
 */
export function makeEvalRequest(body = {}, tools = normalizeTools(body)) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const system = systemText(messages)
  const nextMessages = []
  const systemParts = [LISP_PREFIX]
  if (system) systemParts.push(`The client's original instructions:\n${system}`)
  systemParts.push(`${TOOL_PROTOCOL}${toolCatalog(tools)}`)
  nextMessages.push({ role: "system", content: systemParts.join("\n\n") })

  for (const message of messages) {
    const role = message?.role
    if (!role || role === "system" || role === "developer") continue
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      nextMessages.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.tool_calls.map((call) => {
          const name = call?.function?.name ?? call?.name ?? "unknown_tool"
          const args = call?.function?.arguments ?? call?.arguments ?? "{}"
          return {
            id: call?.id ?? `call_nodecode_free_${Math.random().toString(36).slice(2, 12)}`,
            type: "function",
            function: {
              name: "eval",
              arguments: JSON.stringify({ form: magpieToolForm(name, args) }),
            },
          }
        }),
      })
      continue
    }
    nextMessages.push(message)
  }

  const next = { ...body, model: "nodecode-cyber-v1", messages: nextMessages }
  delete next.tools
  delete next.functions
  delete next.function_call
  delete next.tool_choice
  delete next.parallel_tool_calls
  delete next.stream_options
  next.tools = [EVAL_TOOL]
  next.tool_choice = "auto"
  next.stream = false
  return { body: next, mode: "eval", tools, stream: body.stream === true, bridge: true }
}

function parseDirectMagpieTool(call) {
  const name = call?.function?.name
  if (name !== "magpie-tool" && name !== "magpie_tool") return null
  let args = call?.function?.arguments ?? call?.arguments
  if (typeof args === "string") {
    try {
      args = JSON.parse(args)
    } catch {
      return null
    }
  }
  if (!args || typeof args !== "object") return null
  const toolName = args.tool_name ?? args.toolName ?? args.name ?? args.tool
  if (typeof toolName !== "string" || !toolName) return null
  const raw =
    args["json-arguments"] ?? args.jsonArguments ?? args.arguments ?? args.args ?? args.parameters ?? {}
  const text = typeof raw === "string" ? raw : JSON.stringify(raw)
  return {
    id: call?.id ?? `call_nodecode_free_${Math.random().toString(36).slice(2, 12)}`,
    type: "function",
    function: { name: toolName, arguments: text },
  }
}

function lispQuote(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

const LISP_ARG_KEYS = ["form", "code", "lisp", "expr", "expression", "source"]
const SHELL_ARG_KEYS = ["cmd", "command", "shell", "script", "bash"]

/**
 * Turn an eval tool call's arguments into a Common Lisp form.
 *
 * NodeCode's own CLI always sends `form`, but models routinely invent
 * `cmd`/`command` when they mean a shell command.  Accepting those aliases
 * keeps the free lane working instead of failing with a Lisp reader error.
 */
export function evalFormFromArguments(args) {
  if (!args || typeof args !== "object") return null
  const yieldTimeMs = Number(args.yield_time_ms) || undefined
  const strings = evalStrings(args.strings)
  for (const key of LISP_ARG_KEYS) {
    const value = args[key]
    if (typeof value === "string" && value.trim()) {
      return { form: value, yieldTimeMs, strings }
    }
  }
  for (const key of SHELL_ARG_KEYS) {
    const value = args[key]
    if (typeof value === "string" && value.trim()) {
      return { form: `(sh ${lispQuote(value)})`, yieldTimeMs, strings }
    }
  }
  return null
}

/** Keep only the named literals ($ "name" reads) that are actually strings. */
function evalStrings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter(([, text]) => typeof text === "string")
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function parseEvalArguments(call) {
  let args = call?.function?.arguments ?? call?.arguments
  if (typeof args === "string") {
    try {
      args = JSON.parse(args)
    } catch {
      return null
    }
  }
  if (!args || typeof args !== "object") return null
  return evalFormFromArguments(args)
}

/**
 * Collect the tool calls a model actually produced.
 *
 * Some responses come back as native `tool_calls`, others as text such as
 * `<tool_call>{"name":"eval","arguments":{"cmd":"..."}}</tool_call>` (the free
 * lane forces `stream:false`, so the model sometimes writes the call into the
 * content instead of using the tool_calls field).  Both shapes must work.
 */
export function messageCalls(message, tools = []) {
  const native = Array.isArray(message?.tool_calls)
    ? message.tool_calls.filter((call) => typeof call?.function?.name === "string")
    : []
  if (native.length > 0) return native
  const text = contentText(message?.content)
  if (!text) return []
  const allowed = [
    ...tools.map((tool) => tool.name),
    "eval",
    "magpie-tool",
    "magpie_tool",
    "look",
  ].map((name) => ({ name }))
  return parseToolCalls(text, allowed).calls
}

function unescapeLispString(value) {
  return value.replace(/\\([\s\S])/g, "$1")
}

export function parseMagpieToolForm(form) {
  const match = /^\s*\(\s*magpie-tool\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"\s*\)\s*$/s.exec(
    String(form ?? ""),
  )
  if (!match) return null
  const name = unescapeLispString(match[1])
  const rawArgs = unescapeLispString(match[2])
  let args = rawArgs
  try {
    const parsed = JSON.parse(rawArgs)
    if (parsed && typeof parsed === "object") args = JSON.stringify(parsed)
  } catch {}
  return { name, arguments: args }
}

export function splitEvalCalls(calls) {
  const clientCalls = []
  const direct = []
  for (const call of Array.isArray(calls) ? calls : []) {
    const parsed = parseEvalArguments(call)
    if (!parsed) continue
    const tool = parseMagpieToolForm(parsed.form)
    if (tool) {
      clientCalls.push({
        id: call?.id ?? `call_nodecode_free_${Math.random().toString(36).slice(2, 12)}`,
        type: "function",
        function: { name: tool.name, arguments: tool.arguments },
      })
    } else {
      direct.push({ call, ...parsed })
    }
  }
  return { clientCalls, direct }
}

const LOOK_TOOL_NAMES = new Set(["look", "read_image", "describe_image"])

function isLookCall(call) {
  const name = call?.function?.name
  return typeof name === "string" && LOOK_TOOL_NAMES.has(name)
}

function lookResultText(value) {
  if (typeof value === "string") return value
  if (value == null) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function jsonResponse(data, upstream) {
  const headers = new Headers(upstream.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.delete("transfer-encoding")
  headers.set("content-type", "application/json; charset=utf-8")
  return new Response(JSON.stringify(data), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

export function buildEvalSse(data, plan = {}) {
  const transformed = transformEvalResponse(data, plan)
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
            delta: { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) },
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

export function transformEvalResponse(data, plan = {}) {
  const tools = plan.tools ?? []
  const choices = Array.isArray(data?.choices) ? data.choices : []
  data.choices = choices.map((choice) => {
    const message = choice?.message ?? {}
    const calls = messageCalls(message, tools)
    const evalCalls = calls.filter((call) => call?.function?.name === "eval")
    if (evalCalls.length > 0) {
      const { clientCalls } = splitEvalCalls(evalCalls)
      if (clientCalls.length > 0) {
        return {
          ...choice,
          message: { ...message, role: "assistant", content: message.content ?? null, tool_calls: clientCalls },
          finish_reason: "tool_calls",
        }
      }
    }
    const directMagpie = calls.map(parseDirectMagpieTool).filter(Boolean)
    if (directMagpie.length > 0) {
      return {
        ...choice,
        message: { ...message, role: "assistant", content: message.content ?? null, tool_calls: directMagpie },
        finish_reason: "tool_calls",
      }
    }
    // Direct eval calls (or anything else the model emitted) stay visible to
    // the caller instead of being silently downgraded to plain text.
    if (calls.length > 0) {
      return {
        ...choice,
        message: { ...message, role: "assistant", tool_calls: calls },
        finish_reason: "tool_calls",
      }
    }
    const parsed = parseToolCalls(contentText(message.content), tools)
    if (parsed.calls.length > 0) {
      return {
        ...choice,
        message: { ...message, role: "assistant", content: parsed.content, tool_calls: parsed.calls },
        finish_reason: "tool_calls",
      }
    }
    return { ...choice, message: { ...message, role: "assistant" } }
  })
  return data
}

function finalize(data, upstream, plan) {
  const transformed = transformEvalResponse(data, plan)
  if (plan.stream) return buildEvalSse(transformed, plan)
  return jsonResponse(transformed, upstream)
}

/**
 * Run the free eval agent loop.  Each iteration sends one request to the
 * upstream free endpoint.  Direct eval calls run locally and are returned to
 * the model as tool results.  When the model asks for a client tool, the loop
 * stops and returns that native tool_call to magpie.
 */
export async function handleEvalRequest({
  input,
  init,
  headers,
  body,
  plan,
  fetchImpl,
  evalRunner = runEvalForm,
  lookRunner = describeImage,
  maxRounds = DEFAULT_MAX_ROUNDS,
}) {
  let messages = Array.isArray(body.messages) ? body.messages : []
  let lastResponse = null
  let lastData = null

  for (let round = 0; round < maxRounds; round += 1) {
    const requestBody = { ...body, messages }
    lastResponse = await fetchImpl(input, { ...init, headers, body: JSON.stringify(requestBody) })
    if (!lastResponse.ok) return lastResponse
    try {
      lastData = await lastResponse.json()
    } catch {
      return lastResponse
    }
    const choice = lastData?.choices?.[0] ?? {}
    const message = choice.message ?? {}
    const calls = messageCalls(message, plan.tools ?? [])
    const evalCalls = calls.filter((call) => call?.function?.name === "eval")
    const rawLookCalls = calls.filter(isLookCall).map((call) => ({
      ...call,
      id: call?.id ?? `call_nodecode_free_${Math.random().toString(36).slice(2, 12)}`,
    }))
    // A native `look` call is not part of the free vendor's schema (its only
    // tool is eval).  Normalize it to an eval call before feeding the
    // assistant turn back upstream, while keeping the original arguments for
    // the local vision runner.
    const nativeLookCalls = rawLookCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: "eval",
        arguments: JSON.stringify({
          form: `(magpie-tool "look" ${lispString(argumentsText(call?.function?.arguments))})`,
        }),
      },
    }))
    if (evalCalls.length === 0 && rawLookCalls.length === 0) {
      return finalize(lastData, lastResponse, plan)
    }
    const { clientCalls, direct } = splitEvalCalls(evalCalls)
    // `look` is handled inside this loop so the free model receives the image
    // description as a tool result instead of handing it to the client.  The
    // model may call it directly or through (magpie-tool "look" ...).
    const lookFromEval = clientCalls.filter(isLookCall)
    const remainingClientCalls = clientCalls.filter((call) => !isLookCall(call))
    const lookCalls = [...rawLookCalls, ...lookFromEval]
    if (remainingClientCalls.length > 0 && direct.length === 0 && lookCalls.length === 0) {
      message.tool_calls = remainingClientCalls
      message.content = message.content ?? null
      if (lastData.choices?.[0]) lastData.choices[0].finish_reason = "tool_calls"
      return finalize(lastData, lastResponse, plan)
    }

    // Direct eval calls run locally, then the model sees their results.
    // Drop the model's text when it was only a serialized tool call, so the
    // transcript does not accumulate fake assistant prose.
    const leftoverText = calls.length > 0 && parseToolCalls(contentText(message.content), [{ name: "eval" }]).calls.length > 0
      ? null
      : message.content ?? null
    messages = [
      ...messages,
      {
        role: "assistant",
        content: leftoverText,
        tool_calls: [...evalCalls, ...nativeLookCalls],
      },
    ]
    for (const item of direct) {
      const result = await evalRunner(item.form, {
        yieldMs: item.yieldTimeMs,
        strings: item.strings,
        cwd: plan.cwd,
        sessionId: plan.sessionId,
        lookRunner,
      })
      messages.push({
        role: "tool",
        tool_call_id: item.call?.id ?? `call_nodecode_free_${Math.random().toString(36).slice(2, 12)}`,
        content: result,
      })
    }
    for (const call of lookCalls) {
      let content
      try {
        const args = parseLookArguments(call?.function?.arguments)
        if (!args) throw new Error('look needs {"path":"..."}')
        content = lookResultText(
          await lookRunner({ path: args.path, prompt: args.prompt, cwd: plan.cwd }),
        )
      } catch (error) {
        content = `ERROR: ${error.message}`
      }
      messages.push({
        role: "tool",
        tool_call_id: call?.id ?? `call_nodecode_free_${Math.random().toString(36).slice(2, 12)}`,
        content,
      })
    }
    // If the model mixed client and direct calls, report the remaining client
    // calls after running the direct/look calls.  This keeps both paths alive.
    if (remainingClientCalls.length > 0) {
      lastData.choices[0].message = {
        ...message,
        content: message.content ?? null,
        tool_calls: remainingClientCalls,
      }
      lastData.choices[0].finish_reason = "tool_calls"
      return finalize(lastData, lastResponse, plan)
    }
  }

  return new Response(
    JSON.stringify({
      error: {
        message: `nodecode-free eval loop exceeded ${maxRounds} rounds`,
        type: "nodecode_free_eval_loop",
      },
    }),
    { status: 502, headers: { "content-type": "application/json" } },
  )
}
