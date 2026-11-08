import assert from "node:assert/strict"
import test from "node:test"

import {
  EVAL_TOOL,
  LISP_PREFIX,
  evalFormFromArguments,
  handleEvalRequest,
  makeEvalRequest,
  messageCalls,
  parseMagpieToolForm,
  splitEvalCalls,
  transformEvalResponse,
} from "../lib/free-eval.mjs"
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("makeEvalRequest uses NodeCode's exact eval tool and Lisp system prefix", () => {
  const plan = makeEvalRequest(
    {
      model: "nodecode-cyber-v1",
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "read a.txt" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "hello" },
      ],
      tools: [readFile],
    },
    [{ name: "read_file", description: "Read a text file", parameters: readFile.function.parameters }],
  )
  assert.equal(plan.mode, "eval")
  assert.equal(plan.body.tools.length, 1)
  assert.deepEqual(plan.body.tools[0], EVAL_TOOL)
  assert.equal(plan.body.messages[0].content.startsWith(LISP_PREFIX), true)
  assert.match(plan.body.messages[0].content, /read_file/)
  assert.equal(plan.body.messages[1].role, "user")
  assert.equal(plan.body.messages[2].role, "assistant")
  assert.equal(plan.body.messages[2].tool_calls[0].function.name, "eval")
  const args = JSON.parse(plan.body.messages[2].tool_calls[0].function.arguments)
  assert.match(args.form, /magpie-tool/)
  assert.match(args.form, /read_file/)
  assert.equal(plan.body.messages[3].role, "tool")
  assert.equal(plan.body.messages[3].content, "hello")
})

test("parseMagpieToolForm reads the Lisp string carrier", () => {
  const parsed = parseMagpieToolForm('(magpie-tool "read_file" "{\\"path\\":\\"/tmp/a\\"}")')
  assert.deepEqual(parsed, { name: "read_file", arguments: '{"path":"/tmp/a"}' })
  assert.equal(parseMagpieToolForm('(sh "ls")'), null)
})

test("splitEvalCalls separates client tools from direct eval forms", () => {
  const calls = [
    { id: "c1", type: "function", function: { name: "eval", arguments: JSON.stringify({ form: '(sh "ls")' }) } },
    {
      id: "c2",
      type: "function",
      function: { name: "eval", arguments: JSON.stringify({ form: '(magpie-tool "read_file" "{\\"path\\":\\"/x\\"}")' }) },
    },
  ]
  const { clientCalls, direct } = splitEvalCalls(calls)
  assert.equal(direct.length, 1)
  assert.equal(direct[0].form, '(sh "ls")')
  assert.equal(clientCalls.length, 1)
  assert.equal(clientCalls[0].function.name, "read_file")
})

