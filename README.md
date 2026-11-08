# nodecode-magpie

Two magpie providers in one package:

| Provider | Key | Context | Tools | Model |
| --- | --- | --- | --- | --- |
| `nodecode` | paid `sk-nc-…` | 1,048,576 | yes | `nodecode-cyber-v1` |
| `nodecode-free` | free `sk-nc-…` | 262,144 | **no** (stripped) | `nodecode-cyber-v1` |

Both talk to `https://api.nodecode.ai/v1` over the OpenAI Chat Completions wire.

Design notes and magpie 0.1.3240 contract details: [docs/DESIGN.md](./docs/DESIGN.md).

## Why a plugin is required

The free key is gated server-side by five checks: `route`, `user_agent`,
`tools`, `tool_schema`, and `system_prompt`. A plain `magpie provider add`
cannot pass them:

- the provider's User-Agent can only be `agent` or `magpie`;
- the free key only accepts `POST /v1/chat/completions`;
- a non-empty `tools` array must be exactly Nodecode's `eval` tool, and then
  the system prompt must start with the Nodecode Lisp prompt.

`magpie`'s model capability (`tool_call: false` / `capabilities.toolcall`)
is not propagated to the Go gateway, so it cannot stop the gateway from
sending tools. The plugin must rewrite the outgoing request in
`auth.loader.fetch` — the one layer that sees `init.body` as a string.

This plugin sets the CLI-shaped User-Agent and, for the free provider, deletes
`tools`, `tool_choice`, `parallel_tool_calls`, `functions`, and `function_call`
from the JSON body. It also refuses non-chat-completions routes before they
reach Nodecode.

## Install

From a local checkout:

```sh
magpie plugins add /abs/path/to/nodecode-magpie
```

From npm / git once published:

```sh
magpie plugins add nodecode-magpie
magpie plugins add github:ChasLui/nodecode-magpie
```

`magpie plugins add` restarts the plugin host. Local-path plugins are loaded in place,
not copied; after editing, remove and re-add (or `magpie plugins update`) to restart.

## Sign in

The first method is `keyless: true` and reads a local key without prompting:

```sh
magpie plugins login nodecode-free '读取本机 NodeCode 免费 key'
magpie plugins login nodecode '读取本机 NodeCode key'
```

The second method accepts a pasted key. Key lookup order:

- paid: `NODECODE_API_KEY`, then `~/.nodecode/auth.json` → `api_keys.nodecode.key`
- free: `NODECODE_FREE_API_KEY`, then `auth.json` → `api_keys["nodecode-free"].key`,
  then `~/.nodecode/free-key.txt`

The plugin only reads these files; it never logs or prints the key.

## Verify

```sh
magpie plugins list
magpie provider test nodecode-free
magpie provider test nodecode
magpie quota nodecode-free --json
magpie quota nodecode --json
```

A real test against the vendor with both keys passed on 2026-11-08:

```
✓ chat  ~2.6 s · nodecode-cyber-v1   (free)
✓ chat  ~1.9 s · nodecode-cyber-v1   (paid)
```

Offline tests:

```sh
node --test test/rewrite.test.mjs
```

The tests prove that the free lane removes every tool field and sets the CLI
UA, the paid lane preserves tools, and the free lane rejects non-chat routes.

## Free-key limits (vendor docs / measured)

- model: `nodecode-cyber-v1` only; another model is 403 `model_not_free`.
- route: chat requests must be `POST /v1/chat/completions`; `/v1/responses`
  and `/v1/messages` are 403 `route`.
- client: free key works only from Nodecode CLI; other clients get 403
  `free_needs_nodecode`. This plugin impersonates the CLI's User-Agent. That
  is a vendor-term risk; the vendor docs tell non-CLI clients to use a paid
  key. Use the free provider for chat/summaries, not as a general agent.
- context: 256K (paid: 1M); output ceiling 131,072, default 16K.
- concurrency: 2 requests per account (`maxConcurrency: 2` is set).
- rate: 40 req/min; 3M tokens per 24h for 14 days after the first card top-up;
  503 `free_capacity_busy` when no machine has room.
- `auth.usage` shows `plan: "Free"` and does not invent a token window.

## Configuration notes

- `config` fills defaults but preserves a user-changed provider `name`, `npm`,
  `api` (e.g. a local proxy), and per-model overrides.
- The model is pinned to `@ai-sdk/openai-compatible`, so requests use
  `/chat/completions`. Do not switch the model API to `responses` or
  `anthropic` for `nodecode-free`: the plugin rejects it with a clear error
  instead of sending an unsupported route.
- The paid provider keeps the honest `nodecode-magpie/0.1.0` UA; only the free
  provider uses the `nodecode_cli/…` shape, because only the free gate needs it.
- The plugin is a plain ESM package run by magpie's Bun host. It uses only
  `node:fs`, `node:os`, `node:path`, and the global `fetch`; the host's global
  fetch wrapper applies the configured proxy and strips `X-Magpie-*` headers.
- No helper functions are exported from `index.mjs`: magpie instantiates every
  exported function as a plugin. Helpers live in `lib/nodecode.mjs`.

## Development

```sh
npm test                 # node --test
node --test test/rewrite.test.mjs
```

The unit tests use a local HTTP server; they do not call NodeCode or need a key.

For a real sandbox smoke test, isolate `HOME`/`XDG_*` and use a separate
`MAGPIE_ADDR` so the real magpie config is never touched:

```sh
SB=$(mktemp -d)
mkdir -p "$SB/.config" "$SB/.cache" "$SB/.nodecode"
ln -s "$HOME/.nodecode/auth.json" "$SB/.nodecode/auth.json"

m() { env HOME="$SB" XDG_CONFIG_HOME="$SB/.config" XDG_CACHE_HOME="$SB/.cache" \
        MAGPIE_ADDR=127.0.0.1:3501 magpie "$@"; }

m plugins add ./            # from this checkout
m plugins login nodecode-free '读取本机 NodeCode 免费 key'
m provider test nodecode-free
rm -rf "$SB"
```

## Layout

```
package.json
index.mjs                 # two plugin factories only
lib/nodecode.mjs          # key lookup, model metadata, fetch rewrite, usage
test/rewrite.test.mjs     # offline body/UA tests
```
## License

MIT. See [LICENSE](./LICENSE).
