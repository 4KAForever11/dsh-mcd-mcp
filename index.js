/**
 * dsh-mcd-mcp — 麦当劳(McDonald's China)MCP 接入插件。
 *
 * 目标:把 https://open.mcd.cn/mcp/doc 第 4 节列出的全部 MCP 能力接进 DSH,
 * 且 Token 完全由用户自己在官网生成后粘贴进来 —— 插件不内置任何凭证。
 *
 * 做法:插件自己实现一个最小的 MCP 客户端(Streamable HTTP + JSON-RPC 2.0),
 * 启动时用 Token 调 initialize / tools/list,把远端每一个工具**动态**注册成
 * 本机 DSH 原生工具 `mcd_<name>`。这样:
 *   - 远端增减工具,重启即同步,不需要改插件代码;
 *   - 官方文档是 SPA、拿不到静态清单,也就不能靠硬编码工具列表。
 *
 * 另外常驻四个管理工具(status / test / tools / call),Token 没配也能用,
 * 用来告诉模型「还没配 Token,请去设置页填」而不是哑掉。
 *
 * 设置页(client.js)通过本文件注册的 HTTP 路由读写 Token 并做连通性自检。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-mcd-mcp'
// cordis 的 inject 是「服务名 → 拦截配置」的 map / 服务名数组,
// 不是 { required, optional } 分组 —— 写成对象会把 required、optional
// 当成两个服务名去等,插件永远 pending、路由永远 404。
export const inject = ['tools', 'webServer']

const PLUGIN_NAME = 'dsh-mcd-mcp'
const PLUGIN_VERSION = '0.1.0'
const DEFAULT_ENDPOINT = 'https://mcp.mcd.cn'
const PROTOCOL_VERSION = '2025-06-18'
const ROUTE = '/dsh-mcd-mcp-api'
const TOOL_PREFIX = 'mcd_'
const RPC_TIMEOUT_MS = 30000

// ---------------------------------------------------------------- 设置持久化
// Token 落在 ~/.dsh/dsh-mcd-mcp.json(与包升级解耦),权限 600。
function dshRoot() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
function settingsFile() {
  return join(dshRoot(), PLUGIN_NAME + '.json')
}
function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }
  try {
    mkdirSync(dshRoot(), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  } catch {
    /* 落盘失败不该让插件挂掉,后续读取会退回默认值 */
  }
  return next
}