test("handleEvalRequest executes direct eval and sends the result back upstream", async () => {
  const bodies = []
  let round = 0
  const fetchImpl = async (_input, init) => {
    bodies.push(JSON.parse(init.body))
    round += 1
    if (round === 1) {
      return jsonResponse({
        id: "r1",
        model: "nodecode-cyber-v1",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_eval_1",
                  type: "function",
                  function: { name: "eval", arguments: JSON.stringify({ form: '(sh "echo hi")' }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    }
    return jsonResponse({
      id: "r2",
      model: "nodecode-cyber-v1",
      choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
    })
  }
  const plan = makeEvalRequest(
    {
      model: "nodecode-cyber-v1",
      messages: [{ role: "user", content: "say hi" }],
      tools: [readFile],
    },
    [{ name: "read_file", description: "Read a text file", parameters: readFile.function.parameters }],
  )
  const response = await handleEvalRequest({
    input: "https://api.nodecode.ai/v1/chat/completions",
    init: { method: "POST" },
    headers: new Headers({ "content-type": "application/json" }),
    body: plan.body,
    plan,
    fetchImpl,
    evalRunner: async (form) => {
      assert.equal(form, '(sh "echo hi")')
      return "hi\n"
    },
  })
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(data.choices[0].message.content, "done")
  assert.equal(bodies.length, 2)
  assert.equal(bodies[1].messages.at(-2).role, "assistant")
  assert.equal(bodies[1].messages.at(-1).role, "tool")
  assert.equal(bodies[1].messages.at(-1).content, "hi\n")
})

test("handleEvalRequest returns native client tool_calls from a magpie-tool form", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      id: "r1",
      model: "nodecode-cyber-v1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_eval_1",
                type: "function",
                function: {
                  name: "eval",
                  arguments: JSON.stringify({ form: '(magpie-tool "read_file" "{\\"path\\":\\"/tmp/a\\"}")' }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
  const plan = makeEvalRequest(
    {
      model: "nodecode-cyber-v1",
      messages: [{ role: "user", content: "read /tmp/a" }],
      tools: [readFile],
    },
    [{ name: "read_file", description: "Read a text file", parameters: readFile.function.parameters }],
  )
  const response = await handleEvalRequest({
    input: "https://api.nodecode.ai/v1/chat/completions",
    init: { method: "POST" },
    headers: new Headers({ "content-type": "application/json" }),
    body: plan.body,
    plan,
    fetchImpl,
    evalRunner: async () => {
      throw new Error("should not execute client tool")
    },
  })
  const data = await response.json()
  assert.equal(data.choices[0].finish_reason, "tool_calls")
  assert.equal(data.choices[0].message.tool_calls[0].function.name, "read_file")
  assert.equal(data.choices[0].message.tool_calls[0].function.arguments, '{"path":"/tmp/a"}')
})

test("handleEvalRequest repairs a direct magpie-tool call from the model", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_direct",
                type: "function",
                function: {
                  name: "magpie-tool",
                  arguments: JSON.stringify({
                    tool_name: "read_file",
                    "json-arguments": '{"path":"/tmp/a"}',
                  }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })
  const plan = makeEvalRequest(
    { model: "nodecode-cyber-v1", messages: [{ role: "user", content: "read /tmp/a" }], tools: [readFile] },
    [{ name: "read_file", description: "Read a text file", parameters: readFile.function.parameters }],
  )
  const response = await handleEvalRequest({
    input: "https://api.nodecode.ai/v1/chat/completions",
    init: { method: "POST" },
    headers: new Headers({ "content-type": "application/json" }),
    body: plan.body,
    plan,
    fetchImpl,
  })
  const data = await response.json()
  assert.equal(data.choices[0].finish_reason, "tool_calls")
  assert.equal(data.choices[0].message.tool_calls[0].function.name, "read_file")
  assert.equal(data.choices[0].message.tool_calls[0].function.arguments, '{"path":"/tmp/a"}')
})

test("makeFetch uses the eval bridge for free requests with tools", async () => {
  const seen = []
  let round = 0
  const fetchImpl = async (_input, init) => {
    seen.push(JSON.parse(init.body))
    round += 1
    if (round === 1) {
      return jsonResponse({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "e1",
                  type: "function",
                  function: { name: "eval", arguments: JSON.stringify({ form: '(magpie-tool "read_file" "{\\"path\\":\\"/x\\"}")' }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    }
    return jsonResponse({ choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }] })
  }
  const response = await makeFetch({
    free: true,
    fetchImpl,
    evalRunner: async () => "unused",
  })("https://api.nodecode.ai/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "nodecode-cyber-v1",
      messages: [{ role: "user", content: "read /x" }],
      tools: [readFile],
    }),
  })
  const data = await response.json()
  assert.equal(data.choices[0].message.tool_calls[0].function.name, "read_file")
  assert.equal(seen.length, 1)
  assert.equal(seen[0].tools.length, 1)
  assert.equal(seen[0].tools[0].function.name, "eval")
  assert.match(seen[0].messages[0].content, /^You are a living Common Lisp image/)
})

test("messageCalls recovers an eval call written as text", () => {
  const message = {
    role: "assistant",
    content:
      '<tool_call>\n{"name":"eval","arguments":{"cmd":"printf \'x\' > /tmp/a.txt"}}\n</tool_call>',
  }
  const calls = messageCalls(message, [{ name: "read_file" }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].function.name, "eval")
})

test("evalFormFromArguments accepts shell aliases and wraps them in (sh ...)", () => {
  for (const key of ["cmd", "command", "shell"]) {
    const parsed = evalFormFromArguments({ [key]: "echo hi" })
    assert.ok(parsed, key)
    assert.equal(parsed.form, '(sh "echo hi")')
  }
  assert.equal(evalFormFromArguments({ form: "(+ 1 2)" }).form, "(+ 1 2)")
  assert.equal(evalFormFromArguments({ code: "(+ 1 2)" }).form, "(+ 1 2)")
  assert.equal(evalFormFromArguments({}), null)
})

test("evalFormFromArguments escapes quotes and backslashes in shell text", () => {
  const parsed = evalFormFromArguments({ cmd: 'echo "a\\b"' })
  assert.equal(parsed.form, '(sh "echo \\"a\\\\b\\"")')
})

test("transformEvalResponse turns a text eval call into a native eval call", () => {
  const data = {
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: '<tool_call>{"name":"eval","arguments":{"form":"(sh \\"ls\\")"}}</tool_call>',
        },
        finish_reason: "stop",
      },
    ],
  }
  const out = transformEvalResponse(data, { tools: [{ name: "read_file" }] })
  const calls = out.choices[0].message.tool_calls
  assert.equal(calls.length, 1)
  assert.equal(calls[0].function.name, "eval")
  assert.equal(out.choices[0].finish_reason, "tool_calls")
})
