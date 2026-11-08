import assert from "node:assert/strict"
import test from "node:test"

import {
  buildFreeSse,
  contentText,
  normalizeTools,
  parseToolCalls,
  rewriteFreeRequest,
  serializeTranscript,
  transformFreeResponse,
} from "../lib/free-bridge.mjs"
import { makeFetch } from "../lib/nodecode.mjs"

const readFile = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a text file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
}

test("contentText flattens text parts and marks non-text parts", () => {
  assert.equal(contentText("hello"), "hello")
  assert.equal(
    contentText([
      { type: "text", text: "look " },
      { type: "image_url", image_url: { url: "data:..." } },
      { type: "text", text: "now" },
    ]),
    "look [image omitted]now",
  )
})

test("simple system+user free request passes through unchanged", () => {
  const plan = rewriteFreeRequest({
    model: "nodecode-cyber-v1",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ],
  })
  assert.equal(plan.bridge, false)
  assert.equal(plan.body.messages.length, 2)
  assert.equal(plan.body.messages[1].content, "hi")
  assert.equal(plan.body.stream, undefined)
})

test("multi-turn free request is collapsed into system+user", () => {
  const plan = rewriteFreeRequest({
    model: "nodecode-cyber-v1",
    stream: true,
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: "I will read it." },
      { role: "user", content: "what did it say?" },
    ],
  })
  assert.equal(plan.bridge, true)
  assert.equal(plan.stream, true)
  assert.equal(plan.body.stream, false)
  assert.equal(plan.body.messages.length, 2)
  assert.equal(plan.body.messages[0].content, "You are a coding agent.")
  assert.match(plan.body.messages[1].content, /single transcript/)
  assert.match(plan.body.messages[1].content, /User: read a\.txt/)
  assert.match(plan.body.messages[1].content, /Assistant: I will read it\./)
  assert.match(plan.body.messages[1].content, /User: what did it say\?/)
})

test("free request with tools is bridged and the tools array is removed", () => {
  const plan = rewriteFreeRequest({
    model: "nodecode-cyber-v1",
    messages: [{ role: "user", content: "read /tmp/a" }],
    tools: [readFile],
    tool_choice: "auto",
  })
  assert.equal(plan.bridge, true)
  assert.equal(plan.tools.length, 1)
  assert.equal(plan.tools[0].name, "read_file")
  assert.equal("tools" in plan.body, false)
  assert.equal("tool_choice" in plan.body, false)
  assert.match(plan.body.messages[0].content, /read_file/)
  assert.match(plan.body.messages[0].content, /tool_call/)
})

test("tool_choice none turns a simple free request back into plain chat", () => {
  const plan = rewriteFreeRequest({
    model: "nodecode-cyber-v1",
    messages: [{ role: "user", content: "hello" }],
    tools: [readFile],
    tool_choice: "none",
  })
  assert.equal(plan.bridge, false)
  assert.deepEqual(plan.tools, [])
  assert.equal("tools" in plan.body, false)
})

test("serializeTranscript keeps tool names and results associated", () => {
  const { systems, transcript } = serializeTranscript([
    { role: "system", content: "sys" },
    { role: "user", content: "read it" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/a"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "hello" },
  ])
  assert.deepEqual(systems, ["sys"])
  assert.match(transcript, /Assistant tool calls: .*read_file/)
  assert.match(transcript, /Tool result \(read_file\): hello/)
})

test("normalizeTools accepts modern and legacy tool shapes", () => {
  const tools = normalizeTools({
    tools: [readFile],
    functions: [{ name: "legacy_tool", description: "legacy", parameters: { type: "object" } }],
  })
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["read_file", "legacy_tool"],
  )
})

test("parseToolCalls handles one call, several calls, fences, and prose", () => {
  const single = parseToolCalls(
    '{"type":"tool_call","name":"read_file","arguments":{"path":"/tmp/a"}}',
    normalizeTools({ tools: [readFile] }),
  )
  assert.equal(single.calls.length, 1)
  assert.equal(single.calls[0].function.name, "read_file")
  assert.equal(single.calls[0].function.arguments, '{"path":"/tmp/a"}')
  assert.equal(single.content, null)

  const multiple = parseToolCalls(
    '```json\n{"type":"tool_calls","tool_calls":[{"name":"read_file","arguments":{"path":"/a"}},{"name":"read_file","arguments":{"path":"/b"}}]}\n```',
    normalizeTools({ tools: [readFile] }),
  )
  assert.equal(multiple.calls.length, 2)

  const prose = parseToolCalls(
    'I will read it now.\n{"type":"tool_call","name":"read_file","arguments":{"path":"/tmp/a"}}\n',
    normalizeTools({ tools: [readFile] }),
  )
  assert.equal(prose.calls.length, 1)

  const plain = parseToolCalls("The file says hello.", normalizeTools({ tools: [readFile] }))
  assert.equal(plain.calls.length, 0)
  assert.equal(plain.content, "The file says hello.")

  const unknown = parseToolCalls(
    '{"type":"tool_call","name":"delete_everything","arguments":{}}',
    normalizeTools({ tools: [readFile] }),
  )
  assert.equal(unknown.calls.length, 0)
  assert.equal(unknown.content.includes("delete_everything"), true)
})

