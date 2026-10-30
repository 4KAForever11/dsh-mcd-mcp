# dsh-mcd-mcp

[简体中文](README.md) · [English](README.en.md) · **繁體中文**

把**麥當勞中國 MCP**（`https://mcp.mcd.cn`）接進 DeepSeek Harness：
貼一次自己的 Token，遠端**全部**工具自動變成 DSH 原生工具（`mcd_` 前綴），模型就能直接下單、查優惠券、點餐。

> Token 請自行到 <https://open.mcd.cn/mcp> 產生，外掛不內建任何憑證。

## 安裝

```bash
dsh plugin --profile <你的 profile> add ./dsh-mcd-mcp
```

或在 DSH 裡用 `plugin_manager`（`action: install_bundle`）指向本目錄。

裝完重啟一次 `dsh web`，開啟 **設定 → 麥當勞 MCP**，把 Token 貼進去後按「儲存並連線」。

## 它做了什麼

| 層 | 內容 |
| --- | --- |
| 協定 | 自帶最小 MCP 用戶端：JSON-RPC 2.0 + Streamable HTTP，握手 → `tools/list` → `tools/call`，同時支援 `application/json` 與 `text/event-stream` 兩種回應 |
| 工具 | 遠端工具**動態**註冊成 `mcd_<原名>`（遠端增刪工具，重啟即同步，不必改程式碼） |
| 備援 | `mcd_call` 可直接用遠端原名呼叫，`mcd_tools` 列出清單 |
| 自檢 | `mcd_status` / `mcd_test` 兩個常駐工具，加上設定頁的「測試連線」按鈕 |
| 儲存 | Token 放在 `~/.dsh/dsh-mcd-mcp.json`（權限 0600），不進對話上下文、不寫進設定檔 |

常駐管理工具（沒有 Token 也能用，會明確告訴你「還沒設定」）：

- `mcd_status` — 是否已設定、已註冊多少工具、最近一次同步／錯誤
- `mcd_test` — 握手 + 取得清單，回報耗時、工具數量、失敗原因
- `mcd_tools` — 遠端全部工具的名稱與說明
- `mcd_call` — 依遠端原名直接呼叫，參數原樣透傳

## 工具註解（讀寫提示）

**每一個**工具——4 個常駐管理工具加上全部動態遠端工具——都帶齊四項註解，值是明確的 `true` / `false`，不省略、不寫 `undefined`：

| 註解 | 含義 |
| --- | --- |
| `readOnlyHint` | 唯讀，不產生副作用 |
| `destructiveHint` | 會造成破壞性、不可復原的變更 |
| `idempotentHint` | 重複執行結果一致，可安全重試 |
| `openWorldHint` | 與外部世界互動（遠端點餐服務，恆為 `true`） |

遠端工具有兩級來源：遠端 `tools/list` 若自帶 `annotations`，逐項取用；**只有缺項才依名稱推斷**——`query_` / `list_` / `get_` / `calculate_` 之類前綴，或 `_list` / `_detail` / `_coupons` / `_stores` 之類後綴判為唯讀；`create-order`、`party-order-create`、`delivery-create-address`、`mall-create-order` 等寫入操作判為可寫；`cancel-order`、`draw-lottery` 額外標記 `destructive`；未知工具一律保守處理為「可寫、不冪等」，絕不冒充唯讀。

依官方 35 個工具實測：28 個唯讀、7 個可寫，其中 `cancel_order` 與 `draw_lottery` 帶破壞性標記。

註解會落在兩處，主機投影後都不會遺失：工具定義上的 `annotations` 欄位，以及說明結尾一行機器可讀的 `hints: readOnly=… destructive=… idempotent=… openWorld=…`。每個工具還帶 `presentCall`，回傳 DSH 的呼叫類型（`read` / `edit` / `delete`），DSH 在執行前就能標出讀寫性質。

## 端點與限流

- 端點預設 `https://mcp.mcd.cn`，可在設定頁更改。
- 沒有 Token 或 Token 無效時，遠端回傳 **401 或 403**，外掛會把它們轉譯成「Token 無效或已過期」，而不是默默回傳空清單。
- 429（限流，官方約每分鐘 600 次）會自動退避重試兩次；其他錯誤不重試，避免重複下單之類的副作用。

## 憑證安全

**儲存庫不含、也不會包含任何 Token。** 具體做法：

- Token 只存在你本機的 `~/.dsh/dsh-mcd-mcp.json`（權限 0600），該路徑在 `.gitignore` 中被明確排除；
- 測試使用本機 mock 伺服器與假 Token，不讀也不寫你的真實設定；
- `npm test` 會先執行 `scripts/check-secrets.mjs`：掃描所有被 git 追蹤的檔案，既查常見憑證形態（Bearer / `sk-` / `ghp_` / AWS key 等），也拿你本機真實 Token 原文逐行比對，命中就直接失敗並結束；
- 想單獨檢查一遍：`npm run check:secrets`。

## 開發

```bash
npm test          # 先做憑證掃描，再跑 node --test（自帶 mock MCP 伺服器，不連網）
```

測試用本機 mock 涵蓋：參數 schema 轉換、握手與工作階段標頭、動態註冊、真實 `tools/call`、無 Token 降級、401 歸因、SSE 回應解析、設定頁路由（含非回環拒絕）。

## 授權

MIT

[![M8ven Score](https://m8ven.ai/badge/mcp/4kaforever11-dsh-mcd-mcp-1f4487?v=7f892b4c39fb3b39504f03d1b0f0ae74)](https://m8ven.ai/mcp/4kaforever11-dsh-mcd-mcp-1f4487?s=readme)