function cleanToken(value) {
  let token = String(value == null ? '' : value).trim()
  // 用户经常把 「Bearer xxx」或 `MCD_MCP_TOKEN=xxx` 整行粘进来
  if (/^bearer\s+/i.test(token)) token = token.replace(/^bearer\s+/i, '').trim()
  const m = /^(?:MCD_MCP_TOKEN|MCDONALDS_MCP_TOKEN)\s*=\s*(.+)$/.exec(token)
  if (m) token = m[1].trim().replace(/^["']|["']$/g, '')
  if (!token) return ''
  // Token 里出现空白/控制字符基本是粘错了,直接拒掉比发出去 401 更好排查
  if (/[\s\u0000-\u001f\u007f]/.test(token)) return ''
  return token
}

function normalizeEndpoint(value) {
  const raw = String(value || '').trim() || DEFAULT_ENDPOINT
  return raw.replace(/\/+$/, '')
}

/**
 * 给设置页显示用的脱敏摘要:让用户一眼确认「存进去的是不是我以为的那串」。
 * 只露前 4 后 4,中间固定打码,不会把 Token 泄到界面上。
 */
function maskToken(token) {
  const t = String(token || '')
  if (!t) return ''
  if (t.length <= 8) return '*'.repeat(t.length)
  return t.slice(0, 4) + '*'.repeat(Math.min(12, t.length - 8)) + t.slice(-4)
}

// ---------------------------------------------------------------- MCP 客户端
/**
 * 最小 Streamable HTTP MCP 客户端。
 * 一个实例 = 一条 MCP 会话(带 Mcp-Session-Id),失效后由上层重建。
 */
class McpClient {
  constructor({ endpoint, token }) {
    this.endpoint = normalizeEndpoint(endpoint)
    this.token = cleanToken(token)
    this.sessionId = null
    this.nextId = 0
    this.initialized = false
    this.serverInfo = null
  }

  headers(extra) {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      'User-Agent': 'dsh-mcd-mcp/' + PLUGIN_VERSION,
      ...(extra || {}),
    }
    if (this.token) h.Authorization = 'Bearer ' + this.token
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId
    return h
  }

  async post(payload, { signal } = {}) {
    const timeout = AbortSignal.timeout(RPC_TIMEOUT_MS)
    const composed = signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : timeout
    let res
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: composed,
      })
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error('连接 MCP 超时(' + Math.round(RPC_TIMEOUT_MS / 1000) + 's):' + this.endpoint)
      }
      throw new Error('连接 MCP 失败:' + (err && err.message ? err.message : String(err)))
    }
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    return res
  }

  /** 读一条 JSON-RPC 响应:兼容 application/json 与 text/event-stream。 */
  async readResponse(res, id) {
    const ctype = String(res.headers.get('content-type') || '')
    let text
    try {
      text = await res.text()
    } catch (err) {
      throw new Error('读取 MCP 响应失败:' + (err && err.message ? err.message : String(err)))
    }
    if (ctype.includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
        if (!data) continue
        let parsed
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }
        for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
          if (msg && msg.id === id) return msg
        }
      }
      throw new Error('MCP 事件流里没有对应响应(id=' + id + ')')
    }
    if (!text.trim()) throw new Error('MCP 返回空响应')
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('MCP 响应不是合法 JSON:' + text.slice(0, 200))
    }
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      if (msg && msg.id === id) return msg
    }
    if (parsed && parsed.error) return parsed
    throw new Error('MCP 响应缺少 id')
  }

  async rpc(method, params, opts) {
    if (!this.token) throw new Error('未配置 MCP Token')
    this.nextId += 1
    const id = this.nextId
    const payload = { jsonrpc: '2.0', id, method }
    if (params !== undefined) payload.params = params

    // 429 限流按 1.5s/3s 退避重试两次,其余错误不重试(避免重复下单之类的副作用)
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await this.post(payload, opts)
      if (res.status === 429) {
        lastError = new Error('429:触发限流(600 次/分钟),请稍后重试')
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
        continue
      }
      if (res.status === 401 || res.status === 403) {
        const detail = await res.text().catch(() => '')
        // 401 带 "鉴权码不存在" = 头里带了 Token 但麦当劳侧不认这串;
        // 403 是网关压根没读到 Authorization 头(通常是我们没带 Token)。
        const hint =
          res.status === 401
            ? '这串 Token 在麦当劳侧不存在或已失效:请回 open.mcd.cn/mcp 重新生成,注意别把示例值/旧值粘进来'
            : 'Token 可能在复制时缺了字符,或已被重置'
        throw new Error('MCP Token 被拒绝(HTTP ' + res.status + ')' + (detail ? ':' + detail.slice(0, 200) : '') + '\n提示:' + hint)
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error('MCP HTTP ' + res.status + (detail ? ':' + detail.slice(0, 300) : ''))
      }
      const msg = await this.readResponse(res, id)
      if (msg.error) {
        const e = msg.error
        throw new Error('MCP 错误 ' + (e.code != null ? '[' + e.code + '] ' : '') + (e.message || JSON.stringify(e)))
      }
      return msg.result
    }
    throw lastError || new Error('MCP 请求失败')
  }

  /** initialize + notifications/initialized:新会话必须先握手。 */
  async connect(opts) {
    const result = await this.rpc(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
      },
      opts,
    )
    this.serverInfo = (result && result.serverInfo) || null
    // 握手的第二条是通知(无 id),失败不影响后续调用,只当作兼容性噪音吞掉
    try {
      const res = await this.post(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        opts,
      )
      if (res.body) await res.body.cancel().catch(() => {})
    } catch {
      /* ignore */
    }
    this.initialized = true
    return result
  }

  async ensure(opts) {
    if (!this.initialized) await this.connect(opts)
    return this
  }

  async listTools(opts) {
    await this.ensure(opts)
    const out = []
    let cursor
    for (let page = 0; page < 20; page += 1) {
      const result = await this.rpc('tools/list', cursor ? { cursor } : {}, opts)
      for (const tool of (result && result.tools) || []) out.push(tool)
      cursor = result && result.nextCursor
      if (!cursor) break
    }
    return out
  }

  async callTool(toolName, args, opts) {
    await this.ensure(opts)
    const result = await this.rpc('tools/call', { name: toolName, arguments: args || {} }, opts)
    return result
  }
}

