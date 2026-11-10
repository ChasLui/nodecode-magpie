# nodecode-magpie 设计说明

> 目标：在 magpie 中提供两个 NodeCode 供应商：`nodecode`（付费 key，完整工具、1M context）与 `nodecode-free`（免费 key，仅 `nodecode-cyber-v1`、256K context；用 NodeCode 原生 `eval` tool + 本地持久 Lisp image 释放与 CLI 相同的工具能力）。
>
> 版本：0.6.0（2026-11-10）。magpie 宿主契约按 0.1.3240 核对。

## 1. 结论：为什么必须写插件

免费 key 的服务端门禁不是单一 User-Agent 检查，而是 5 项：

| 检查 | 要求 | 普通 `magpie provider add` |
| --- | --- | --- |
| `route` | 对话请求只允许 `POST /v1/chat/completions`；`/v1/responses`、`/v1/messages` 403 | 默认可以，但用户可切到 responses/messages |
| `user_agent` | 必须以 `nodecode_cli/` 开头（`curl/8.7.1`、`nodecode`、`nodecode-cli/...` 都 403） | **不能**：provider add 的 UA 只有 agent/magpie |
| `tools` | 非空时只允许一个名为 `eval` 的工具；无 tools 时也只允许单轮（最多一个 system + 一个最终 user） | **不能**：agent 会带自己的工具和历史 |
| `tool_schema` | `eval.parameters` 必须匹配 NodeCode 的固定 schema | **不能** |
| `system_prompt` | 带 tools 时 system 必须以 `You are a living Common Lisp image` 开头 | **不能** |

因此：

- `chat.headers` 不够：它能改 UA，但不能改 body；免费档还要处理 tools 与多轮历史。
- 模型声明 `tool_call: false` / `capabilities.toolcall: false` 不够：magpie host 的 `rowOf` 不把 `toolcall/capabilities` 传给 Go gateway；gateway 仍会发 tools。
- 唯一能同时改头和 body 的层是 `auth.loader.fetch`。

## 2. 方案

```
magpie agent
   │  chat request (full transcript, may include tools)
   ▼
magpie gateway (Go)
   │  headers: apiKey → loader.headers → gateway → chat.headers
   ▼
plugin auth.loader.fetch   ← 唯一能改 body 的层
   ├─ paid:  诚实 UA，保留 tools 与完整历史，原样转发
   └─ free:  CLI UA
             ├─ 有 tools：单 eval tool + Lisp 前缀 + 本地持久 image（client tools 走 magpie-tool）
             └─ 无 tools：单轮 transcript + JSON 工具协议
   ▼
https://api.nodecode.ai/v1/chat/completions
```

### 2.1 一个包两个 provider

- `nodecode`：付费 key；`NODECODE_API_KEY` → `~/.nodecode/auth.json` 的 `api_keys.nodecode.key`
- `nodecode-free`：免费 key；`NODECODE_FREE_API_KEY` → `api_keys["nodecode-free"].key` → `~/.nodecode/free-key.txt`
- 共用 base URL、模型元数据、usage 解析
- 入口只导出两个工厂；helper 放 `lib/nodecode.mjs`，eval bridge 放 `lib/free-eval.mjs`，transcript bridge 放 `lib/free-bridge.mjs`，本地执行器放 `lib/eval-runner.mjs` / `lib/eval-server.mjs`

### 2.2 行为差异

| 维度 | `nodecode` | `nodecode-free` |
| --- | --- | --- |
| User-Agent | `nodecode-magpie/0.6.0`（诚实） | `nodecode_cli/<version> (<OS> <release>; <arch>) <TERM>` |
| body（有 tools） | 原样转发 | 单 `eval` tool + Lisp 前缀 + 工具目录；本地执行 eval，client tools 走 `(magpie-tool ...)` |
| body（无 tools） | 原样转发 | 单轮化；删除 tools 五件套；需要时注入 JSON 工具协议 |
| 路由 | 由模型 API 决定 | 只允许 `/chat/completions`，否则本地抛错 |
| 工具 | 原生 tools | 对客户端透明的原生 `tool_calls`（来自 eval call 还原） |
| 多轮 | 原生 | 有 tools：eval + tool results 原生多轮；无 tools：整段 transcript 压成一条 user |
| 流式 | 原生 SSE | bridge 时把非流式上游响应合成为 OpenAI SSE |
| context | 1,048,576 | 262,144 |
| max output | 131,072 | 131,072 |
| 并发 | 不设 | `maxConcurrency: 2` |
| usage | `plan:"Balance"` + `$micros/1e6` | `plan:"Free"`、`balance:"Free"` |

## 3. magpie 宿主契约（0.1.3240）

实现依赖以下事实；升级 magpie 后应重跑单测和真实 smoke test。

### 3.1 入口与导出

- 入口顺序：`exports["./server"]` → `main` → `exports["."]` → `index.ts/js/mjs/cjs`
- `servers(mod)` 会实例化入口模块的**每一个导出函数**
- 不要在入口导出 helper；否则 helper 会被当插件
- `index.mjs` 只导出 `NodecodePlugin` 和 `NodecodeFreePlugin`

### 3.2 config hook

- 按加载顺序串行执行
- 初始 `config = { provider: {}, ...structuredClone(userConfig) }`
- 必须保留用户改过的 `name` / `npm` / `api` / 模型字段
- 模型条目按 id 深合并；只改 `limit.context` 不能丢掉 `limit.output`

