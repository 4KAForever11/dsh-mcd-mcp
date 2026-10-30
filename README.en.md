# dsh-mcd-mcp

[简体中文](README.md) · **English** · [繁體中文](README.zh-TW.md)

Connects the **McDonald's China MCP** (`https://mcp.mcd.cn`) into DeepSeek Harness:
paste your own token once, and every remote tool automatically becomes a native DSH tool
(with an `mcd_` prefix) — the model can then place orders, check coupons, and browse the menu directly.

> Generate your token yourself at <https://open.mcd.cn/mcp>. The plugin ships with no credentials.

## Install

```bash
dsh plugin --profile <your-profile> add ./dsh-mcd-mcp
```

Or use `plugin_manager` (`action: install_bundle`) inside DSH, pointing at this directory.

After installing, restart `dsh web` once, open **Settings → McDonald's MCP**, paste the token,
and click **Save and connect**.

## What it does

| Layer | Detail |
| --- | --- |
| Protocol | Ships a minimal MCP client: JSON-RPC 2.0 + Streamable HTTP, handshake → `tools/list` → `tools/call`, supporting both `application/json` and `text/event-stream` responses |
| Tools | Remote tools are **dynamically** registered as `mcd_<original-name>` (add or remove tools upstream, restart to resync — no code changes) |
| Fallback | `mcd_call` calls any tool by its original remote name; `mcd_tools` lists them all |
| Self-check | Two resident tools, `mcd_status` / `mcd_test`, plus a **Test connection** button in Settings |
| Storage | The token lives in `~/.dsh/dsh-mcd-mcp.json` (mode 0600) — never in the conversation context, never written into the settings patch |

Resident management tools (usable even without a token; they say plainly when nothing is configured):

- `mcd_status` — whether configured, how many tools are registered, last sync / last error
- `mcd_test` — handshake + fetch the tool list; reports elapsed time, tool count, and failure reason
- `mcd_tools` — the names and descriptions of every remote tool
- `mcd_call` — call any tool by its original remote name, arguments passed through as-is

## Tool annotations (read/write hints)

**Every** tool — the 4 resident management tools plus all dynamically registered remote tools —
carries all four annotations, with explicit `true` / `false` values: never omitted, never `undefined`.

| Annotation | Meaning |
| --- | --- |
| `readOnlyHint` | Read-only, produces no side effects |
| `destructiveHint` | May cause destructive, irreversible changes |
| `idempotentHint` | Repeated calls give the same result; safe to retry |
| `openWorldHint` | Interacts with the outside world (a remote ordering service — always `true`) |

Remote tools are resolved in two stages: if `tools/list` supplies `annotations`, each key is taken
as-is; **only missing keys are inferred from the name** — prefixes such as `query_` / `list_` /
`get_` / `calculate_`, or suffixes such as `_list` / `_detail` / `_coupons` / `_stores`, are treated
as read-only; writes like `create-order`, `party-order-create`, `delivery-create-address`, and
`mall-create-order` are treated as writable; `cancel-order` and `draw-lottery` are additionally
marked `destructive`; any unknown tool is conservatively treated as "writable, non-idempotent" —
it never masquerades as read-only.

Measured against the 35 official tools: 28 read-only, 7 writable, with `cancel_order` and
`draw_lottery` flagged destructive.

Annotations are surfaced in two places so that no host projection can drop them: an `annotations`
field on the tool definition, and a machine-readable line at the end of the description —
`hints: readOnly=… destructive=… idempotent=… openWorld=…`. Each tool also carries `presentCall`,
which returns the DSH call kind (`read` / `edit` / `delete`), so DSH can label the read/write
nature before execution.

## Endpoint and rate limits

- The endpoint defaults to `https://mcp.mcd.cn` and is configurable in Settings.
- With no token, or an invalid one, the remote returns **401 or 403**; the plugin translates these
  into "token invalid or expired" rather than silently returning an empty list.
- 429 (rate limited; officially around 600 requests/minute) is retried twice with backoff. Other
  errors are never retried, to avoid duplicated side effects such as placing an order twice.

## Credential safety

**The repository contains no tokens, and never will.** Concretely:

- The token exists only in `~/.dsh/dsh-mcd-mcp.json` (mode 0600) on your machine, and that path is
  explicitly excluded in `.gitignore`;
- Tests use a local mock server and a fake token — they neither read nor write your real config;
- `npm test` first runs `scripts/check-secrets.mjs`, which scans every git-tracked file: it looks
  for common credential shapes (Bearer / `sk-` / `ghp_` / AWS keys and so on) **and** compares line
  by line against your real local token, failing hard on a hit;
- To run that check alone: `npm run check:secrets`.

## Development

```bash
npm test          # secret scan first, then node --test (bundled mock MCP server, no network)
```

The local mock covers: parameter schema conversion, handshake and session headers, dynamic
registration, real `tools/call`, no-token degradation, 401 attribution, SSE response parsing, and
the settings routes (including the non-loopback rejection).

## License

MIT

[![M8ven Score](https://m8ven.ai/badge/mcp/4kaforever11-dsh-mcd-mcp-1f4487?v=7f892b4c39fb3b39504f03d1b0f0ae74)](https://m8ven.ai/mcp/4kaforever11-dsh-mcd-mcp-1f4487?s=readme)
