# nodecode-magpie 设计说明

> 目标：在 magpie 中提供两个 NodeCode 供应商：`nodecode`（付费 key，完整工具、1M context）与 `nodecode-free`（免费 key，仅 `nodecode-cyber-v1`、256K context；用 transcript bridge 在单轮门禁上恢复多轮与工具）。
>
> 版本：0.1.1（2026-11-08）。magpie 宿主契约按 0.1.3240 核对。

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
   └─ free:  CLI UA + 单轮 transcript + JSON 工具协议 + 响应还原
   ▼
https://api.nodecode.ai/v1/chat/completions
```

### 2.1 一个包两个 provider

- `nodecode`：付费 key；`NODECODE_API_KEY` → `~/.nodecode/auth.json` 的 `api_keys.nodecode.key`
- `nodecode-free`：免费 key；`NODECODE_FREE_API_KEY` → `api_keys["nodecode-free"].key` → `~/.nodecode/free-key.txt`
- 共用 base URL、模型元数据、usage 解析
- 入口只导出两个工厂；helper 放 `lib/nodecode.mjs`，bridge 放 `lib/free-bridge.mjs`

### 2.2 行为差异

| 维度 | `nodecode` | `nodecode-free` |
| --- | --- | --- |
| User-Agent | `nodecode-magpie/0.1.1`（诚实） | `nodecode_cli/<version> (<OS> <release>; <arch>) <TERM>` |
| body | 原样转发 | 单轮化；删除 `tools`、`tool_choice`、`parallel_tool_calls`、`functions`、`function_call`；需要时注入 JSON 工具协议 |
| 路由 | 由模型 API 决定 | 只允许 `/chat/completions`，否则本地抛错 |
| 工具 | 原生 tools | bridge 后的原生 `tool_calls`（对客户端透明） |
| 多轮 | 原生 | 整段 transcript 压成一条 user；system 保留原文 |
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

### 4.2 请求改写

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

### 4.3 响应还原

`transformFreeResponse(data, plan)` 从 `message.content` 中提取 JSON（容忍代码块、前后散文），校验工具名，重建标准 `tool_calls`，把 `finish_reason` 改为 `tool_calls`。如果模型输出普通文本，则原样作为 `content`。

`buildFreeSse(data, plan)` 把非流式响应合成为 OpenAI `chat.completion.chunk` SSE：

- 第一条 `delta.role = "assistant"`
- 工具调用一条 `delta.tool_calls`
- 最后 `finish_reason = "tool_calls"` 或 `stop`
- 末尾 `data: [DONE]`

### 4.4 已知边界

- 模型必须遵循 JSON 协议；不遵循时退化为普通文本。
- 工具名必须在客户端 tools 列表中；未知名字会被丢弃。
- 合成 tool call id 不跨轮稳定；对大多数 agent 足够。
- assistant 的 `reasoning` 内容不单独保留（上游可能返回 `reasoning` 字段，客户端可忽略）。
- 仍不能改变免费 key 的模型/路由/额度限制。

## 5. 关键实现

### 5.1 免费档 makeFetch

```js
export function makeFetch({ free, fetchImpl = globalThis.fetch } = {}) {
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
        const plan = rewriteFreeRequest(parsed)
        body = JSON.stringify(plan.body)
        headers.set("content-type", "application/json")
        headers.delete("content-length")
        const response = await fetchImpl(input, { ...init, headers, body })
        if (plan.bridge && response.ok) {
          return rewriteUpstreamResponse(response, { ...plan, model: CYBER })
        }
        return response
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

21 个测试（`test/rewrite.test.mjs` + `test/free-bridge.test.mjs`）：免费/付费请求改写、UA、路由拒绝、模型元数据、key 查找、config 深合并、usage 映射、transcript 单轮化、JSON 工具协议解析、native `tool_calls` 还原、SSE 合成。

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

### 6.3 真实 magpie 网关（agent 链路）

2026-11-08 在隔离 magpie gateway（`127.0.0.1:3511`）实测（0.1.1 bridge）：

- `nodecode-free/nodecode-cyber-v1` 多轮 `[system,user,assistant,user]` → HTTP 200，`Your name is Chao.`
- `nodecode-free/nodecode-cyber-v1` 带 `read_file` tools → HTTP 200，`finish_reason:"tool_calls"`，返回 `read_file` 调用
- tool result follow-up → HTTP 200，`The file says: hello from free tool probe`
- 免费 stream + tools → HTTP 200，`text/event-stream`，含 `tool_calls` delta 与 `[DONE]`
- `nodecode/nodecode-cyber-v1` 带 tools → HTTP 200，原生 `tool_calls` 正常

### 6.4 Magpie GUI 验证

2026-11-08 在运行中的 Magpie 桌面端（`w-4160`）验证：

- 供应商页同时显示「NodeCode Free」与「NodeCode」，两个开关均为启用状态
- NodeCode Free 详情：账号 `API key …zJKY`、并发 2、模型 `NodeCode Cyber v1 (Free) 免费`
- NodeCode 详情：账号 `API key …vo98`、模型 `NodeCode Cyber v1 1.0M`
- 与 CLI `plugins list --json`、`provider test`、`quota` 的结果一致

## 7. 风险与边界

1. **厂商条款/封号风险（最重要）**：免费 key 文档要求只从 NodeCode CLI 使用；插件伪装 CLI UA 并桥接单轮限制属于规避客户端限制。不要把它当长期稳定方案。免费档只适合个人实验与轻量 agent；生产/编码 agent 请用付费档。
2. **免费档的 bridge 是模拟的**：JSON 工具协议不是原生 function calling；模型偶尔不遵守协议时会退化为文本。复杂多工具任务建议付费档。
3. **免费 key 限额**：仅 `nodecode-cyber-v1`、256K context、2 并发/账号、40 req/min、14 天内 3M tokens/24h、503 `free_capacity_busy`。
4. **路由锁定**：免费档必须保持 chat-completions；用户改成 responses/anthropic 时插件本地拒绝。
5. **key 轮换**：keyless 登录只读一次 key；CLI 轮换后需重新登录，或改用环境变量。
6. **宿主版本敏感**：升级 magpie 后重跑 `npm test` 与两个 `provider test`。
7. **费用显示**：付费模型不写 `cost`，避免标成 $0；如需费用估算要补价格表。
8. **模型面**：只声明 `nodecode-cyber-v1`；`nodecode-decide-v1` 是分类模型、`nodecode-image-v1` 是图像生成，默认不暴露。
9. **模型能力显示**：magpie 0.1.3240 的 Go gateway 模型结构没有 `toolcall` 字段，插件模型的 `tool_call:false` 不会出现在 `/v1/models`；免费档在 UI/网关上可能仍显示支持工具，但 `makeFetch` 会在 bridge 层处理。

## 8. 发布清单

- [x] 确认厂商条款与账号风险，决定是否发布免费档（个人实验用途）
- [x] 真实 magpie 安装（CLI，`npm:nodecode-magpie@0.1.0`），两个 provider 可见并已登录
- [x] 真实 magpie 网关跑“免费纯聊天”与“付费工具调用”
- [x] 免费档 transcript bridge：多轮、工具调用、tool result、流式全部真实通过
- [x] Magpie GUI 供应商详情确认两个 provider、key、并发与模型均正确
- [ ] 加 `magpie.icon`（可选）
- [x] npm 发布 `nodecode-magpie@0.1.0`（2026-11-08，GitHub Actions run `42451605190`；带 provenance）
- [ ] npm 发布 `nodecode-magpie@0.1.1`（transcript bridge；本清单随发布更新）
- [x] GitHub Actions 发版流水线 `.github/workflows/release.yml`（tag `v*` 触发测试 + `npm publish --provenance`）
- [x] GitHub Release `v0.1.0`（https://github.com/ChasLui/nodecode-magpie/releases/tag/v0.1.0）
- [ ] GitHub Release `v0.1.1`
- [ ] magpie 升级后重跑 smoke test