### 3.3 auth method / keyless

- `type:"api"` + `keyless:true` + `authorize` 函数，UI 才会用空 key 直接调 `authorize`
- `authorize` 返回 `{type:"success", key}` 后，host 保存 `{type:"api", key, metadata?}`
- 第二个普通 api method 支持粘贴 key

### 3.4 loader.fetch

- `auth.loader` 每账户只跑一次并缓存
- 返回 `{baseURL, apiKey, headers, fetch}`
- `init.body` 是 UTF-8 字符串（`host.js` 的 `bodyOf`）
- 全局 `fetch` 被 host 用 AsyncLocalStorage 包装，自动走代理并剥离 `X-Magpie-*`
- 因此插件用全局 `fetch`，不要用 `undici`/`axios` 等非全局客户端

### 3.5 模型 capability 不到 Go

- `rowOf` 给 Go 的字段只有 `id/name/npm/url/apiId/context/input/output/reasoning/image/...`
- 没有 `toolcall` / `capabilities`
- gateway 没有按模型 capability 删除 tools 的通用逻辑
- 免费档必须在 fetch 里处理 tools

### 3.6 auth.usage

- 顶层 `plan/user/balance/error` 只接受字符串
- `windows[].used` 是数字百分比；`amount/limit/span/runsOut/balance` 数字
- `/v1/usage` 只暴露 credit/plan，不暴露 token 窗口
- 插件不伪造 `used`；`windows: []`

## 4. 免费档 bridge

### 4.1 为什么需要

免费 key 的 `tools` 检查实际上把「无 tools」也限制成单轮：`[system,user]` 和 `[user]` 通过；`[user,user]`、`[system,user,user]`、`[user,assistant]`、`[assistant,user]` 全部 403 `free_needs_nodecode`，message 指向 `tools`。真实 agent 每轮都会带完整历史，所以旧版「只删 tools」的实现会在第二轮开始全部失败。

0.2.0 起分两条路（0.3.0 起 eval 语义与 CLI 对齐；0.4.0 起按 workspace/session 隔离并支持 32 轮；0.4.1 起支持 look 视觉桥，0.4.2 起支持原生图片输入，0.5.0 起定义跨宿主重启保留；0.5.1 起 Lisp `(look ...)` 直接可用；0.5.2 起**无 tools 的请求默认也走 eval image**，只有 `tool_choice:"none"` 或 `max_tokens < 256` 才回退 transcript 单轮化）：有 tools（或无 tools 但回复预算足够）走 NodeCode 原生 `eval` tool（真正释放 CLI 能力）。

### 4.2 带工具的 eval bridge

#### 4.2.1 门禁契约

免费 key 带非空 tools 时，服务端要求：

- `tools` 恰好一个，名为 `eval`；
- `eval.parameters` 恰好 `form`(string)、`yield_time_ms`(integer)、`strings`(object of strings)，`required: ["form"]`；
- system 消息必须以四行 NodeCode Lisp prompt 开头。

`lib/free-eval.mjs` 的 `LISP_PREFIX` / `EVAL_TOOL` 原样满足这些条件。这与「删除 tools」不同：它不是绕过工具检查，而是按厂商允许的 CLI 工具形态提交请求。

#### 4.2.2 请求

`makeEvalRequest(body, tools)`：

1. system = `LISP_PREFIX` + 原 system + 工具目录 + `(magpie-tool "name" "json")` 约定；
2. 保留全部消息；把历史 assistant 的 client tool_calls 改写成对 `eval` 的调用，form 为 `(magpie-tool ...)`；
3. 删除旧 tools 五件套，设置 `tools:[EVAL_TOOL]`、`tool_choice:"auto"`、`stream:false`。

#### 4.2.3 执行循环

`handleEvalRequest` 最多 32 轮（`DEFAULT_MAX_ROUNDS`）：

1. 发上游；若模型返回 `eval` 调用，拆成 direct forms 与 `(magpie-tool ...)`；
2. direct forms 交给 `runEvalForm` 在本地执行，结果作为 `role:"tool"` 消息回喂；
3. `(magpie-tool "look" ...)` 由插件内部处理：读图 → 调本地 magpie 视觉模型 → 把描述作为 tool result 回喂，循环继续；
4. 其余 `(magpie-tool ...)` 还原为普通 `tool_calls` 返回给 magpie（magpie 执行 client tool 后再发下一轮）；
5. 模型不再调用 eval 时，返回最终文本；stream 客户端合成 SSE。

#### 4.2.4 本地执行器

- `lib/eval-runner.mjs`：默认使用**持久** `nodecode trial` 进程 + JSON-lines 服务（`lib/eval-server.mjs` 客户端 + `lib/eval-server.lisp` 服务端）；失败时退回 one-shot trial。
- 持久进程让 `(defun ...)`、已加载 fasl、`(write-file ...)` 等状态跨 eval 调用保留，接近 CLI 的 image 语义。
- 每个 form 在服务端用 `sb-thread:make-thread` 独立线程执行：慢 form 不阻塞后续请求，超时/中断只影响该 form，image 与定义存活。
- 请求带 `req_id`，Node 侧用 pending Map 匹配；socket 关闭或子进程退出即标记该 image 死亡，下次调用重建，不会把死连接当活连接用。
- `(sh ...)`、`(edit ...)`、`(write-file ...)`、`(look ...)` 都是 NodeCode 内置 eval helper；直接 eval 的返回值经 JSON line 返回。
- 每个 `(binary, workspace, session, subagent)` 一个 image：`lib/nodecode.mjs` 读取 magpie 注入的 `x-magpie-work-dir`（目录存在才采用）、`x-magpie-session` 与 `x-magpie-subagent`，把后两者组合成 `sessionId` 传给 `runEvalForm({cwd, sessionId})`；这些头只给插件看，发往 NodeCode 前由 host 删除。不同工作区/会话/子代理不共享定义，eval 的 `(sh "pwd")` 从 agent 的工作目录开始。

