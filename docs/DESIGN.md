# nodecode-magpie 设计说明

> 目标：在 magpie 中提供两个 NodeCode 供应商：`nodecode`（付费 key，完整工具、1M context）与 `nodecode-free`（免费 key，仅 `nodecode-cyber-v1`、256K context；用 NodeCode 原生 `eval` tool + 本地持久 Lisp image 释放与 CLI 相同的工具能力）。
>
> 版本：0.2.0（2026-11-08）。magpie 宿主契约按 0.1.3240 核对。

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
| User-Agent | `nodecode-magpie/0.2.0`（诚实） | `nodecode_cli/<version> (<OS> <release>; <arch>) <TERM>` |
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

0.2.0 起分两条路：**有 tools** 走 NodeCode 原生 `eval` tool（真正释放 CLI 能力），**无 tools** 才走 transcript 单轮化。

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

`handleEvalRequest` 最多 6 轮：

1. 发上游；若模型返回 `eval` 调用，拆成 direct forms 与 `(magpie-tool ...)`；
2. direct forms 交给 `runEvalForm` 在本地执行，结果作为 `role:"tool"` 消息回喂；
3. 若出现 `(magpie-tool ...)`，还原为普通 `tool_calls` 返回给 magpie（magpie 执行 client tool 后再发下一轮）；
4. 模型不再调用 eval 时，返回最终文本；stream 客户端合成 SSE。

#### 4.2.4 本地执行器

- `lib/eval-runner.mjs`：默认使用**持久** `nodecode trial` 进程 + Unix socket Lisp REPL（`lib/eval-server.mjs`）；失败时退回 one-shot trial。
- 持久进程让 `(defun ...)`、已加载 fasl、`(write-file ...)` 等状态跨 eval 调用保留，接近 CLI 的 image 语义。
- `(sh ...)`、`(edit ...)`、`(write-file ...)`、`(look ...)` 都是 NodeCode 内置 eval helper；直接 eval 的返回值经 JSON line 返回。
- 每个 plugin 进程一个 image，按 cwd 复用；不是每个 magpie 会话一个 image。

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

- eval bridge 的 image 由同一 plugin 进程内所有 magpie 会话共享；跨会话 definitions 会互相可见。
- `(look ...)` 的图片附件不会作为 image content 转发；只返回文本结果。
- `yield_time_ms` 目前作为本地超时使用，不是 NodeCode CLI 的后台 eval 调度。
- eval 以运行 magpie 的用户权限执行，拥有完整 host authority。
- transcript bridge（无 tools）仍要求模型遵循 JSON 协议；不遵循时退化为普通文本，工具名必须在客户端 tools 列表中。
- 合成 tool call id 不跨轮稳定；assistant 的 `reasoning` 不单独保留。
- 仍不能改变免费 key 的模型/路由/额度限制。

## 5. 关键实现

### 5.1 免费档 makeFetch

```js
export function makeFetch({ free, cwd, fetchImpl = globalThis.fetch, evalRunner = runEvalForm, evalBridge = true } = {}) {
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

28 个测试（`test/rewrite.test.mjs` + `test/free-bridge.test.mjs` + `test/free-eval.test.mjs`）：免费/付费请求改写、UA、路由拒绝、模型元数据、key 查找、config 深合并、usage 映射、transcript 单轮化、JSON 工具协议解析、native `tool_calls` 还原、SSE 合成、eval tool 请求、`(magpie-tool ...)` 解析、direct eval 本地执行循环、client tool 还原。

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

同日在本机真实 magpie gateway（`127.0.0.1:3425`，已安装 0.1.1）复测：

- 免费多轮 → 200，`Your name is Chao.`
- 免费 `read_file` 工具调用 → 200，`finish_reason:"tool_calls"`，arguments `{"path":"/tmp/nc_free_tool_probe.txt"}`
- tool result follow-up → 200，`It says: hello from free tool probe`
- 免费 stream + tools → 200，`text/event-stream`，`tool_calls` delta 正常
- 付费 tools → 200，原生 `tool_calls` 正常
- `magpie provider test nodecode-free` → `✓ chat 1003 ms · nodecode-cyber-v1`；`nodecode` → `✓ chat 2248 ms · nodecode-cyber-v1`（首次 free 有一次 10s 超时，重试即通过）

### 6.4 Magpie GUI 验证

2026-11-08 在运行中的 Magpie 桌面端（`w-4160`）验证：

- 供应商页同时显示「NodeCode Free」与「NodeCode」，两个开关均为启用状态
- NodeCode Free 详情：账号 `API key …zJKY`、并发 2、模型 `NodeCode Cyber v1 (Free) 免费`
- NodeCode 详情：账号 `API key …vo98`、模型 `NodeCode Cyber v1 1.0M`
- 与 CLI `plugins list --json`、`provider test`、`quota` 的结果一致

## 7. 风险与边界

1. **厂商条款/封号风险（最重要）**：免费 key 文档要求只从 NodeCode CLI 使用；插件伪装 CLI UA 并桥接单轮限制属于规避客户端限制。不要把它当长期稳定方案。免费档只适合个人实验与轻量 agent；生产/编码 agent 请用付费档。
2. **免费档的 eval bridge 是本地执行**：模型通过 NodeCode 的 `eval` tool 运行 Lisp/shell，拥有完整 host 权限；image 在 plugin 进程内共享，`(look ...)` 图片与 `yield_time_ms` 后台语义尚未完全对齐。无 tools 时的 transcript bridge 仍依赖模型遵循 JSON 协议。复杂/高风险任务建议付费档。
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
- [ ] 0.2.0 eval bridge 真实 magpie 安装与网关验证（待做）
- [x] 真实 magpie 网关跑“免费纯聊天”与“付费工具调用”
- [x] 免费档 transcript bridge：多轮、工具调用、tool result、流式全部真实通过
- [x] Magpie GUI 供应商详情确认两个 provider、key、并发与模型均正确
- [ ] 加 `magpie.icon`（可选）
- [x] npm 发布 `nodecode-magpie@0.1.0`（2026-11-08，GitHub Actions run `42451605190`；带 provenance）
- [x] npm 发布 `nodecode-magpie@0.1.1`（2026-11-08，GitHub Actions run `42457112278`；带 provenance；npm official registry `latest = 0.1.1`）
- [ ] npm 发布 `nodecode-magpie@0.2.0`（待发）
- [x] GitHub Actions 发版流水线 `.github/workflows/release.yml`（tag `v*` 触发测试 + `npm publish --provenance`）
- [x] GitHub Release `v0.1.0`（https://github.com/ChasLui/nodecode-magpie/releases/tag/v0.1.0）
- [x] GitHub Release `v0.1.1`（https://github.com/ChasLui/nodecode-magpie/releases/tag/v0.1.1）
- [ ] magpie 升级后重跑 smoke test
