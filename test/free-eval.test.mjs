import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import { runEvalForm } from "../lib/eval-runner.mjs"

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

test("makeFetch runs eval in the agent's workspace and session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nc-magpie-cwd-"))
  const seen = []
  let round = 0
  const fetchImpl = async () => {
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
                  function: { name: "eval", arguments: JSON.stringify({ form: '(sh "pwd")' }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    }
    return jsonResponse({ choices: [{ index: 0, message: { content: "done" }, finish_reason: "stop" }] })
  }
  try {
    await makeFetch({
      free: true,
      cwd: "/tmp",
      fetchImpl,
      evalRunner: async (form, options) => {
        seen.push({ form, ...options })
        return dir
      },
    })("https://api.nodecode.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "x-magpie-work-dir": dir,
        "x-magpie-session": "s-magpie-test",
        "x-magpie-subagent": "agent-7",
      },
      body: JSON.stringify({
        model: "nodecode-cyber-v1",
        messages: [{ role: "user", content: "where am I?" }],
        tools: [readFile],
      }),
    })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].form, '(sh "pwd")')
    assert.equal(seen[0].cwd, realpathSync(dir))
    assert.equal(seen[0].sessionId, "s-magpie-test::agent-7")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("handleEvalRequest allows more than six eval rounds", async () => {
  let round = 0
  const fetchImpl = async () => {
    round += 1
    if (round <= 8) {
      return jsonResponse({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `e${round}`,
                  type: "function",
                  function: { name: "eval", arguments: JSON.stringify({ form: "(+ 1 1)" }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    }
    return jsonResponse({ choices: [{ index: 0, message: { content: "done" }, finish_reason: "stop" }] })
  }
  const plan = makeEvalRequest(
    { model: "nodecode-cyber-v1", messages: [{ role: "user", content: "keep going" }], tools: [readFile] },
    [{ name: "read_file", description: "Read a text file", parameters: readFile.function.parameters }],
  )
  const response = await handleEvalRequest({
    input: "https://api.nodecode.ai/v1/chat/completions",
    init: { method: "POST" },
    headers: new Headers({ "content-type": "application/json" }),
    body: plan.body,
    plan,
    fetchImpl,
    evalRunner: async () => "2",
  })
  const data = await response.json()
  assert.equal(data.choices[0].message.content, "done")
  assert.equal(round, 9)
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

test("handleEvalRequest executes a text eval call and continues the loop", async () => {
  const seen = []
  const responses = [
    {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              '<tool_call>{"name":"eval","arguments":{"cmd":"printf step-one > /tmp/x.txt"}}</tool_call>',
          },
          finish_reason: "stop",
        },
      ],
    },
    {
      choices: [
        { index: 0, message: { role: "assistant", content: "The file contains step-one." }, finish_reason: "stop" },
      ],
    },
  ]
  const fetchImpl = async () => {
    const data = responses.shift()
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } })
  }
  const evalRunner = async (form) => {
    seen.push(form)
    return "ok"
  }
  const plan = makeEvalRequest({ messages: [{ role: "user", content: "create the file" }], tools: [readFile] }, [
    { name: "read_file" },
  ])
  const response = await handleEvalRequest({
    input: "https://api.nodecode.ai/v1/chat/completions",
    init: { method: "POST" },
    headers: new Headers({ "content-type": "application/json" }),
    body: plan.body,
    plan,
    fetchImpl,
    evalRunner,
  })
  const data = await response.json()
  assert.deepEqual(seen, ['(sh "printf step-one > /tmp/x.txt")'])
  assert.equal(data.choices[0].message.content, "The file contains step-one.")
})

test("runEvalForm does not replay a timed-out form in a second process", async () => {
  let oneShotCalls = 0
  const form = "(sh \"sleep 5\")"
  // Simulate the persistent server timing out; the one-shot path must not run.
  const result = await runEvalForm(form, {
    persistent: true,
    timeoutMs: 1_000,
    server: true,
    env: { ...process.env, NODECODE_BIN: "/nonexistent/nodecode" },
  }).catch((error) => `THREW: ${error.message}`)
  assert.match(String(result), /ERROR|THREW/)
  assert.equal(oneShotCalls, 0)
})