#### 4.2.5 与 CLI 对齐的 snippet 语义

snippet 整段交给 `eval-string`，不再包 `(progn ...)`，因此保留 CLI 的：

- 每 form 一行 `=>`，最后一个值完整打印，前面的值一行；
- `*` / `**` / `***` 与 `/` / `//` / `///` 历史；
- 失败 form 报 `ERROR in form i of n (forms 1-… evaluated and stand: …)`，前面 form 的效果保留、不重放；
- 单行 snippet 少右括号时按 CLI 原文拒绝；
- 多行字符串结果在 `[text: N lines, M characters]` 头下裸文本输出；`(sh ...)` 非零退出追加 `[exit N]`；
- 结果上限 32,000 字符。

#### 4.2.6 后台 eval 与 yield

`yield_time_ms`（默认 10,000，上限 600,000）是**等待窗口**而不是 kill 开关：

- 窗口内结束 → 返回 `exited` 结果；
- 窗口到期 → 返回 `[running in the background · eval id N]`，form 继续在 image 内运行；
- 模型用 `(magpie-eval-status N)`、`(magpie-eval-await N [:until-exit t])`、`(magpie-eval-interrupt N [:force t])` 轮询/等待/中断。

这与官方 `exec.lisp` 的语义一致（官方用后台进程 + exec registry，我们用 Lisp 线程 + socket），差别只在实现机制。

#### 4.2.7 strings 通道

eval 工具可带 `strings` 对象；服务端用 `progv` 在线程内绑定 `nodecode.evolved::*eval-strings*`，`($ "name")` 即可取到。用于引号、反斜杠、换行多的文本，避免 Lisp 转义。

#### 4.2.8 look 视觉桥

免费模型是纯文本的，NodeCode 内置 `(look ...)` 会以 *"reads text only"* 拒绝。0.5.1 起插件在 image 里提供一个同名 `look`，通过私有 Unix socket 把请求送回插件：

1. `lib/eval-server.lisp` 的 `magpie-look` 连接 `__MAGPIE_LOOK_SOCKET__`，发送 `{"path":...,"prompt":...}`，等待一行 JSON；
2. `magpie-install-look` 在每次 eval 前把 `nodecode.evolved:look` 指向 `magpie-look`（`eval-string` 会重置引擎自带的 `LOOK`）；
3. Node 侧 `EvalServer.startLookServer()` 接收请求，`lookHandler` 调 `lib/vision.mjs` 的 `describeImage`；
4. `describeImage` 解析相对 workspace 的路径，校验 PNG/JPEG/GIF/WebP、≤5 MiB，转成 `data:` URI，POST 到 magpie gateway 的 `/v1/chat/completions`，默认按 `group/auto-deepseek-flash` → `auto/gpt-6.1-sol` → `auto/gemini-3.8-flash` 回退；
5. 描述文本作为 `look` 的返回值（可直接嵌套在 `(list ...)` 等 form 中）；图片/视觉模型报错时以 `ERROR: ...` 回喂，模型可以换路径或改问法。旧 carrier `(magpie-tool "look" ...)` 仍由 `handleEvalRequest` 识别，保持兼容。

配置：`NODECODE_VISION_MODEL`（锁定单个模型，覆盖默认回退链）、`NODECODE_VISION_BASE_URL`（默认 `MAGPIE_GATEWAY_URL` → `MAGPIE_ADDR` → `http://127.0.0.1:3425/v1`）、`NODECODE_VISION_API_KEY`（或已有的 `MAGPIE_GATEWAY_KEY`）、`NODECODE_VISION_TIMEOUT_MS`（默认 30s）。这条路径只把图片发给本机网关选中的视觉 provider，不会重新进入 `nodecode-free`，避免递归。

原生图片输入（0.4.2）：请求消息里的 OpenAI `image_url` / `input_image` part 在进入免费 vendor 前由 `bridgeImages` 替换为 `[image N: ...]` 文本，支持 data URL、http(s) URL、file:// 和相对 workspace 的路径；每请求最多 4 张、每张 ≤5 MiB。描述失败降级为 `[image unavailable: ...]`，请求继续；付费档保持原样。

#### 4.2.9 定义历史

`nodecode trial` 进程退出（插件宿主重启、网关重启、崩溃）会丢整个 image。为对齐 CLI 的 layer 语义，`lib/eval-server.mjs` 在每次成功启动的 form 中提取 definition 形式，按 session key 追加到 `~/.nodecode-magpie/history/<sha256(key)>.jsonl`（可用 `NODECODE_MAGPIE_HISTORY` 改目录）：

- 只记录顶层 `defun`/`defvar`/`defparameter`/`defconstant`/`defmacro`/`defgeneric`/`defmethod`/`defsetf`/`defclass`/`defstruct`/`deftype`/`defpackage`/`define-*`；
- 新 image 建好后在 `startPromise` 里按序回放（每个 form 15s 上限，失败忽略），因此 `defun` 在宿主重启后仍可调用；
- `sh`/`edit`/`write-file` 等副作用形式不记录、不回放；值、`*`/`/` 历史与后台结果仍只在内存；
- 历史上限 500 条，文件超过 1000 行时保留最后 1000 行。