/** 把 MCP tools/call 的返回摊平成一段可读文本 + 结构化数据。 */
function flattenToolResult(result) {
  const blocks = (result && Array.isArray(result.content) && result.content) || []
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') parts.push(String(block.text || ''))
    else if (block.type === 'image') parts.push('[图片 ' + (block.mimeType || 'image') + ']')
    else if (block.type === 'resource') parts.push('[资源 ' + (block.resource && block.resource.uri ? block.resource.uri : '') + ']')
  }
  let text = parts.join('\n').trim()
  let data
  if (result && result.structuredContent !== undefined) {
    data = result.structuredContent
  } else if (text) {
    // 远端经常把业务数据塞成一整段 JSON 字符串,能解就解出来,前端/模型都好用
    const trimmed = text.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        data = JSON.parse(trimmed)
      } catch {
        /* 不是 JSON,保持纯文本 */
      }
    }
  }
  if (!text && data !== undefined) text = JSON.stringify(data, null, 2)
  return { isError: !!(result && result.isError), text, data }
}

// ---------------------------------------------------------------- 工具 schema
// DSH 强制执行的是 JSON Schema 的一个**很窄**的子集(见 @deepseek-ai/dsh-tools
// lib/types/json-schema.js),超出就抛 JsonSchemaError 让整条 fiber 激活失败:
//   允许的约束关键字只有 type / oneOf / properties / required /
//   additionalProperties / items / enum / const;
//   允许的注解关键字只有 description / title / default / examples;
//   没有 anyOf、allOf、format、minimum、pattern、minItems、nullable 等等;
//   type 必须是单个字符串,不接受 ['string','null'] 这种数组。
// MCP 远端的 inputSchema 是完整的 JSON Schema,所以必须逐节点投影过来。
const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const VALID_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

// 这些关键字子集不支持,但丢了对模型有损 —— 折叠成一句人话附到 description 上。
const DESCRIBE_AS_TEXT = {
  format: (v) => '格式:' + v,
  minimum: (v) => '最小 ' + v,
  maximum: (v) => '最大 ' + v,
  exclusiveMinimum: (v) => '必须大于 ' + v,
  exclusiveMaximum: (v) => '必须小于 ' + v,
  multipleOf: (v) => '需为 ' + v + ' 的整数倍',
  minLength: (v) => '最少 ' + v + ' 个字符',
  maxLength: (v) => '最多 ' + v + ' 个字符',
  pattern: (v) => '需匹配正则 ' + v,
  minItems: (v) => '至少 ' + v + ' 项',
  maxItems: (v) => '最多 ' + v + ' 项',
  nullable: (v) => (v ? '可为空' : ''),
}

/** 把非法的 type 折成子集允许的形态,返回 { type?, oneOf? }。 */
function normalizeType(raw) {
  if (typeof raw === 'string') {
    return VALID_TYPES.has(raw) ? { type: raw } : {}
  }
  if (Array.isArray(raw)) {
    // 'null' 不进 oneOf:子集没有 nullable,模型看到 "null" 分支反而困惑。
    // 有别的类型时直接去掉它,「可为空」由 describeDropped 的说明承担。
    const kept = [...new Set(raw.filter((t) => typeof t === 'string' && VALID_TYPES.has(t) && t !== 'null'))]
    if (kept.length === 0) {
      return raw.includes('null') ? { type: 'null' } : {}
    }
    if (kept.length === 1) return { type: kept[0] }
    // 真联合类型:子集没有 anyOf,只有 oneOf。分支只带 type,不并列别的关键字。
    return { oneOf: kept.map((t) => ({ type: t })) }
  }
  return {}
}

/** 收集被丢弃但值得说给模型听的约束。 */
function describeDropped(node) {
  const bits = []
  for (const [key, fmt] of Object.entries(DESCRIBE_AS_TEXT)) {
    if (!Object.hasOwn(node, key)) continue
    try {
      const text = fmt(node[key])
      if (text) bits.push(text)
    } catch {
      /* 脏数据,忽略 */
    }
  }
  return bits
}

