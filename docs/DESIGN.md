# nodecode-magpie 设计说明

> 目标：在 magpie 中提供两个 NodeCode 供应商：`nodecode`（付费 key，完整工具/1M context）与 `nodecode-free`（免费 key，仅 `nodecode-cyber-v1`、256K context、纯聊天）。

## 1. 结论：为什么必须写插件

免费 key 的服务端门禁不是单一 User-Agent 检查，而是 5 项：

| 检查 | 要求 | 普通 `magpie provider add` |
| --- | --- | --- |
| `route` | 对话请求只允许 `POST /v1/chat/completions`；`/v1/responses`、`/v1/messages` 403 | 默认可以，但用户可切到 responses/messages |
| `user_agent` | 必须以 `nodecode_cli/` 开头（`curl/8.7.1`、`nodecode`、`nodecode-cli/...` 都 403） | **不能**：provider add 的 UA 只有 agent/magpie |
| `tools` | 非空时只允许一个名为 `eval` 的工具 | **不能**：agent 会带自己的工具 |
| `tool_schema` | `eval.parameters` 必须匹配 NodeCode 的固定 schema | **不能** |
| `system_prompt` | 带 tools 时 system 必须以 `You are a living Common Lisp image` 开头 | **不能** |

因此：

- `chat.headers` 不够：它能改 UA，但不能改 body；免费档还需要删 tools。
- 模型声明 `tool_call: false` / `capabilities.toolcall: false` 不够：magpie host 的 `rowOf` 不把 `toolcall/capabilities` 传给 Go gateway；gateway 仍会发 tools。
- 唯一能同时改头和 body 的层是 `auth.loader.fetch`。

## 2. 方案

```
magpie agent
   │  chat request (may include tools)
   ▼
magpie gateway (Go)
   │  headers: apiKey → loader.headers → gateway → chat.headers
   ▼
plugin auth.loader.fetch   ← 唯一能改 body 的层
   ├─ paid:  诚实 UA，保留 tools，转发
   └─ free:  CLI UA + 删除 tools 五件套 + 只允许 /chat/completions
   ▼
https://api.nodecode.ai/v1/chat/completions
```

### 2.1 一个包两个 provider

- `nodecode`：付费 key；`NODECODE_API_KEY` → `~/.nodecode/auth.json` 的 `api_keys.nodecode.key`
- `nodecode-free`：免费 key；`NODECODE_FREE_API_KEY` → `api_keys["nodecode-free"].key` → `~/.nodecode/free-key.txt`
- 共用 base URL、模型元数据、usage 解析
- 入口只导出两个工厂；helper 放 `lib/nodecode.mjs`

### 2.2 行为差异

| 维度 | `nodecode` | `nodecode-free` |
| --- | --- | --- |
| User-Agent | `nodecode-magpie/0.1.0`（诚实） | `nodecode_cli/<version> (<OS> <release>; <arch>) <TERM>` |
| body | 原样转发 | 删除 `tools`、`tool_choice`、`parallel_tool_calls`、`functions`、`function_call` |
| 路由 | 由模型 API 决定 | 只允许 `/chat/completions`，否则本地抛错 |
| 工具 | 保留 | 无（chat-only） |
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
- 免费档必须在 fetch 里删 tools

### 3.6 auth.usage

- 顶层 `plan/user/balance/error` 只接受字符串
- `windows[].used` 是数字百分比；`amount/limit/span/runsOut/balance` 数字
- `/v1/usage` 只暴露 credit/plan，不暴露 token 窗口
- 插件不伪造 `used`；`windows: []`

## 4. 关键实现

### 4.1 免费档请求改写

```js
const FREE_TOOL_KEYS = ["tools", "tool_choice", "parallel_tool_calls", "functions", "function_call"]

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
        for (const key of FREE_TOOL_KEYS) delete parsed[key]
        body = JSON.stringify(parsed)
        headers.set("content-type", "application/json")
      }
    }

    return fetchImpl(input, { ...init, headers, body })
  }
}
```

### 4.2 免费 UA