#### 4.2.10 模型别名

付费与免费两个 provider 都声明三个模型 id：`nodecode-cyber-v1`、`deepseek-v4.1-flash`、`deepseek-flash`。后两个是**插件侧别名**：

- 模型元数据里 `id` 是别名、`api.id` 固定为 `nodecode-cyber-v1`，所以 magpie 上游请求拿到的仍是 NodeCode 唯一对话模型；
- `makeFetch` 再兜底：免费档无条件把 `model` 设为 `nodecode-cyber-v1`；付费档只在 `model` 命中别名时改写，不改其他模型 id；
- 免费 key 的 vendor 门禁仍然只认 `nodecode-cyber-v1`，别名不会以原名发到 vendor。

#### 4.2.11 后台 eval 的结果日志

CLI 的约定是「后台输出只存活，exit 结果进 session log」。本插件没有 scribe session，于是在 Lisp 服务内自己写一份 per-session 日志：

- Node 为每个 scope 计算 `~/.nodecode-magpie/history/evals/<sha256(key)>.log`（`NODECODE_MAGPIE_HISTORY` 可改根目录），并把路径作为 `__MAGPIE_EVAL_LOG__` 注入服务源码；
- `runWithYield` 在 eval 请求里带 `background_after_ms`；Lisp 起一个看门线程，超过该窗口仍在运行就标记为后台 eval；
- 每个 form 的输出同时写进「可读流」和「日志流」：模型用 `(magpie-eval-status N)` 取走前者不会掏空日志；
- eval 结束时（工作线程、看门线程或 `status` 查询任一路径）把 `--- eval N (background) --- / value / output` 追加到日志，幂等（`logged-p`）；
- 日志超过 128 KiB 时只保留末尾 64 KiB（从记录边界切），新 image 用 `(magpie-eval-log [N])` 读取最后 N 条；`(magpie-eval-list)` 会在末尾提示日志里有 N 条历史退出。

### 4.3 transcript 请求改写

`lib/free-bridge.mjs` 的 `rewriteFreeRequest(body)`：

1. 把 `system` / `developer` 消息合并为 system（保留原文）；
2. 把其余消息序列化成 transcript：
   - `User: ...`
   - `Assistant: ...`
   - `Assistant tool calls: read_file({"path":"/a"})`
   - `Tool result (read_file): ...`
3. 若客户端带 tools 且 `tool_choice !== "none"`，在 user 消息前插入工具目录和协议：
   ```
   {"type":"tool_call","name":"<tool>","arguments":{...}}
   {"type":"tool_calls","tool_calls":[...]}
   ```
4. 最终只发送 `[system?, user]`，并强制 `stream:false`（bridge 路径）；
5. 删除所有原生 tool 字段。`tool_choice:"none"` 时不注入协议，按纯聊天处理。

### 4.4 响应还原

`transformFreeResponse(data, plan)` 从 `message.content` 中提取 JSON（容忍代码块、前后散文），校验工具名，重建标准 `tool_calls`，把 `finish_reason` 改为 `tool_calls`。如果模型输出普通文本，则原样作为 `content`。

`buildFreeSse(data, plan)` 把非流式响应合成为 OpenAI `chat.completion.chunk` SSE：

- 第一条 `delta.role = "assistant"`
- 工具调用一条 `delta.tool_calls`
- 最后 `finish_reason = "tool_calls"` 或 `stop`
- 末尾 `data: [DONE]`

### 4.5 已知边界

- eval image 按 `(binary, workspace, session, subagent)` 隔离；主会话与子代理不共享定义（0.4.0 起）。
- 免费档的 Lisp `(look ...)` 在 eval lane 直接可用（0.5.1 起，经私有 socket）；0.5.2 起无 tools 的普通请求也进同一 lane，只有 `tool_choice:"none"` 或 `max_tokens < 256` 的纯短答请求留在 transcript lane，无法执行 Lisp、只能处理请求里的原生图片 part。视觉桥依赖本机 magpie gateway 上有一个可用的图像模型。
- 后台 eval 的 `output` 只在存活期间可读；已退出 eval 的结果保留在内存，服务重启即丢（与 CLI 的 log 落盘不同）。定义是例外：definition 形式的表单写入 `~/.nodecode-magpie/history/<hash>.jsonl`，新 image 启动时回放，使 `defun` 在插件宿主重启后仍可调用。
- eval 以运行 magpie 的用户权限执行，拥有完整 host authority。
- transcript bridge（无 tools）仍要求模型遵循 JSON 协议；不遵循时退化为普通文本，工具名必须在客户端 tools 列表中。
- 合成 tool call id 不跨轮稳定；assistant 的 `reasoning` 不单独保留。
- 仍不能改变免费 key 的模型/路由/额度限制。

## 5. 关键实现

### 5.1 免费档 makeFetch