/**
 * 把一个远端 schema 节点投影到 DSH 子集里。
 * 无法投影的约束降级成 description 文字,而不是让整个插件激活失败。
 */
export function toSubsetSchema(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return {}

  const out = {}
  // 注解:只搬子集认得的,且必须是 lossless JSON
  if (typeof node.description === 'string') out.description = node.description
  if (typeof node.title === 'string') out.title = node.title
  if (Object.hasOwn(node, 'examples')) out.examples = node.examples

  const dropped = describeDropped(node)
  if (dropped.length > 0) {
    const note = '(' + dropped.join(';') + ')'
    out.description = out.description ? out.description + ' ' + note : note
  }

  const typed = normalizeType(node.type)
  if (typed.oneOf) {
    // oneOf 旁边不能有 properties/required/items/enum/const
    out.oneOf = typed.oneOf
    return out
  }
  const type = typed.type

  if (type === 'object') {
    out.type = 'object'
    const props = node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)
      ? node.properties
      : null
    const projected = {}
    if (props) {
      for (const [key, child] of Object.entries(props)) projected[key] = toSubsetSchema(child)
      out.properties = projected
    }
    const rawRequired = Array.isArray(node.required) ? node.required : []
    // required 里的名字必须在 properties 里,否则校验直接不过
    const required = rawRequired.filter((k) => typeof k === 'string' && (!props || Object.hasOwn(props, k)))
    if (required.length > 0) out.required = required
    if (typeof node.additionalProperties === 'boolean') out.additionalProperties = node.additionalProperties
    return out
  }

  if (type === 'array') {
    out.type = 'array'
    if (node.items && typeof node.items === 'object' && !Array.isArray(node.items)) {
      out.items = toSubsetSchema(node.items)
    }
    return out
  }

  if (type && SCALAR_TYPES.has(type)) {
    out.type = type
    if (Array.isArray(node.enum)) {
      const values = node.enum.filter((v) => v !== null || type === 'null')
      if (values.length > 0) out.enum = values
    }
    if (Object.hasOwn(node, 'const')) out.const = node.const
    return out
  }

  // 没有可用的 type:留成注解式 schema(等价于「任意 JSON」)
  return out
}

/**
 * MCP inputSchema(标准 JSON Schema)→ DSH 工具参数。
 *
 * 注意:ctx.tools.register() 走的是**原始** schema 校验,不经过 defineTool 的
 * 作者层编译,所以这里必须给出完整的 `{ type:'object', properties, required }`,
 * 不能给「字段名 → 节点」的扁平表。
 */
export function toParameters(inputSchema) {
  const schema = inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema) ? inputSchema : {}
  const props = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties
    : {}
  const properties = {}
  for (const [key, value] of Object.entries(props)) properties[key] = toSubsetSchema(value)
  const rawRequired = Array.isArray(schema.required) ? schema.required : []
  const required = rawRequired.filter((k) => typeof k === 'string' && Object.hasOwn(props, k))
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/** MCP 工具名 → DSH 工具名:统一 mcd_ 前缀 + 只留 [a-z0-9_],避免与内置工具撞名。 */
export function toToolName(remoteName) {
  const base = String(remoteName || '')
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  const safe = base || 'tool'
  return (TOOL_PREFIX + safe).slice(0, 64)
}

// output.schema 也不能写 { type:'json' } —— 那是 defineTool 作者层的简写,
// 原始校验里 'json' 不是合法 type。空 schema 表示「任意 JSON」,正是我们要的。
const RESULT_OUTPUT = {
  schema: {},
  render: (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }],
}

