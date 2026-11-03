# dsh-mcd-mcp v0.2.0

## 新功能

- 新增 `mcd_plan_order`:對最多 5 個候選餐單呼叫官方 `calculate-price`,按實時報價排序並標示預算內最低價。
- 限定單一門店到店自取;拒絕混用門店的候選,缺少有效報價時不參與排序。
- 規劃工具僅核價,不會建立訂單;只比較傳入的候選,不宣稱全菜單全域最優。
- 更新簡體中文、繁體中文與英文使用說明。

## 校驗

- `npm test` → 13 個本機 mock 用例通過;不會讀取或修改真實 Token 設定。
- `npm pack --dry-run` 可檢查套件清單;`prepublishOnly` 會再次執行憑證掃描與測試。

## 安裝

```bash
npm install -g dsh-mcd-mcp@0.2.0
dsh plugin --profile <你的 profile> add dsh-mcd-mcp
```

---

# dsh-mcd-mcp v0.1.0

把**麦当劳中国 MCP**（`https://mcp.mcd.cn`）接进 DeepSeek Harness 的插件。粘一次自己的
Token，远端的**全部**工具自动变成 DSH 原生工具（`mcd_` 前缀），模型即可直接查券、点餐、
算价、下单。

> 本插件不内置任何凭证。Token 由你自己到 <https://open.mcd.cn/mcp> 生成。

## 安装

从本 Release 的 `dsh-mcd-mcp-0.1.0.tgz` 装：

```bash
npm install -g ./dsh-mcd-mcp-0.1.0.tgz
dsh plugin --profile <你的 profile> add dsh-mcd-mcp
```

或直接从本仓库装：

```bash
dsh plugin --profile <你的 profile> add github:4KAForever11/dsh-mcd-mcp
```

装完重启一次 `dsh web`，打开**设置 → 麦当劳 MCP**，粘贴 Token，点「保存并连接」。

## 它做了什么

| 层 | 内容 |
| --- | --- |
| 工具注册 | 握手后拉 `tools/list`，把远端**每一个**工具原样映射成 DSH 工具并加 `mcd_` 前缀，官方新增工具无需改代码 |
| 常驻工具 | `mcd_status` / `mcd_test` / `mcd_tools` / `mcd_call` |
| 设置页 | Token 填写、保存并连接、一键测试连通性、查看已注册工具数 |
| 协议 | JSON-RPC 2.0 over Streamable HTTP，`Mcp-Session-Id` 会话保持，同时兼容 `application/json` 与 `text/event-stream` |

## 工具注解

每个工具（4 个常驻 + 全部远端动态工具）都带明确布尔的四项注解：

- `readOnlyHint` — 只读查询
- `destructiveHint` — 有破坏性（取消订单、抽奖）
- `idempotentHint` — 重放无副作用
- `openWorldHint` — 会访问外部世界（值为 `true`）

注解来源优先级：远端 `tools/list` 自带的 `annotations` 优先，缺失时按工具名推断；未知工具
保守默认（可写、不幂等、开放世界）。

## Token 安全

- 只存本机 `~/.dsh/dsh-mcd-mcp.json`，文件权限 `0600`
- 不写进 profile 配置、不进对话上下文、不进仓库
- 仓库带 `scripts/check-secrets.mjs`，`prepublishOnly` 会强制扫描，阻止误发

## 校验

- `npm test` → 9 个用例全部通过（含 mock MCP 服务器、SSE 解析、401 翻译、inject 契约）
- 已收录进 DSH 插件市场（awesome-dsh-plugin，分类 `tools`）

## 依赖

零运行时依赖，只用 Node 内置模块；`engines.node >= 22.13.0`。