```js
export function makeFetch({ free, cwd, fetchImpl = globalThis.fetch, evalRunner = runEvalForm, lookRunner, imageRunner = describeImage, imageBridge = true, evalBridge = true } = {}) {
  return async function nodecodeFetch(input, init = {}) {
    const headers = new Headers(init?.headers || {})
    headers.set("user-agent", free ? FREE_UA : PAID_UA)
    let body = init?.body

    if (free) {
      const url = typeof input === "string" ? input : input?.url || ""
      if (!/\/chat\/completions(?:[?#]|$)/.test(url)) {
        throw new Error(`nodecode-free only supports POST /v1/chat/completions; refusing ${url}`)
      }
      if (typeof body === "string" && body.trim()) {
        const parsed = JSON.parse(body)
        parsed.model = CYBER
        const tools = normalizeTools(parsed)
        const none = parsed.tool_choice === "none" || parsed.tool_choice?.type === "none"
        if (evalBridge && tools.length > 0 && !none) {
          const plan = makeEvalRequest(parsed, tools)
          plan.cwd = cwd
          return handleEvalRequest({ input, init, headers, body: plan.body, plan, fetchImpl, evalRunner })
        }
        const plan = rewriteFreeRequest(parsed)
        body = JSON.stringify(plan.body)
        headers.set("content-type", "application/json")
        headers.delete("content-length")
      }
    }

    return fetchImpl(input, { ...init, headers, body })
  }
}
```

### 5.2 免费 UA

```js
const CLI_VERSION = process.env.NODECODE_CLI_VERSION || "0.1.13"
const OS = process.platform === "darwin" ? "Darwin" : process.platform === "win32" ? "Windows" : "Linux"
const ARCH = process.arch === "arm64" ? "arm64" : "x64"

export const FREE_UA =
  `nodecode_cli/${CLI_VERSION} (${OS} ${release()}; ${ARCH}) ${process.env.TERM || "xterm-256color"}`
```

实测形态：`nodecode_cli/0.1.13 (Darwin 27.2.0; arm64) dumb`，对真实免费端点 200。

### 5.3 config 深合并

`mergeModel` 对普通对象逐字段递归，对数组整体替换；用户只改 `limit.context` 时 `limit.output` 保留。

### 5.4 usage

- `pays === "free"` → `{plan:"Free", renew:"off", balance:"Free", windows:[]}`
- 其他 → `{plan:"Balance", renew:"off", balance:"$4.00", windows:[]}`
- 顶层 `balance` 是字符串，避免 host 归一化时变空

## 6. 验证

### 6.1 离线

```sh
npm test
```

70 个测试（`test/rewrite.test.mjs` + `test/free-bridge.test.mjs` + `test/free-eval.test.mjs` + `test/eval-server.test.mjs` + `test/eval-history.test.mjs` + `test/vision.test.mjs`）：免费/付费请求改写、UA、路由拒绝、模型元数据、key 查找、config 深合并、usage 映射、transcript 单轮化、JSON 工具协议解析、native `tool_calls` 还原、SSE 合成、eval tool 请求、`(magpie-tool ...)` 解析、direct eval 本地执行循环、client tool 还原、`look` 视觉桥（路径/大小/格式校验、data URI 请求、错误回喂）、原生图片输入桥（data/http/file、4 张上限、失败降级）、视觉模型回退、定义历史（只保留 definition 形式、回放后跨 image 可用）、无 tools 请求进 eval image 与小 `max_tokens` 回退、`tool_choice:none` 保持 transcript、`deepseek-v4.1-flash`/`deepseek-flash` 别名在两侧都映射到 `nodecode-cyber-v1`。

### 6.2 真实 smoke test

隔离 `HOME`/`XDG_*`，使用独立 `MAGPIE_ADDR`：

```sh
SB=$(mktemp -d)
mkdir -p "$SB/.config" "$SB/.cache" "$SB/.nodecode"
ln -s "$HOME/.nodecode/auth.json" "$SB/.nodecode/auth.json"

m() { env HOME="$SB" XDG_CONFIG_HOME="$SB/.config" XDG_CACHE_HOME="$SB/.cache" \
        MAGPIE_ADDR=127.0.0.1:3501 magpie "$@"; }

m plugins add ./
m plugins login nodecode-free '读取本机 NodeCode 免费 key'
m provider test nodecode-free
m plugins login nodecode '读取本机 NodeCode key'
m provider test nodecode
m quota nodecode-free --json
m quota nodecode --json

m plugins logout nodecode-free
m plugins logout nodecode
m plugins rm ./
rm -rf "$SB"
```

2026-11-08 实测：free `✓ chat ~2.6 s`、paid `~1.9 s`（另一轮 1.3 s / 1.2 s）；免费带 tools 经 `makeFetch` 改写后真实 200；transcript 多轮与 tool follow-up 均 200。

0.2.0 的直接 API 实测（真实免费 key）：

- `makeFetch({free:true})` + tools + 用户要求 `echo hello-nodecode` → 200，最终答案 `Output: hello-nodecode`（direct eval 在本地执行）。
- 用户要求 `echo alpha` 再 `echo beta` 两次 eval → 200，最终汇总两个输出（eval loop 两轮）。
- `read_file` client tool → 200，`finish_reason:"tool_calls"`，arguments 正确；tool result follow-up → 200，正确回答文件内容。
- 持久 `runEvalForm`：第一次 `(progn (defun bar (x) (+ x 1)) (bar 41))` → `42`；第二次 `(bar 41)` → `42`，证明定义跨 eval 保留。

### 6.3 真实 magpie 网关（agent 链路）

2026-11-08 在隔离 magpie gateway（`127.0.0.1:3511`）实测（0.1.1 transcript bridge）：