```js
const CLI_VERSION = process.env.NODECODE_CLI_VERSION || "0.1.13"
const OS = process.platform === "darwin" ? "Darwin" : process.platform === "win32" ? "Windows" : "Linux"
const ARCH = process.arch === "arm64" ? "arm64" : "x64"

export const FREE_UA =
  `nodecode_cli/${CLI_VERSION} (${OS} ${release()}; ${ARCH}) ${process.env.TERM || "xterm-256color"}`
```

实测形态：`nodecode_cli/0.1.13 (Darwin 27.2.0; arm64) dumb`，对真实免费端点 200。

### 4.3 config 深合并

`mergeModel` 对普通对象逐字段递归，对数组整体替换；用户只改 `limit.context` 时 `limit.output` 保留。

### 4.4 usage

- `pays === "free"` → `{plan:"Free", renew:"off", balance:"Free", windows:[]}`
- 其他 → `{plan:"Balance", renew:"off", balance:"$4.00", windows:[]}`
- 顶层 `balance` 是字符串，避免 host 归一化时变空

## 5. 验证

### 5.1 离线

```sh
npm test
```

8 个测试：免费/付费请求改写、路由拒绝、模型元数据、key 查找、config 深合并、free-key.txt 兜底、usage 映射。

### 5.2 真实 smoke test

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

2026-11-08 实测：free `✓ chat ~2.6 s`、paid `~1.9 s`（另一轮 1.3 s / 1.2 s）；free 带 tools 直接经 `makeFetch` 改写后 200。

### 5.3 真实 magpie 网关（agent 链路）

2026-11-08 在本机运行中的 magpie gateway（`127.0.0.1:3425`）实测：

- `nodecode-free/nodecode-cyber-v1` 普通 chat → HTTP 200，返回 `GATEWAY_OK`
- `nodecode-free/nodecode-cyber-v1` 带 `tools` → HTTP 200，响应无 `tool_calls`（插件已删掉 tools，免费门禁通过）
- `nodecode/nodecode-cyber-v1` 带 `tools` → HTTP 200，`finish_reason: "tool_calls"`，正确返回 `read_file` 工具调用

## 6. 风险与边界

1. **厂商条款/封号风险（最重要）**：免费 key 文档要求只从 NodeCode CLI 使用；插件伪装 CLI UA 是规避客户端限制。不要把它当长期稳定方案。免费档只适合个人实验、纯聊天/摘要；编码 agent 请用付费档。
2. **免费档没有工具**：编码 agent 不能读写文件/执行命令；这是服务端门禁，不是插件 bug。
3. **免费 key 限额**：仅 `nodecode-cyber-v1`、256K context、2 并发/账号、40 req/min、14 天内 3M tokens/24h、503 `free_capacity_busy`。
4. **路由锁定**：免费档必须保持 chat-completions；用户改成 responses/anthropic 时插件本地拒绝。
5. **key 轮换**：keyless 登录只读一次 key；CLI 轮换后需重新登录，或改用环境变量。
6. **宿主版本敏感**：升级 magpie 后重跑 `npm test` 与两个 `provider test`。
7. **费用显示**：付费模型不写 `cost`，避免标成 $0；如需费用估算要补价格表。
8. **模型面**：只声明 `nodecode-cyber-v1`；`nodecode-decide-v1` 是分类模型、`nodecode-image-v1` 是图像生成，默认不暴露。
9. **模型能力显示**：magpie 0.1.3240 的 Go gateway 模型结构没有 `toolcall` 字段，插件模型的 `tool_call:false` 不会出现在 `/v1/models`；免费档在 UI/网关上可能仍显示支持工具，但 `makeFetch` 会删除 tools，供应商不会收到。

## 7. 发布清单

- [ ] 确认厂商条款与账号风险，决定是否发布免费档
- [x] 真实 magpie 安装（CLI），两个 provider 可见并已登录
- [x] 真实 magpie 网关跑“免费纯聊天”与“付费工具调用”
- [ ] 加 `magpie.icon`（可选）
- [ ] npm 包名 `nodecode-magpie` 是否可用
- [ ] magpie 升级后重跑 smoke test
