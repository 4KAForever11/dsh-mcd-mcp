/**
 * dsh-mcd-mcp 自测:用一个本地 mock MCP 服务器验证插件全链路。
 *
 * 覆盖:
 *  1. toParameters / toToolName 的转换正确性
 *  2. apply() 在真实 HTTP 上完成 initialize → notifications/initialized → tools/list
 *  3. 远端工具被动态注册成 mcd_* 工具,且 execute 能把 tools/call 结果摊平
 *  4. 无 Token 时只注册管理工具,管理工具给出可操作的提示
 *  5. 设置页路由:GET 状态 / POST 保存 / action=test
 *  6. 401 时给出「Token 无效」而不是哑掉
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

// 临时 DSH_HOME 放在插件目录旁的 .test-tmp 里:系统 temp 目录在本机被策略拒绝(EPERM)
const TMP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp')
mkdirSync(TMP_ROOT, { recursive: true })
const HOME = mkdtempSync(join(TMP_ROOT, 'dsh-mcd-test-'))
process.env.DSH_HOME = HOME

const { apply, toParameters, toToolName, HINT_KEYS } = await import('../index.js')

const REMOTE_TOOLS = [
  {
    name: 'calculate-price',
    description: '按当前门店和商品计算整单应付金额',
    inputSchema: {
      type: 'object',
      properties: {
        storeCode: { type: 'string' },
        orderType: { type: 'integer' },
        beType: { type: 'integer' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { productCode: { type: 'string' }, quantity: { type: 'integer' } },
            required: ['productCode', 'quantity'],
          },
        },
      },
      required: ['storeCode', 'orderType', 'beType', 'items'],
    },
  },
  {
    name: 'order-list',
    description: '查询我的历史订单',
    inputSchema: { type: 'object', properties: { page: { type: 'integer', minimum: 1 } }, required: [] },
  },
  {
    name: 'query-my-account',
    description: '查询账户信息与积分',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'party-order-create',
    description: '主题活动下单',
    inputSchema: {
      type: 'object',
      properties: {
        storeCode: { type: 'string', description: '门店编码' },
        items: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' } } } },
      },
      required: ['storeCode'],
      $schema: 'http://json-schema.org/draft-07/schema#',
    },
  },
]

/** 起一个 mock MCP 服务器;requireToken 为真时校验 Authorization。 */
function startMock({ requireToken = true, sessionId = 'sess-abc' } = {}) {
  const calls = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      calls.push({
        method: body.method,
        name: body.params && body.params.name,
        arguments: body.params && body.params.arguments,
        headers: req.headers,
      })

      if (requireToken) {
        const auth = String(req.headers.authorization || '')
        if (!auth.startsWith('Bearer good-token')) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
      }
      const send = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId })
        res.end(JSON.stringify(obj))
      }
      if (body.method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id: body.id,
          result: { protocolVersion: '2025-06-18', serverInfo: { name: 'mock-mcd', version: '9.9.9' }, capabilities: { tools: {} } },
        })
        return
      }
      if (body.method === 'notifications/initialized') {
        res.writeHead(202)
        res.end()
        return
      }
      if (body.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: body.id, result: { tools: REMOTE_TOOLS } })
        return
      }
      if (body.method === 'tools/call') {
        const name = body.params.name
        if (name === 'calculate-price') {
          const productCode = String(body.params.arguments?.items?.[0]?.productCode || '')
          const match = /fixture-price-(\d+)$/.exec(productCode)
          const quote = productCode === 'missing-price'
            ? { success: true, code: 200, message: '请求成功', data: { discount: 0 } }
            : match
            ? { success: true, code: 200, message: '请求成功', data: { price: Number(match[1]), discount: 100, productPrice: Number(match[1]) + 100 } }
            : { success: false, code: 400, message: '没有有效报价', data: {} }
          const responseText = productCode === 'wrapped-price'
            ? '官方核价结果：' + JSON.stringify({ success: true, code: 200, message: '请求成功', data: { price: 1990, discount: 50 } }) + '。'
            : JSON.stringify(quote)
          send({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: responseText }], isError: false },
          })
          return
        }
        send({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name, args: body.params.arguments }) }],
            isError: false,
          },
        })
        return
      }
      send({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found: ' + body.method } })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: 'http://127.0.0.1:' + port, calls, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

/** 最小 ctx 替身:记录工具注册、effect、get。 */
function fakeCtx(services = {}) {
  const tools = new Map()
  const routes = []
  return {
    tools: {
      register(def) {
        assert.ok(def && def.name, 'tool 必须有 name')
        assert.ok(!tools.has(def.name), '工具名重复:' + def.name)
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    effect(fn) {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    get(name) {
      if (name === 'webServer') return services.webServer
      return services[name]
    },
    _tools: tools,
    _routes: routes,
  }
}

function fakeWebServer() {
  const routes = new Map()
  return {
    register(route) {
      assert.ok(!routes.has(route.path), '路由重复:' + route.path)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    routes,
  }
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

test('toToolName:统一前缀 + 只留安全字符', () => {
  assert.equal(toToolName('order-list'), 'mcd_order_list')
  assert.equal(toToolName('party-order-create'), 'mcd_party_order_create')
  assert.equal(toToolName('a.b/c d'), 'mcd_a_b_c_d')
  assert.equal(toToolName(''), 'mcd_tool')
  assert.equal(toToolName('__x__'), 'mcd_x')
  assert.ok(toToolName('x'.repeat(200)).length <= 64)
})

test('toParameters:生成 DSH 子集认可的 object-rooted schema', () => {
  const params = toParameters(REMOTE_TOOLS.find((tool) => tool.name === 'party-order-create').inputSchema)
  assert.equal(params.type, 'object')
  assert.deepEqual(Object.keys(params.properties).sort(), ['items', 'storeCode'])
  assert.deepEqual(params.required, ['storeCode'])
  assert.equal(params.properties.storeCode.type, 'string')
  assert.equal(params.properties.items.type, 'array')
  assert.equal(params.properties.items.items.properties.code.type, 'string')
  // $schema 这类不该带进参数节点
  assert.equal(params.properties.$schema, undefined)
  assert.deepEqual(toParameters({ type: 'object' }), { type: 'object', properties: {} })
  assert.deepEqual(toParameters(undefined), { type: 'object', properties: {} })
})

test('toParameters:把 MCP 里超纲的 schema 投影进 DSH 子集,而不是原样透传', () => {
  const params = toParameters({
    type: 'object',
    properties: {
      a: { type: ['string', 'null'], format: 'date', description: '日期' },
      b: { type: 'any' },
      c: { type: 'object', properties: { x: { type: 'integer', minimum: 1 } }, additionalProperties: false },
      d: { type: 'array', items: { type: ['string', 'number'] } },
      e: { type: 'string', enum: ['a', 'b'] },
    },
    required: ['a', 'nope'],
  })
  // type 数组:保留可用类型,其余折叠;format 降级进 description
  assert.equal(params.properties.a.type, 'string')
  assert.match(params.properties.a.description, /格式:date/)
  // 非标准 type 被丢掉,不留非法值
  assert.equal(params.properties.b.type, undefined)
  // required 只保留真实存在的键,子集要求 required ⊆ properties
  assert.deepEqual(params.required, ['a'])
  // 子集没有 anyOf:联合类型降级成 oneOf
  assert.deepEqual(params.properties.d.items.oneOf, [{ type: 'string' }, { type: 'number' }])
  assert.equal(params.properties.e.enum.length, 2)
  for (const node of Object.values(params.properties)) {
    assert.ok(!('anyOf' in node), 'anyOf 不在 DSH 子集里')
    assert.ok(!('format' in node), 'format 不在 DSH 子集里')
  }
})

test('有 Token:握手 + 动态注册全部远端工具,execute 能调通', async () => {
  const mock = await startMock()
  const ctx = fakeCtx()
  try {
    apply(ctx, { endpoint: mock.url, token: 'good-token' })
    await settle(400)

    // 管理工具常驻
    for (const name of ['mcd_status', 'mcd_test', 'mcd_tools', 'mcd_call']) {
      assert.ok(ctx._tools.has(name), '缺少管理工具 ' + name)
    }
    // 远端工具全部注册
    for (const tool of REMOTE_TOOLS) {
      const dshName = toToolName(tool.name)
      assert.ok(ctx._tools.has(dshName), '缺少远端工具 ' + dshName)
      // 注册时必须给出 object-rooted 的完整 schema,不能是扁平字段表
      const params = ctx._tools.get(dshName).parameters
      assert.equal(params.type, 'object', dshName + ' 的 parameters 必须是 object-rooted')
      assert.ok(params.properties && typeof params.properties === 'object')
    }
    assert.ok(mock.calls.some((c) => c.method === 'initialize'))
    assert.ok(mock.calls.some((c) => c.method === 'notifications/initialized'))
    assert.ok(mock.calls.some((c) => c.method === 'tools/list'))
    const listCall = mock.calls.find((c) => c.method === 'tools/list')
    assert.equal(listCall.headers['mcp-session-id'], 'sess-abc', '后续请求要带 Mcp-Session-Id')
    assert.equal(listCall.headers['mcp-protocol-version'], '2025-06-18')

    // 真正调用一次远端工具
    const orderTool = ctx._tools.get('mcd_order_list')
    const value = await orderTool.execute({ page: 2 }, {})
    assert.equal(value.ok, true)
    assert.deepEqual(value.data, { ok: true, tool: 'order-list', args: { page: 2 } })

    // 每个工具都必须带齐四个布尔 hint,一个都不能漏(OpenAI 目录会拒)
    for (const [name, def] of ctx._tools) {
      assert.ok(def.annotations, name + ' 缺少 annotations')
      for (const key of HINT_KEYS) {
        assert.equal(typeof def.annotations[key], 'boolean', name + ' 的 ' + key + ' 必须是布尔')
      }
      // 投影后 annotations 会被丢掉,所以 description 里要留一行可读 hint
      assert.match(def.description, /hints: readOnly=(true|false) destructive=(true|false) idempotent=(true|false) openWorld=(true|false)/, name + ' 的 description 缺少 hint 行')
    }

    // 只读/破坏性推断要符合远端工具语义
    assert.equal(ctx._tools.get('mcd_order_list').annotations.readOnlyHint, true, 'order-list 是只读查询')
    assert.equal(ctx._tools.get('mcd_query_my_account').annotations.readOnlyHint, true, 'query-my-account 是只读查询')
    assert.equal(ctx._tools.get('mcd_party_order_create').annotations.readOnlyHint, false, 'party-order-create 会下单')
    assert.equal(ctx._tools.get('mcd_party_order_create').annotations.destructiveHint, false, '下单不是破坏性操作')
    assert.equal(ctx._tools.get('mcd_call').annotations.readOnlyHint, false, 'mcd_call 能干什么取决于远端,不能标只读')

    // 直连兜底工具
    const direct = await ctx._tools.get('mcd_call').execute({ name: 'query-my-account', arguments: {} }, {})
    assert.equal(direct.ok, true)
    assert.equal(direct.data.tool, 'query-my-account')

    // 状态工具能讲清楚已连接
    const status = await ctx._tools.get('mcd_status').execute({}, {})
    assert.equal(status.data.configured, true)
    assert.equal(status.data.count, REMOTE_TOOLS.length)
  } finally {
    await mock.close()
    rmSync(HOME, { recursive: true, force: true })
  }
})

test('无 Token:管理工具和点餐规划工具都在,并给出可操作的提示', async () => {
  const ctx = fakeCtx()
  apply(ctx, { endpoint: 'http://127.0.0.1:1', token: '' })
  await settle(150)
  assert.equal(ctx._tools.size, 5, '无 Token 时不该注册远端工具')
  assert.ok(ctx._tools.has('mcd_plan_order'), '未配置 Token 时点餐规划工具仍应说明如何配置')
  const status = await ctx._tools.get('mcd_status').execute({}, {})
  assert.equal(status.data.configured, false)
  assert.match(status.text, /未配置/)
  assert.match(status.text, /设置/)
  const test1 = await ctx._tools.get('mcd_test').execute({}, {})
  assert.equal(test1.ok, false)
  assert.match(test1.text, /未配置/)
})

test('mcd_plan_order uses official quotes, sorts by cents, applies the budget, and never writes', async () => {
  const mock = await startMock()
  const ctx = fakeCtx()
  try {
    apply(ctx, { endpoint: mock.url, token: 'good-token' })
    await settle(400)

    const planner = ctx._tools.get('mcd_plan_order')
    assert.ok(planner, '缺少预算点餐规划工具')
    const quoteArgs = (price) => ({
      storeCode: 'demo-store',
      orderType: 1,
      beType: 1,
      items: [{ productCode: 'fixture-price-' + price, quantity: 1 }],
    })
    const planned = await planner.execute({
      budgetYuan: 25,
      candidates: [
        { label: '常规组合', quoteArgs: quoteArgs(3350) },
        { label: '优惠组合', quoteArgs: quoteArgs(2190) },
        { label: '替换组合', quoteArgs: quoteArgs(2500) },
      ],
    }, {})

    assert.equal(planned.ok, true)
    assert.deepEqual(planned.data.results.map((row) => [row.label, row.priceCents, row.withinBudget]), [
      ['优惠组合', 2190, true],
      ['替换组合', 2500, true],
      ['常规组合', 3350, false],
    ])
    assert.equal(planned.data.bestWithinBudget.label, '优惠组合')
    assert.equal(planned.data.results[0].priceYuan, '21.90')

    const quoteCalls = mock.calls.filter((call) => call.method === 'tools/call')
    assert.equal(quoteCalls.length, 3)
    assert.ok(quoteCalls.every((call) => call.name === 'calculate-price'), '报价之外不应调用任何远端工具')
    assert.deepEqual(quoteCalls.map((call) => call.arguments), [
      quoteArgs(3350), quoteArgs(2190), quoteArgs(2500),
    ], '报价参数必须原样传给官方 calculate-price')
  } finally {
    await mock.close()
    rmSync(HOME, { recursive: true, force: true })
  }
})

test('mcd_plan_order rejects a successful quote envelope without price instead of treating it as zero', async () => {
  const mock = await startMock()
  const ctx = fakeCtx()
  try {
    apply(ctx, { endpoint: mock.url, token: 'good-token' })
    await settle(400)
    const result = await ctx._tools.get('mcd_plan_order').execute({
      candidates: [{
        label: '无报价候选',
        quoteArgs: {
          storeCode: 'demo-store', orderType: 1, beType: 1,
          items: [{ productCode: 'missing-price', quantity: 1 }],
        },
      }],
    }, {})

    assert.equal(result.ok, false)
    assert.equal(result.data.results.length, 0)
    assert.equal(result.data.failures[0].label, '无报价候选')
    assert.match(result.data.failures[0].error, /price.*(分|有效)/i)
  } finally {
    await mock.close()
    rmSync(HOME, { recursive: true, force: true })
  }
})

test('mcd_plan_order rejects mixed-store candidates before making any quote call', async () => {
  const mock = await startMock()
  const ctx = fakeCtx()
  try {
    apply(ctx, { endpoint: mock.url, token: 'good-token' })
    await settle(400)
    const quoteArgs = (storeCode) => ({
      storeCode, orderType: 1, beType: 1,
      items: [{ productCode: 'fixture-price-1000', quantity: 1 }],
    })
    const result = await ctx._tools.get('mcd_plan_order').execute({
      candidates: [
        { label: '门店 A', quoteArgs: quoteArgs('store-a') },
        { label: '门店 B', quoteArgs: quoteArgs('store-b') },
      ],
    }, {})

    assert.equal(result.ok, false)
    assert.match(result.text, /同一家门店/)
    assert.equal(mock.calls.filter((call) => call.method === 'tools/call').length, 0)
  } finally {
    await mock.close()
    rmSync(HOME, { recursive: true, force: true })
  }
})

test('mcd_plan_order rejects more than five candidates before making quote calls', async () => {
  const mock = await startMock()
  const ctx = fakeCtx()
  try {
    apply(ctx, { endpoint: mock.url, token: 'good-token' })
    await settle(400)
    const quoteArgs = {
      storeCode: 'demo-store', orderType: 1, beType: 1,
      items: [{ productCode: 'fixture-price-1000', quantity: 1 }],
    }
    const result = await ctx._tools.get('mcd_plan_order').execute({
      candidates: Array.from({ length: 6 }, (_, index) => ({ label: '方案' + index, quoteArgs })),
    }, {})

    assert.equal(result.ok, false)
    assert.match(result.text, /最多 5 个候选/)
    assert.equal(mock.calls.filter((call) => call.method === 'tools/call').length, 0)
  } finally {
    await mock.close()
    rmSync(HOME, { recursive: true, force: true })
  }
})

test('mcd_plan_order extracts an official quote embedded in response text', async () => {
  const mock = await startMock()
  const ctx = fakeCtx()
  try {
    apply(ctx, { endpoint: mock.url, token: 'good-token' })
    await settle(400)
    const result = await ctx._tools.get('mcd_plan_order').execute({
      candidates: [{
        label: '文字包裹报价',
        quoteArgs: {
          storeCode: 'demo-store', orderType: 1, beType: 1,
          items: [{ productCode: 'wrapped-price', quantity: 1 }],
        },
      }],
    }, {})
    assert.equal(result.ok, true)
    assert.equal(result.data.results[0].priceCents, 1990)
  } finally {
    await mock.close()
    rmSync(HOME, { recursive: true, force: true })
  }
})

test('mcd_plan_order rejects a budget whose cents cannot be represented safely', async () => {
  const mock = await startMock()
  const ctx = fakeCtx()
  try {
    apply(ctx, { endpoint: mock.url, token: 'good-token' })
    await settle(400)
    const result = await ctx._tools.get('mcd_plan_order').execute({
      budgetYuan: Number.MAX_SAFE_INTEGER,
      candidates: [{
        label: '候选',
        quoteArgs: {
          storeCode: 'demo-store', orderType: 1, beType: 1,
          items: [{ productCode: 'fixture-price-1000', quantity: 1 }],
        },
      }],
    }, {})
    assert.equal(result.ok, false)
    assert.match(result.text, /金额范围|安全整数/)
    assert.equal(mock.calls.filter((call) => call.method === 'tools/call').length, 0)
  } finally {
    await mock.close()
    rmSync(HOME, { recursive: true, force: true })
  }
})

test('Token 无效:401 被翻译成可读错误,而不是静默空清单', async () => {
  const mock = await startMock()
  const ctx = fakeCtx()
  try {
    apply(ctx, { endpoint: mock.url, token: 'bad-token' })
    await settle(400)
    assert.equal(ctx._tools.size, 5, '401 时不应注册远端工具')
    const status = await ctx._tools.get('mcd_status').execute({}, {})
    assert.match(status.text, /Token 无效|401/)
    const test1 = await ctx._tools.get('mcd_test').execute({}, {})
    assert.equal(test1.ok, false)
    assert.match(test1.text, /Token 无效|401/)
  } finally {
    await mock.close()
  }
})

test('设置页路由:状态 / 保存 Token / 测试连通性', async () => {
  const mock = await startMock()
  const webServer = fakeWebServer()
  const ctx = fakeCtx({ webServer })
  try {
    apply(ctx, { endpoint: mock.url, token: '' })
    await settle(150)
    const route = webServer.routes.get('/dsh-mcd-mcp-api')
    assert.ok(route, '设置页路由没注册')
    assert.equal(route.kind, 'exact')

    // 构造一个伪 req/res;remoteAddress 设成回环,否则会被 403 拦掉
    const call = (method, url, body) =>
      new Promise((resolve, reject) => {
        const res = {
          statusCode: 200,
          headers: {},
          writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers); return this },
          end(text) { resolve({ status: this.statusCode, body: JSON.parse(text || '{}'), headers: this.headers }) },
        }
        const req = {
          method,
          url,
          socket: { remoteAddress: '127.0.0.1' },
          on(event, handler) {
            if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body)))
            if (event === 'end') handler()
            return req
          },
          destroy() {},
        }
        Promise.resolve(route.handler(req, res)).catch(reject)
      })

    const before = await call('GET', '/dsh-mcd-mcp-api')
    assert.equal(before.status, 200)
    assert.equal(before.body.configured, false)
    assert.equal(before.body.endpoint, mock.url)

    const saved = await call('POST', '/dsh-mcd-mcp-api', { action: 'save', token: 'good-token', endpoint: mock.url })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.configured, true)
    assert.equal(saved.body.refresh.ok, true)
    assert.equal(saved.body.toolCount, REMOTE_TOOLS.length)

    const tested = await call('POST', '/dsh-mcd-mcp-api', { action: 'test' })
    assert.equal(tested.body.ok, true)
    assert.equal(tested.body.toolCount, REMOTE_TOOLS.length)
    assert.equal(tested.body.server.name, 'mock-mcd')

    const cleared = await call('POST', '/dsh-mcd-mcp-api', { action: 'clear' })
    assert.equal(cleared.body.configured, false)
    assert.equal(ctx._tools.size, 5)

    // 非回环请求必须拒掉(Token 是凭据,不能给局域网)
    const denied = await new Promise((resolve) => {
      const res = {
        statusCode: 200,
        writeHead(code, headers) { this.statusCode = code; return this },
        end(text) { resolve({ status: this.statusCode, body: JSON.parse(text || '{}') }) },
      }
      const req = { method: 'GET', url: '/dsh-mcd-mcp-api', socket: { remoteAddress: '10.1.2.3' }, on() { return req } }
      Promise.resolve(route.handler(req, res))
    })
    assert.equal(denied.status, 403)
  } finally {
    await mock.close()
    rmSync(HOME, { recursive: true, force: true })
  }
})

test('SSE 响应也能解析(text/event-stream)', async () => {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'sse-1' })
      if (body.method === 'initialize') {
        res.end('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'sse-mock' } } }) + '\n\n')
        return
      }
      if (body.method === 'notifications/initialized') { res.end(); return }
      if (body.method === 'tools/list') {
        res.end('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'sse-tool', description: '来自 SSE', inputSchema: { type: 'object', properties: {} } }] } }) + '\n\n')
        return
      }
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  const ctx = fakeCtx()
  try {
    apply(ctx, { endpoint: 'http://127.0.0.1:' + port, token: 'good-token' })
    await settle(400)
    assert.ok(ctx._tools.has('mcd_sse_tool'), 'SSE 响应没有被解析成工具')
  } finally {
    await new Promise((r) => server.close(r))
    rmSync(HOME, { recursive: true, force: true })
  }
})

// 回归:inject 必须是「服务名数组」或「服务名 → 拦截配置」的 map。
// 之前写成 { required: ['tools'], optional: ['webServer'] },cordis 会把
// required / optional 当成两个服务名去等,插件永远 pending、HTTP 路由 404,
// 设置页于是报 "Unexpected end of JSON input"。apply() 不经过 cordis 解析,
// 所以只有直接断言导出值才能抓住这个 bug。
test('inject 声明符合 cordis 契约(否则插件永远 pending)', async () => {
  const mod = await import('../index.js')
  const inject = mod.inject
  const names = Array.isArray(inject) ? inject : Object.keys(inject || {})
  assert.ok(names.length > 0, 'inject 不能为空')
  for (const bad of ['required', 'optional', 'require', 'optionals']) {
    assert.ok(!names.includes(bad), `inject 里出现了非服务名 "${bad}",疑似误用 {required,optional} 分组写法`)
  }
  assert.ok(names.includes('tools'), 'inject 必须包含 tools')
})