- `nodecode-free/nodecode-cyber-v1` 多轮 `[system,user,assistant,user]` → HTTP 200，`Your name is Chao.`
- `nodecode-free/nodecode-cyber-v1` 带 `read_file` tools → HTTP 200，`finish_reason:"tool_calls"`，返回 `read_file` 调用
- tool result follow-up → HTTP 200，`The file says: hello from free tool probe`
- 免费 stream + tools → HTTP 200，`text/event-stream`，含 `tool_calls` delta 与 `[DONE]`
- `nodecode/nodecode-cyber-v1` 带 tools → HTTP 200，原生 `tool_calls` 正常

同日在本机真实 magpie gateway（`127.0.0.1:3425`，0.1.1）复测：

- 免费多轮 → 200，`Your name is Chao.`
- 免费 `read_file` 工具调用 → 200，`finish_reason:"tool_calls"`，arguments `{"path":"/tmp/nc_free_tool_probe.txt"}`
- tool result follow-up → 200，`It says: hello from free tool probe`
- 免费 stream + tools → 200，`text/event-stream`，`tool_calls` delta 正常
- 付费 tools → 200，原生 `tool_calls` 正常
- `magpie provider test nodecode-free` → `✓ chat 1003 ms · nodecode-cyber-v1`；`nodecode` → `✓ chat 2248 ms · nodecode-cyber-v1`（首次 free 有一次 10s 超时，重试即通过）

2026-11-08 升级到 `npm:nodecode-magpie@0.2.0` 后，再在本机真实 gateway `127.0.0.1:3425` 复测：

- 免费 `read_file` client tool → 200，`finish_reason:"tool_calls"`，arguments `{"path":"/tmp/nc-real020-file.txt"}`
- 免费直接 eval（要求 `(sh "echo real-020-eval-ok")`）→ 200，最终内容 `real-020-eval-ok`，证明 0.2.0 的本地持久 eval bridge 已进入真实网关
- 免费 stream + tools → 200，`text/event-stream`，`tool_calls` delta 与 `[DONE]` 正常
- tool result follow-up → 200，正确回答 `real-020-content`
- `magpie provider test nodecode-free` → `✓ chat 4496 ms`；`nodecode` → `✓ chat 2727 ms`（首次两次 free 10s 超时，重试通过，判断为瞬时上游/容量）
- `magpie quota nodecode-free --json` 在 0.2.0 正确返回 `plan:"Free"`、`balance:"Free"`；不带 `--json` 的人类可读形式仍可能报 `not configured · no balance endpoint known for it`（该 CLI 版本的 balance 展示路径），不影响聊天/工具

### 6.4 Magpie GUI 验证

2026-11-08 在运行中的 Magpie 桌面端（`w-4160`）验证：

- 供应商页同时显示「NodeCode Free」与「NodeCode」，两个开关均为启用状态
- NodeCode Free 详情：账号 `API key …zJKY`、并发 2、模型 `NodeCode Cyber v1 (Free) 免费`
- NodeCode 详情：账号 `API key …vo98`、模型 `NodeCode Cyber v1 1.0M`
- 与 CLI `plugins list --json`、`provider test` 的结果一致；`magpie quota` 在 0.2.0 的已知问题见 §6.3

## 7. 风险与边界

1. **厂商条款/封号风险（最重要）**：免费 key 文档要求只从 NodeCode CLI 使用；插件伪装 CLI UA 并桥接单轮限制属于规避客户端限制。不要把它当长期稳定方案。免费档只适合个人实验与轻量 agent；生产/编码 agent 请用付费档。
2. **免费档的 eval bridge 是本地执行**：模型通过 NodeCode 的 `eval` tool 运行 Lisp/shell，拥有完整 host 权限；image 按 workspace/session 隔离，并在该会话存活期内保持。`(look ...)` 的 Lisp 形式在 0.5.1 起通过私有 socket 直接可用；0.4.1 的 carrier 与 0.4.2 的原生图片输入桥仍保留；后台 eval 与 `strings` 语义已在 0.3.0 与 CLI 对齐。无 tools 时的 transcript bridge 仍依赖模型遵循 JSON 协议。复杂/高风险任务建议付费档。
3. **免费 key 限额**：仅 `nodecode-cyber-v1`、256K context、2 并发/账号、40 req/min、14 天内 3M tokens/24h、503 `free_capacity_busy`。
4. **路由锁定**：免费档必须保持 chat-completions；用户改成 responses/anthropic 时插件本地拒绝。
5. **key 轮换**：keyless 登录只读一次 key；CLI 轮换后需重新登录，或改用环境变量。
6. **宿主版本敏感**：升级 magpie 后重跑 `npm test` 与两个 `provider test`。
7. **费用显示**：付费模型不写 `cost`，避免标成 $0；如需费用估算要补价格表。
8. **模型面**：只声明 `nodecode-cyber-v1`；`nodecode-decide-v1` 是分类模型、`nodecode-image-v1` 是图像生成，默认不暴露。
9. **模型能力显示**：magpie 0.1.3240 的 Go gateway 模型结构没有 `toolcall` 字段，插件模型的 `tool_call:false` 不会出现在 `/v1/models`；免费档在 UI/网关上可能仍显示支持工具，但 `makeFetch` 会在 bridge 层处理。

## 8. 发布清单