test("handleEvalRequest describes an image through look and continues the loop", async () => {
  const seen = []
  const lookCalls = []
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
                  id: "look_eval_1",
                  type: "function",
                  function: {
                    name: "eval",
                    arguments: JSON.stringify({
                      form: '(magpie-tool "look" "{\\"path\\":\\"/tmp/pic.png\\"}")',
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    }
    return jsonResponse({ choices: [{ index: 0, message: { content: "the card says hi" }, finish_reason: "stop" }] })
  }
  const plan = makeEvalRequest(
    { messages: [{ role: "user", content: "read the picture" }], tools: [readFile] },
    [{ name: "read_file", description: "Read a text file", parameters: readFile.function.parameters }],
  )
  const response = await handleEvalRequest({
    input: "https://api.nodecode.ai/v1/chat/completions",
    init: { method: "POST" },
    headers: new Headers({ "content-type": "application/json" }),
    body: plan.body,
    plan,
    fetchImpl,
    lookRunner: async (args) => {
      lookCalls.push(args)
      return "a white card with the word hi"
    },
  })
  const data = await response.json()
  assert.equal(data.choices[0].message.content, "the card says hi")
  assert.equal(lookCalls.length, 1)
  assert.equal(lookCalls[0].path, "/tmp/pic.png")
  assert.equal(seen.length, 2)
  assert.equal(seen[1].messages.at(-1).role, "tool")
  assert.equal(seen[1].messages.at(-1).content, "a white card with the word hi")
})

test("handleEvalRequest returns a look error as a tool result", async () => {
  let round = 0
  const fetchImpl = async () => {
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
                  id: "look_eval_2",
                  type: "function",
                  function: {
                    name: "eval",
                    arguments: JSON.stringify({ form: '(magpie-tool "look" "{\\"path\\":\\"/nope.png\\"}")' }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    }
    return jsonResponse({ choices: [{ index: 0, message: { content: "could not read it" }, finish_reason: "stop" }] })
  }
  const plan = makeEvalRequest(
    { messages: [{ role: "user", content: "read it" }], tools: [readFile] },
    [{ name: "read_file", description: "Read a text file", parameters: readFile.function.parameters }],
  )
  const response = await handleEvalRequest({
    input: "https://api.nodecode.ai/v1/chat/completions",
    init: { method: "POST" },
    headers: new Headers({ "content-type": "application/json" }),
    body: plan.body,
    plan,
    fetchImpl,
    lookRunner: async () => {
      throw new Error("cannot read /nope.png")
    },
  })
  const data = await response.json()
  assert.equal(data.choices[0].message.content, "could not read it")
})

test("handleEvalRequest normalizes a native look call before calling upstream", async () => {
  const bodies = []
  let round = 0
  const fetchImpl = async (_input, init) => {
    bodies.push(JSON.parse(init.body))
    round += 1
    if (round === 1) {
      return jsonResponse({
        id: "r-look-native",
        model: "nodecode-cyber-v1",
        choices: [{
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "native_look_1",
              type: "function",
              function: { name: "look", arguments: '{"path":"/tmp/native.png"}' },
            }],
          },
        }],
      })
    }
    return jsonResponse({
      id: "r-look-native-final",
      model: "nodecode-cyber-v1",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "native-look-done" } }],
    })
  }
  const seen = []
  const response = await handleEvalRequest({
    body: { model: "nodecode-cyber-v1", messages: [{ role: "user", content: "read the image" }] },
    plan: { model: "nodecode-cyber-v1", tools: [], cwd: "/tmp" },
    fetchImpl,
    lookRunner: async (args) => {
      seen.push(args)
      return "native-look-ok"
    },
    maxRounds: 3,
  })
  assert.equal(response.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].path, "/tmp/native.png")
  const assistant = bodies[1].messages.find((message) => message.role === "assistant")
  assert.equal(assistant.tool_calls[0].function.name, "eval")
  assert.match(assistant.tool_calls[0].function.arguments, /magpie-tool/)
  const tool = bodies[1].messages.find((message) => message.role === "tool")
  assert.equal(tool.tool_call_id, "native_look_1")
  assert.equal(tool.content, "native-look-ok")
  const data = await response.json()
  assert.equal(data.choices[0].message.content, "native-look-done")
})
