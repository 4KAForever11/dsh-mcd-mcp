# dsh-mcd-mcp

把**麦当劳中国 MCP**(`https://mcp.mcd.cn`)接进 DeepSeek Harness:
粘一次自己的 Token,远端**全部**工具自动变成 DSH 原生工具(`mcd_` 前缀),模型可以直接下单、查券、点餐。

> Token 由你自己去 <https://open.mcd.cn/mcp> 生成,插件不内置任何凭证。

## 装

```bash
dsh plugin --profile <你的 profile> add ./dsh-mcd-mcp
```

或在 DSH 里用 `plugin_manager`(`action: install_bundle`)指向本目录。

装完重启一次 `dsh web`,打开 **设置 → 麦当劳 MCP**,把 Token 粘进去点「保存并连接」。

## 它做了什么

| 层 | 内容 |
| --- | --- |
| 协议 | 自带最小 MCP 客户端:JSON-RPC 2.0 + Streamable HTTP,握手 → `tools/list` → `tools/call`,兼容 `application/json` 与 `text/event-stream` 两种响应 |
| 工具 | 远端工具**动态**注册成 `mcd_<原名>`(远端增删工具,重启即同步,不用改代码) |
| 兜底 | `mcd_call` 可直接按远端原名调用,`mcd_tools` 列清单 |
| 自检 | `mcd_status` / `mcd_test` 两个常驻工具 + 设置页「测试连接」按钮 |
| 存储 | Token 落在 `~/.dsh/dsh-mcd-mcp.json`(0600),不进对话上下文、不写进设置 patch |

常驻管理工具(没有 Token 也能用,会明确告诉你"还没配置"):

- `mcd_status` — 是否已配置、已注册多少工具、最近一次同步/错误
- `mcd_test` — 握手 + 拉清单,返回耗时、工具数量、失败原因
- `mcd_tools` — 远端全部工具的名称与说明
- `mcd_call` — 按远端原名直调,参数原样透传

## 端点与限流

- 端点默认 `https://mcp.mcd.cn`,可在设置页改。
- 无 Token / Token 无效时远端返回 **401 或 403**,插件会把它们翻译成「Token 无效或已过期」而不是静默空清单。
- 429(限流,官方约 600 次/分钟)自动退避重试两次;其他错误不重试,避免重复下单之类的副作用。

## 凭证安全

**仓库里不含、也不会包含任何 Token。** 具体做法：

- Token 只存在你本机的 `~/.dsh/dsh-mcd-mcp.json`（权限 0600），该路径在 `.gitignore` 里被显式排除；
- 测试用的是本地 mock 服务器和假 Token，不读也不写你的真实配置；
- `npm test` 会先跑 `scripts/check-secrets.mjs`：扫描所有被 git 跟踪的文件，既查常见凭证形态（Bearer / `sk-` / `ghp_` / AWS key 等），也拿你本机真实 Token 原文逐行比对，命中就直接失败并退出；
- 想单独查一遍：`npm run check:secrets`。

## 开发

```bash
npm test          # 先做凭证扫描,再跑 node --test(自带 mock MCP 服务器,不联网)
```

测试用本地 mock 覆盖:参数 schema 转换、握手与会话头、动态注册、真实 `tools/call`、无 Token 降级、401 归因、SSE 响应解析、设置页路由(含非回环拒绝)。

## 许可

MIT

[![M8ven Score](https://m8ven.ai/badge/mcp/4kaforever11-dsh-mcd-mcp-1f4487?v=7f892b4c39fb3b39504f03d1b0f0ae74)](https://m8ven.ai/mcp/4kaforever11-dsh-mcd-mcp-1f4487?s=readme)
[![M8ven Score](https://m8ven.ai/badge/mcp/4kaforever11-dsh-mcd-mcp-1f4487?v=40bf14c85faa990e4dfad277ebadd1fe)](https://m8ven.ai/mcp/4kaforever11-dsh-mcd-mcp-1f4487?s=readme)