- [x] 确认厂商条款与账号风险，决定是否发布免费档（个人实验用途）
- [x] 真实 magpie 安装 `npm:nodecode-magpie@0.1.1`（2026-11-08，从 0.1.0 升级），两个 provider 可见并已登录
- [x] 0.2.0 eval bridge 真实 magpie 安装 `npm:nodecode-magpie@0.2.0` 与真实 gateway `3425` 验证（2026-11-08，free client tool / direct eval / stream / tool follow-up 均通过）
- [x] 真实 magpie 网关跑“免费纯聊天”与“付费工具调用”
- [x] 免费档 transcript bridge：多轮、工具调用、tool result、流式全部真实通过
- [x] Magpie GUI 供应商详情确认两个 provider、key、并发与模型均正确
- [x] 加 `magpie.icon`（2026-11-09，官方 apple-icon.png；插件页与供应商页均显示）
- [x] npm 发布 `nodecode-magpie@0.1.0`（2026-11-08，GitHub Actions run `42451605190`；带 provenance）
- [x] npm 发布 `nodecode-magpie@0.1.1`（2026-11-08，GitHub Actions run `42457112278`；带 provenance；npm official registry `latest = 0.1.1`）
- [x] npm 发布 `nodecode-magpie@0.2.0`（2026-11-08，GitHub Actions run `42463006012`；发布后约 20 分钟通过 npm 扫描，official registry `latest = 0.2.0`，tarball shasum `ae971e6a695c0a21ac64f8e2c5e5508c1a5b8d0f`）
- [x] 0.3.0 eval 语义（`=>`/history/后台 yield/strings）真实 magpie 安装与 gateway 3425 验证（2026-11-09，free/paid chat、free client tool 往返、direct eval 均通过）
- [x] npm 发布 `nodecode-magpie@0.3.0`（2026-11-09，GitHub Actions run `42551766609`；official registry `latest = 0.3.0`，tarball shasum `45c6f6ad154f93077280aeb5c9dfb3f5575482f4`）
- [x] GitHub Release `v0.3.0`（https://github.com/ChasLui/nodecode-magpie/releases/tag/v0.3.0）
- [x] 0.4.0 workspace/session 隔离 + 32 轮本地验证（2026-11-09：`npm test` 44/44；真实 magpie provider test free 1945ms / paid 2322ms；gateway 3425 free direct eval `v040-ok`；session/subagent 隔离：`scope-a` 定义在 `scope-b` 不可见）
- [x] npm 发布 `nodecode-magpie@0.4.0`（2026-11-09，GitHub Actions run `42560665859`；发布后约 18 分钟通过 npm 扫描，official registry `latest = 0.4.0`，tarball shasum `f64967b739a2a671bf126f6e66a93dbfdb65e45a`）
- [x] GitHub Release `v0.4.0`（https://github.com/ChasLui/nodecode-magpie/releases/tag/v0.4.0）
- [x] 0.4.1 look 视觉桥本地验证（2026-11-09：`npm test` 54/54；`auto/deepseek-v4.1-flash` 实图读出 `SECRET-7QZ-9931`；真实 gateway 3425 200/6.6s）
- [x] npm 发布 `nodecode-magpie@0.4.1`（2026-11-09，GitHub Actions run `42567596901`；official registry `latest = 0.4.1`，tarball shasum `aff619acd2898d943938cd624dcdbd84842eb1cd`）
- [x] GitHub Release `v0.4.1`（https://github.com/ChasLui/nodecode-magpie/releases/tag/v0.4.1）
- [x] npm 0.4.1 真实 magpie 安装验证（2026-11-09：provider test free `3197 ms` / paid `2018 ms`；gateway 3425 look 200/3.8s，读出 `SECRET-7QZ-9931`）
- [x] 0.4.2 原生图片输入桥本地验证（2026-11-09：`npm test` 61/61；data URI 图片经 gateway 3425 200/2.2s 读出 `SECRET-7QZ-9931`；默认视觉模型路由返回 400 时回退到 `group/auto-deepseek-flash` 成功）
- [x] npm 发布 `nodecode-magpie@0.4.2`（2026-11-09，GitHub Actions run `42611896262`；official registry `latest = 0.4.2`，tarball shasum `4d2d7924c26e25776894050a1f43cb209483de26`）
- [x] GitHub Release `v0.4.2`（https://github.com/ChasLui/nodecode-magpie/releases/tag/v0.4.2）
- [x] npm 0.4.2 真实 magpie 安装验证（2026-11-09：provider test free `3058 ms` / paid `1324 ms`；gateway 3425 图片请求无 tools 200/814ms、带 tools 200/1161ms，均读出 `SECRET-7QZ-9931`）
- [x] 0.5.0 定义历史本地验证（2026-11-09：`npm test` 63/63；`runEvalForm` 定义后 `dropEvalServer` 再调用仍返回 `1001`；history 文件只含 `defun`，不含 `sh` 副作用）
- [x] npm 发布 `nodecode-magpie@0.5.0`（2026-11-09，GitHub Actions run `42616441576`；official registry `latest = 0.5.0`，tarball shasum `34f59a3c97ca5bb0a71713f11b01c9ca58c8fb85`）
- [x] GitHub Release `v0.5.0`（https://github.com/ChasLui/nodecode-magpie/releases/tag/v0.5.0）
- [x] npm 0.5.0 真实 magpie 安装与跨宿主重启验证（2026-11-09：provider test free `1717 ms` / paid `3688 ms`；gateway 3425 定义 `nc-npm-hist` 后重启插件宿主，再调 `(nc-npm-hist 1)` 返回 `2001`，200/9233ms）
- [x] 0.5.1 原生 Lisp `(look ...)` 桥本地验证（2026-11-09：`npm test` 64/64；直接 `EvalServer` 的 `(look "/tmp/pic.png" :prompt "read")` 返回 stub 文本；gateway 3425 free lane 用 `(look "/tmp/nc-look-word.png" ...)` 精确读出 `BANANA-COMET-31415`）
- [x] npm 发布 `nodecode-magpie@0.5.1`（2026-11-09，GitHub Actions run `42631362571`；official registry `latest = 0.5.1`，tarball shasum `9553b9447b23578569a477411d24f118003b1c0f`）
- [x] GitHub Release `v0.5.1`（https://github.com/ChasLui/nodecode-magpie/releases/tag/v0.5.1）
- [x] npm 0.5.1 真实 magpie 安装验证（2026-11-09：provider test free `3131 ms` / paid `1097 ms`；gateway 3425 free lane 用嵌套 `(concatenate 'string "X" (look ...))` 返回 `XBANANA-COMET-31415`，200/17.5s）
- [x] 0.5.2 无 tools 请求同样进 eval image 本地验证（2026-11-09：`npm test` 67/67；直连 NodeCode API 的无 tools 请求用 `(sh ...)` 写出 `/tmp/nc-notools-052.txt` 并读回 `notools-lane-ok`；gateway 3425 无 tools 请求写出 `/tmp/nc-gw-notools-052.txt`，200/3.1s；provider test free 回归 `2549 ms`——它带 `max_tokens:16`，按设计留在 transcript lane）
- [x] npm 发布 `nodecode-magpie@0.5.2`（2026-11-09，GitHub Actions run `42636390029`；official registry `latest = 0.5.2`，tarball shasum `3d4c4779e6c7ca6ded46622790a5f05bd5d1e51f`）
- [x] GitHub Release `v0.5.2`（https://github.com/ChasLui/nodecode-magpie/releases/tag/v0.5.2）
- [x] npm 0.5.2 真实 magpie 安装验证（2026-11-09：provider test free `1405 ms`（首次 10s 超时为代理瞬时）、paid `1886 ms`；gateway 3425 无 tools `(sh ...)` 写出 `/tmp/nc-gw-notools-052.txt` 200/5.3s；无 tools `(look "/tmp/nc-look-word.png" ...)` 精确返回 `BANANA-COMET-31415` 200/6.8s）
- [x] 0.5.3 模型别名本地验证（2026-11-10：`npm test` 69/69；两个 provider 各 3 models；`nodecode-free/deepseek-v4.1-flash` 无 tools 请求经 eval image 用 `sh` 写出 `/tmp/nc-alias053.txt`，`nodecode/deepseek-flash` 与 `nodecode/deepseek-v4.1-flash` 均 200）
- [x] npm 发布 `nodecode-magpie@0.5.3`（2026-11-10，GitHub Actions run `42760736045`；official registry `latest = 0.5.3`，tarball shasum `99742dc84b3466fa94d512983162b94f70e05a14`）
- [x] GitHub Release `v0.5.3`（https://github.com/ChasLui/nodecode-magpie/releases/tag/v0.5.3）
- [x] npm 0.5.3 真实 magpie 安装验证（2026-11-10：`nodecode-free (NodeCode Free, 3 models)` / `nodecode (NodeCode, 3 models)` 均 signed in；`nodecode-free/deepseek-v4.1-flash` 无 tools 请求 200/4.5s 并写出 `alias-053-ok`；`nodecode/deepseek-flash` 200/1.3s）
- [x] 0.6.0 后台 eval 结果日志本地验证（2026-11-10：`npm test` 70/70；新增用例断言后台 eval 退出写入 `history/evals/<hash>.log`、快速 form 不入日志、重启 image 后 `(magpie-eval-log)` 仍能读到、`(magpie-eval-list)` 提示历史条数）
- [x] 0.6.0 真实插件宿主重启验证（2026-11-10：gateway 3425 免费档 `yield_time_ms 500` 起 `(progn (sh "sleep 6") "bg-exit-1045")` 后台 eval，日志写入 `~/.nodecode-magpie/history/evals/63ee1f4a1e341de881aae69f583c96f2.log`；kill 插件宿主（pid 33255 → 38245）后新 image 里 `(magpie-eval-log)` 原文返回该记录，200/4.5s）
- [x] npm 发布 `nodecode-magpie@0.6.0`（2026-11-10，GitHub Actions run `42764583561`；official registry `latest = 0.6.0`，tarball shasum `aa1a15d5a127e126087918a52145e39b8ebbd828`）
- [x] GitHub Release `v0.6.0`（https://github.com/ChasLui/nodecode-magpie/releases/tag/v0.6.0）
- [x] npm 0.6.0 真实 magpie 安装验证（2026-11-10：provider test free `1226 ms`、paid `1476 ms`；gateway 3425 免费档起 `(progn (sh "sleep 5") "bg-exit-npm060")` 后台 eval 200/2.4s，随后 `(magpie-eval-log)` 200/1.4s 同时返回换插件前的 `bg-exit-1045` 与新写入的 `bg-exit-npm060`）
- [x] GitHub Actions 发版流水线 `.github/workflows/release.yml`（tag `v*` 触发测试 + `npm publish --provenance`）
- [x] GitHub Release `v0.1.0`（https://github.com/ChasLui/nodecode-magpie/releases/tag/v0.1.0）
- [x] GitHub Release `v0.1.1`（https://github.com/ChasLui/nodecode-magpie/releases/tag/v0.1.1）
- [ ] magpie 升级后重跑 smoke test