// ---------------------------------------------------------------- 插件主体
export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}

  const state = {
    endpoint: normalizeEndpoint(cfg.endpoint || readSettings().endpoint || DEFAULT_ENDPOINT),
    token: cleanToken(cfg.token || process.env.MCD_MCP_TOKEN || process.env.MCDONALDS_MCP_TOKEN || readSettings().token || ''),
    client: null,
    tools: [],          // 远端工具清单 [{name, dshName, description, parameters}]
    disposers: [],      // 动态注册出来的工具卸载器
    lastError: '',
    lastSyncAt: 0,
    syncing: null,      // 并发 refresh 去重
  }

  const client = () => {
    if (!state.client) state.client = new McpClient({ endpoint: state.endpoint, token: state.token })
    return state.client
  }
  const dropClient = () => { state.client = null }

  const persistCache = () => {
    writeSettings({
      endpoint: state.endpoint,
      cache: {
        at: Date.now(),
        endpoint: state.endpoint,
        tools: state.tools.map((t) => ({ name: t.name, description: t.description })),
      },
    })
  }

  const disposeDomainTools = () => {
    for (const dispose of state.disposers.splice(0)) {
      try { dispose() } catch { /* 已卸载 */ }
    }
  }

  // 插件被关掉/热重载时把动态注册的工具一起摘掉,否则同一进程里再 apply
  // 会撞「工具重名」,远端工具就再也注册不上(和路由重复注册同一类问题)。
  ctx.effect(() => () => {
    disposeDomainTools()
    dropClient()
  }, 'dsh-mcd-mcp: domain tools')

  /** 拉 tools/list 并把新工具注册进 DSH;并发调用共享同一次同步。 */
  const refresh = (opts) => {
    if (state.syncing) return state.syncing
    const run = (async () => {
      // 先让出一拍,保证下面的 state.syncing = run 一定先执行:
      // 否则「未配置 Token」这种同步早退会在赋值之前就跑完 finally,
      // 赋值又把已完成的 Promise 写回去,之后填了 Token 也永远复用它、刷新不动。
      await null
      try {
        disposeDomainTools()
        if (!state.token) {
          state.tools = []
          state.lastError = '未配置 MCP Token'
          return { ok: false, error: state.lastError, count: 0 }
        }
        const remote = await client().listTools(opts)
        const skipped = []
        const mapped = []
        for (const tool of remote) {
          const remoteName = String((tool && tool.name) || '').trim()
          if (!remoteName) continue
          const dshName = toToolName(remoteName)
          const parameters = toParameters(tool.inputSchema)
          const description = String((tool && (tool.description || tool.title)) || remoteName).trim()
          mapped.push({ name: remoteName, dshName, description, parameters })
        }
        state.tools = mapped
        for (const tool of mapped) {
          try {
            const dispose = ctx.tools.register({
              name: tool.dshName,
              description:
                (tool.description || tool.name) +
                '\n\n(麦当劳 MCP 工具,远端名:' + tool.name + ')',
              parameters: tool.parameters,
              output: RESULT_OUTPUT,
              async execute(args, exec) {
                const flat = await client().callTool(tool.name, args || {}, { signal: exec && exec.signal })
                const value = flattenToolResult(flat)
                return {
                  ok: !value.isError,
                  text: value.text || (value.isError ? '远端返回错误' : '完成'),
                  data: value.data,
                }
              },
            })
            state.disposers.push(dispose)
          } catch (err) {
            skipped.push(tool.dshName)
          }
        }
        state.lastError = ''
        state.lastSyncAt = Date.now()
        persistCache()
        return { ok: true, count: state.disposers.length, skipped }
      } catch (err) {
        const message = err && err.message ? err.message : String(err)
        state.lastError = message
        // 401/403 或会话失效:丢掉客户端,下次调用重新握手
        if (/401|403|Token/i.test(message)) dropClient()
        return { ok: false, error: message, count: 0 }
      } finally {
        // 只清掉自己那一份:并发调用共享同一个 Promise,别把别人刚设的覆盖掉
        if (state.syncing === run) state.syncing = null
      }
    })()
    // 关键:必须在 run 定义之后再赋值。若先赋值 promise 再在 IIFE 里同步执行,
    // 空 Token 的早退会先跑完 finally 把 syncing 置 null,随后这行又写回旧 Promise,
    // 导致之后填了 Token 也永远复用它、刷新不动(本地已复现过的 bug)。
    state.syncing = run
    return run
  }

  /** 连通性自检:握手 + tools/list,给设置页「测试」按钮用。 */
  const testConnection = async (tokenOverride) => {
    const probe = new McpClient({ endpoint: state.endpoint, token: tokenOverride || state.token })
    const started = Date.now()
    if (!probe.token) return { ok: false, error: '未配置 MCP Token', ms: 0 }
    try {
      const init = await probe.connect()
      const tools = await probe.listTools()
      return {
        ok: true,
        ms: Date.now() - started,
        toolCount: tools.length,
        tools: tools.map((t) => ({ name: t.name, description: String((t && t.description) || '') })),
        server: (init && init.serverInfo) || probe.serverInfo || null,
        endpoint: probe.endpoint,
      }
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err), ms: Date.now() - started, endpoint: probe.endpoint }
    }
  }

  // ---- 常驻管理工具(无 Token 也要在,用来把「去设置页填 Token」讲清楚)----
  ctx.tools.register({
    name: 'mcd_status',
    description:
      '查看麦当劳 MCP 的接入状态:是否已配置 Token、已注册多少个工具、最近一次同步/错误。' +
      '当 mcd_ 开头的工具似乎不可用、或用户问「麦当劳插件好了吗」时先调用它。',
    parameters: { type: 'object', properties: {} },
    output: RESULT_OUTPUT,
    async execute() {
      const names = state.tools.map((t) => t.dshName)
      const text = [
        'Token:' + (state.token ? '已配置' : '未配置(请在 DSH 设置 → 麦当劳 MCP 里粘贴官网生成的 Token)'),
        '端点:' + state.endpoint,
        '已注册工具:' + state.disposers.length + ' 个',
        names.length ? '工具列表:' + names.join(', ') : '工具列表:(空)',
        '最近同步:' + (state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : '从未'),
        state.lastError ? '最近错误:' + state.lastError : '最近错误:无',
      ].join('\n')
      return { ok: !state.lastError, text, data: { configured: !!state.token, endpoint: state.endpoint, count: state.disposers.length, tools: names, error: state.lastError } }
    },
  })

  ctx.tools.register({
    name: 'mcd_test',
    description:
      '测试麦当劳 MCP 连接是否可用(握手 + 拉取工具清单),返回耗时、工具数量与错误原因。' +
      '用户问「Token 能不能用」「怎么连不上」时调用;不会修改任何配置。',
    parameters: { type: 'object', properties: {} },
    output: RESULT_OUTPUT,
    async execute() {
      const r = await testConnection()
      const text = r.ok
        ? '连接正常(' + r.ms + 'ms),远端共 ' + r.toolCount + ' 个工具。'
        : '连接失败(' + r.ms + 'ms):' + r.error
      return { ok: r.ok, text, data: r }
    },
  })

  ctx.tools.register({
    name: 'mcd_tools',
    description:
      '列出麦当劳 MCP 远端全部工具(名称 + 说明)。用于确认某个能力是否存在、或查看当前可用的功能集合。',
    parameters: { type: 'object', properties: {} },
    output: RESULT_OUTPUT,
    async execute() {
      if (!state.token) return { ok: false, text: '未配置 MCP Token,无法拉取工具清单。', data: [] }
      try {
        const tools = await client().listTools()
        const list = tools.map((t) => ({ name: String(t.name || ''), dshName: toToolName(t.name), description: String(t.description || '') }))
        const text = list.map((t) => t.name + '(' + t.dshName + '):' + t.description.slice(0, 160)).join('\n') || '(远端没有工具)'
        return { ok: true, text: '远端共 ' + list.length + ' 个工具:\n' + text, data: list }
      } catch (err) {
        return { ok: false, text: '拉取工具清单失败:' + (err && err.message ? err.message : String(err)), data: [] }
      }
    },
  })

  ctx.tools.register({
    name: 'mcd_call',
    description:
      '直接调用麦当劳 MCP 的任意工具(按远端原名),用于兜底:当某个功能没有被动态注册成独立工具、' +
      '或需要传远端原样参数时使用。arguments 是远端工具的入参对象,原样透传。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '远端工具原名,例如 order-list;可用 mcd_tools 查询' },
        arguments: { type: 'object', properties: {}, description: '远端工具入参对象(原样透传),默认 {}' },
      },
      required: ['name'],
    },
    output: RESULT_OUTPUT,
    async execute(args, exec) {
      const remoteName = String((args && args.name) || '').trim()
      if (!remoteName) return { ok: false, text: '缺少 name(远端工具名)' }
      if (!state.token) return { ok: false, text: '未配置 MCP Token。' }
      try {
        const flat = await client().callTool(remoteName, (args && args.arguments) || {}, { signal: exec && exec.signal })
        const value = flattenToolResult(flat)
        return { ok: !value.isError, text: value.text || '(空结果)', data: value.data }
      } catch (err) {
        return { ok: false, text: '调用 ' + remoteName + ' 失败:' + (err && err.message ? err.message : String(err)) }
      }
    },
  })

  // ---- HTTP 路由:设置页读写 Token / 测试 / 刷新 ----
  const webServer = ctx.webServer ?? (ctx.get && ctx.get('webServer'))
  if (webServer && typeof webServer.register === 'function') {
    const isLoopback = (req) => {
      const addr = (req.socket && req.socket.remoteAddress) || ''
      return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
    }
    const json = (res, obj, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(obj))
    }
    const readBody = (req) =>
      new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > 64 * 1024) {
            reject(new Error('请求体过大'))
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })

    const statusPayload = () => {
      const cache = readSettings().cache
      const tools = state.tools.length
        ? state.tools.map((t) => ({ name: t.name, dshName: t.dshName, description: t.description }))
        : (cache && Array.isArray(cache.tools) ? cache.tools.map((t) => ({ name: t.name, dshName: toToolName(t.name), description: t.description || '' })) : [])
      return {
        ok: true,
        configured: !!state.token,
        endpoint: state.endpoint,
        tokenMask: maskToken(state.token),
        toolCount: state.disposers.length,
        remoteToolCount: state.tools.length,
        tools,
        cached: !state.tools.length && !!tools.length,
        lastSyncAt: state.lastSyncAt,
        lastError: state.lastError,
        settingsFile: settingsFile(),
      }
    }

    // 任何未捕获异常都必须变成一条 JSON 响应:
    // 一旦 handler 抛错,宿主会直接结束响应,浏览器读到空 body,
    // 前端就报 "Failed to execute 'json' on 'Response': Unexpected end of JSON input"。
    // 把 handler 包一层兜底,保证「永远有 body」。
    const safeHandler = (fn) => async (req, res) => {
      try {
        return await fn(req, res)
      } catch (err) {
        const message = err && err.message ? err.message : String(err)
        state.lastError = message
        if (res.headersSent || res.writableEnded) {
          try {
            res.end()
          } catch {}
          return
        }
        return json(res, { ok: false, error: '插件内部错误:' + message }, 500)
      }
    }

    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: safeHandler(async (req, res) => {
          if (!isLoopback(req)) return json(res, { ok: false, error: '仅允许本机访问' }, 403)
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const action = String(url.searchParams.get('action') || '')

          if (req.method === 'GET') {
            if (action === 'test') {
              const r = await testConnection()
              return json(res, r)
            }
            return json(res, statusPayload())
          }
          if (req.method !== 'POST') return json(res, { ok: false, error: '不支持的方法' }, 405)

          let body = {}
          try {
            const raw = await readBody(req)
            body = raw ? JSON.parse(raw) : {}
          } catch (err) {
            return json(res, { ok: false, error: '请求体不是合法 JSON' }, 400)
          }
          const act = String(body.action || action || 'save')

          if (act === 'test') {
            const r = await testConnection(body.token ? cleanToken(body.token) : '')
            return json(res, r)
          }
          if (act === 'clear') {
            state.token = ''
            writeSettings({ token: '' })
            dropClient()
            await refresh()
            return json(res, { ...statusPayload(), ok: true })
          }
          if (act === 'refresh') {
            const r = await refresh()
            return json(res, { ...statusPayload(), ok: r.ok, refresh: r })
          }
          if (act === 'save') {
            if ('endpoint' in body) state.endpoint = normalizeEndpoint(body.endpoint)
            if ('token' in body) {
              const token = cleanToken(body.token)
              if (body.token && !token) return json(res, { ok: false, error: 'Token 格式不对(含空白或控制字符),请重新复制' }, 400)
              state.token = token
              writeSettings({ token, endpoint: state.endpoint })
              dropClient()
            } else {
              writeSettings({ endpoint: state.endpoint })
            }
            // 保存后立刻验证 + 注册工具,用户点一次就能看到结果
            const r = state.token ? await refresh() : { ok: true, count: 0 }
            return json(res, { ...statusPayload(), ok: !r.error, refresh: r })
          }
          return json(res, { ok: false, error: '未知 action:' + act }, 400)
        }),
      }),
    )
  }

  // 启动即同步;失败只记录,不阻塞插件加载(patch 里没有 failOnStartupError)
  void refresh().catch(() => {})
}