test("transformFreeResponse turns the JSON protocol into native tool_calls", () => {
  const plan = {
    tools: normalizeTools({ tools: [readFile] }),
    model: "nodecode-cyber-v1",
  }
  const data = {
    id: "chatcmpl-1",
    model: "nodecode-cyber-v1",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: '{"type":"tool_call","name":"read_file","arguments":{"path":"/tmp/a"}}' },
        finish_reason: "stop",
      },
    ],
  }
  const out = transformFreeResponse(data, plan)
  assert.equal(out.choices[0].finish_reason, "tool_calls")
  assert.equal(out.choices[0].message.tool_calls[0].function.name, "read_file")
  assert.equal(out.choices[0].message.content, null)
})

test("transformFreeResponse leaves plain text alone", () => {
  const plan = { tools: normalizeTools({ tools: [readFile] }), model: "nodecode-cyber-v1" }
  const data = {
    choices: [{ index: 0, message: { role: "assistant", content: "The file says hello." }, finish_reason: "stop" }],
  }
  const out = transformFreeResponse(data, plan)
  assert.equal(out.choices[0].finish_reason, "stop")
  assert.equal(out.choices[0].message.content, "The file says hello.")
  assert.equal(out.choices[0].message.tool_calls, undefined)
})

test("buildFreeSse emits a tool-call stream and a text stream", async () => {
  const plan = { tools: normalizeTools({ tools: [readFile] }), model: "nodecode-cyber-v1" }
  const toolData = {
    id: "chatcmpl-1",
    model: "nodecode-cyber-v1",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: '{"type":"tool_call","name":"read_file","arguments":{"path":"/tmp/a"}}' },
        finish_reason: "stop",
      },
    ],
  }
  const toolResponse = buildFreeSse(toolData, plan)
  assert.match(toolResponse.headers.get("content-type"), /text\/event-stream/)
  const toolText = await toolResponse.text()
  assert.match(toolText, /"tool_calls"/)
  assert.match(toolText, /"finish_reason":"tool_calls"/)
  assert.match(toolText, /data: \[DONE\]/)

  const textData = {
    choices: [{ index: 0, message: { role: "assistant", content: "hello world" }, finish_reason: "stop" }],
  }
  const textResponse = buildFreeSse(textData, { ...plan, tools: [] })
  const text = await textResponse.text()
  assert.match(text, /"content":"hello world"/)
  assert.match(text, /"finish_reason":"stop"/)
})

test("makeFetch bridges a free tool request and returns native tool_calls", async () => {
  let seen = null
  const fetchImpl = async (_input, init) => {
    seen = JSON.parse(init.body)
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        model: "nodecode-cyber-v1",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: '{"type":"tool_call","name":"read_file","arguments":{"path":"/tmp/a"}}',
            },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  // Exercise the legacy transcript/JSON bridge explicitly; production defaults
  // to the native eval bridge for tool-bearing free requests.
  const response = await makeFetch({ free: true, fetchImpl, evalBridge: false })(
    "https://api.nodecode.ai/v1/chat/completions",
    {
      method: "POST",
      body: JSON.stringify({
        model: "nodecode-cyber-v1",
        messages: [{ role: "user", content: "read /tmp/a" }],
        tools: [readFile],
      }),
    },
  )
  assert.equal(seen.tools, undefined)
  assert.equal(seen.messages.length, 1)
  assert.equal(seen.messages[0].content.includes("User: read /tmp/a"), true)
  const data = await response.json()
  assert.equal(data.choices[0].finish_reason, "tool_calls")
  assert.equal(data.choices[0].message.tool_calls[0].function.name, "read_file")
})

test("makeFetch synthesizes SSE when the client asked for a stream", async () => {
  const fetchImpl = async (_input, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.stream, false)
    return new Response(
      JSON.stringify({
        choices: [{ index: 0, message: { role: "assistant", content: "streamed hello" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  const response = await makeFetch({ free: true, fetchImpl })(
    "https://api.nodecode.ai/v1/chat/completions",
    {
      method: "POST",
      body: JSON.stringify({
        model: "nodecode-cyber-v1",
        stream: true,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "again" },
        ],
      }),
    },
  )
  assert.match(response.headers.get("content-type"), /text\/event-stream/)
  const text = await response.text()
  assert.match(text, /"content":"streamed hello"/)
  assert.match(text, /data: \[DONE\]/)
})