/**
 * dsh-mcd-mcp — 设置页(Client 半边)。
 *
 * 以 dsh.client bundle 格式加载:注册 settings.section「麦当劳 MCP」页,
 * 让用户把官网(https://open.mcd.cn/mcp)生成的 Token 粘贴进来、一键测试连通性、
 * 保存后立即拉取并注册远端工具。
 *
 * 数据全部走 Host 注册的 HTTP 路由 /dsh-mcd-mcp-api(本机回环),
 * Token 只落在 ~/.dsh/dsh-mcd-mcp.json,不写进设置 patch、不进对话上下文。
 *
 * 注册 id 必须等于 loader entry 名(dsh-mcd-mcp),否则 ModuleLoader 报
 * "loaded without registering dsh-mcd-mcp"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mcd-mcp',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/dsh-mcd-mcp-api'
    const STYLE_OWNER_ID = 'dsh-mcd-mcp'
    // 构建标记:设置页标题旁边会显示。看到 2026-10-26b 就说明浏览器拿到的是
    // 修好空响应体之后的新 bundle;还是老样子(或没有这个标记)说明页面在跑
    // 装插件那一刻(21:23)缓存的旧代码 —— 那种情况必须重启 DSH 让 bundle 重建。
    const BUILD_STAMP = '2026-10-26b'

    const CSS = [
      '.mcd-panel{display:flex;flex-direction:column;gap:16px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary);max-width:760px}',
      '.mcd-panel .mcd-card{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.mcd-panel .mcd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.mcd-panel .mcd-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.05em}',
      '.mcd-panel .mcd-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.mcd-panel .mcd-hint a{color:var(--dsw-alias-brand-primary);text-decoration:none}',
      '.mcd-panel .mcd-hint a:hover{text-decoration:underline}',
      '.mcd-panel .mcd-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.02em}',
      '.mcd-panel .mcd-badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.mcd-panel .mcd-badge.on{color:#1a7f37;background:color-mix(in srgb,#1a7f37 14%,transparent)}',
      '.mcd-panel .mcd-badge.off{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
      '.mcd-panel .mcd-badge.bad{color:#c4291f;background:color-mix(in srgb,#c4291f 14%,transparent)}',
      '.mcd-panel input[type=text],.mcd-panel input[type=password],.mcd-panel textarea{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 11px;font-size:13px;outline:none;transition:border-color .12s ease;font-family:inherit}',
      '.mcd-panel input.mcd-token{flex:1;min-width:220px;letter-spacing:.04em}',
      '.mcd-panel input[type=text]:focus,.mcd-panel input[type=password]:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.mcd-panel button{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer;transition:border-color .12s ease,background .12s ease;white-space:nowrap}',
      '.mcd-panel button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.mcd-panel button:disabled{opacity:.5;cursor:default}',
      '.mcd-panel button.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
      '.mcd-panel button.danger{color:#c4291f}',
      '.mcd-panel .mcd-result{padding:9px 12px;border-radius:8px;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.mcd-panel .mcd-result.ok{background:color-mix(in srgb,#1a7f37 10%,transparent);color:#1a7f37}',
      '.mcd-panel .mcd-result.bad{background:color-mix(in srgb,#c4291f 10%,transparent);color:#c4291f}',
      '.mcd-panel .mcd-stat{display:flex;gap:22px;flex-wrap:wrap}',
      '.mcd-panel .mcd-stat .k{font-size:11px;color:var(--dsw-alias-label-secondary);letter-spacing:.03em}',
      '.mcd-panel .mcd-stat .v{font-size:15px;font-weight:600;margin-top:2px}',
      '.mcd-panel .mcd-tools{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto;padding-right:4px}',
      '.mcd-panel .mcd-tool{padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid transparent}',
      '.mcd-panel .mcd-tool:hover{border-color:var(--dsw-alias-border-l1)}',
      '.mcd-panel .mcd-tool .n{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;font-weight:600;color:var(--dsw-alias-brand-primary)}',
      '.mcd-panel .mcd-tool .d{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    ].join('\n')

    function createOwnedStyle(css) {
      const el = document.createElement('style')
      el.setAttribute('data-plugin', STYLE_OWNER_ID)
      el.textContent = css
      document.head.appendChild(el)
      return el
    }

    // 路由不存在(插件还没起来/宿主没挂)时后端会回 404 空 body,
    // 直接 res.json() 会抛 "Unexpected end of JSON input" —— 把这种情况
    // 翻译成能指导用户下一步的说明,而不是把浏览器原始异常丢到脸上。
    async function readJson(res) {
      const text = await res.text()
      if (!text.trim()) {
        if (res.status === 404) {
          throw new Error(
            '插件后端还没就绪(HTTP 404)。通常是刚装完还没重启 DSH,或 Host 插件加载失败 —— 重启一次 DSH 后再打开本页。',
          )
        }
        throw new Error('后端返回空响应(HTTP ' + res.status + ')')
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new Error('后端返回的不是 JSON(HTTP ' + res.status + '):' + text.slice(0, 200))
      }
    }

    async function apiGet(action) {
      const res = await fetch(API + (action ? '?action=' + encodeURIComponent(action) : ''), {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      return readJson(res)
    }

    async function apiPost(payload) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      return readJson(res)
    }

    function Badge({ state, text }) {
      return React.createElement('span', { className: 'mcd-badge ' + state }, text)
    }

    function Stat({ label, value }) {
      return React.createElement(
        'div',
        null,
        React.createElement('div', { className: 'k' }, label),
        React.createElement('div', { className: 'v' }, value),
      )
    }

    function McdPanel() {
      const [status, setStatus] = useState(null)
      const [token, setToken] = useState('')
      const [endpoint, setEndpoint] = useState('')
      const [busy, setBusy] = useState('')
      const [result, setResult] = useState(null)
      const mounted = useRef(true)

      const refreshStatus = useCallback(async () => {
        try {
          const s = await apiGet()
          if (!mounted.current) return
          setStatus(s)
          if (s && s.endpoint) setEndpoint((prev) => prev || s.endpoint)
        } catch (err) {
          if (mounted.current) setResult({ ok: false, text: '读取状态失败:' + (err && err.message ? err.message : String(err)) })
        }
      }, [])

      useEffect(() => {
        mounted.current = true
        void refreshStatus()
        return () => { mounted.current = false }
      }, [refreshStatus])

      const run = async (name, fn) => {
        setBusy(name)
        setResult(null)
        try {
          const r = await fn()
          if (!mounted.current) return
          setResult(r)
          if (r && r.ok !== false) await refreshStatus()
          else if (r && r.configured !== undefined) setStatus(r)
        } catch (err) {
          if (mounted.current) setResult({ ok: false, text: '请求失败:' + (err && err.message ? err.message : String(err)) })
        } finally {
          if (mounted.current) setBusy('')
        }
      }

      const onTest = () =>
        run('test', async () => {
          const r = await apiPost({ action: 'test', token: token.trim() || undefined })
          return {
            ok: !!r.ok,
            text: r.ok
              ? '连接正常 · ' + r.ms + 'ms · 远端 ' + r.toolCount + ' 个工具'
                + (r.server && r.server.name ? '\n服务端:' + r.server.name + (r.server.version ? ' ' + r.server.version : '') : '')
              : '连接失败 · ' + r.ms + 'ms\n' + (r.error || '未知错误'),
          }
        })

      const onSave = () =>
        run('save', async () => {
          const r = await apiPost({ action: 'save', token: token.trim(), endpoint: endpoint.trim() })
          if (r.ok === false && r.error) return { ok: false, text: '保存失败:' + r.error }
          const refreshInfo = r.refresh || {}
          if (refreshInfo.error) return { ok: false, text: 'Token 已保存,但连接失败:\n' + refreshInfo.error }
          setToken('')
          return { ok: true, text: 'Token 已保存,已注册 ' + (refreshInfo.count || 0) + ' 个工具。' }
        })

      const onRefreshTools = () =>
        run('refresh', async () => {
          const r = await apiPost({ action: 'refresh' })
          if (r.refresh && r.refresh.error) return { ok: false, text: '刷新失败:' + r.refresh.error }
          return { ok: true, text: '已刷新,当前注册 ' + ((r.refresh && r.refresh.count) || 0) + ' 个工具。' }
        })

      const onClear = () =>
        run('clear', async () => {
          await apiPost({ action: 'clear' })
          setToken('')
          return { ok: true, text: 'Token 已清除,远端工具已卸载。' }
        })

      const configured = !!(status && status.configured)
      const toolCount = status ? status.toolCount || 0 : 0
      const tools = (status && status.tools) || []

      return React.createElement(
        'div',
        { className: 'mcd-panel' },
        React.createElement(
          'div',
          { className: 'mcd-card' },
          React.createElement(
            'div',
            { className: 'mcd-row', style: { justifyContent: 'space-between' } },
            React.createElement('div', { className: 'mcd-title' }, '麦当劳 MCP'),
            React.createElement(
              'span',
              { className: 'mcd-hint', style: { fontSize: 11, opacity: 0.55 } },
              BUILD_STAMP,
            ),
            React.createElement(Badge, {
              state: status && status.lastError ? 'bad' : configured ? 'on' : 'off',
              text: status && status.lastError ? '异常' : configured ? '已连接' : '未配置',
            }),
          ),
          React.createElement(
            'div',
            { className: 'mcd-hint' },
            'Token 请自行到 ',
            React.createElement('a', { href: 'https://open.mcd.cn/mcp', target: '_blank', rel: 'noreferrer' }, 'open.mcd.cn/mcp'),
            ' 生成后粘贴到下面。插件只把它存到本机 ',
            React.createElement('code', null, '~/.dsh/dsh-mcd-mcp.json'),
            ',不会写进对话或设置文件。',
          ),
          React.createElement(
            'div',
            { className: 'mcd-stat' },
            React.createElement(Stat, { label: '已注册工具', value: String(toolCount) }),
            React.createElement(Stat, { label: '远端工具', value: String((status && status.remoteToolCount) || 0) }),
            React.createElement(Stat, { label: '已存 Token', value: (status && status.tokenMask) || '—' }),
            React.createElement(Stat, {
              label: '最近同步',
              value: status && status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleTimeString() : '—',
            }),
          ),
          status && status.lastError
            ? React.createElement('div', { className: 'mcd-result bad' }, status.lastError)
            : null,
        ),
        React.createElement(
          'div',
          { className: 'mcd-card' },
          React.createElement('div', { className: 'mcd-title' }, 'Token'),
          React.createElement(
            'div',
            { className: 'mcd-row' },
            React.createElement('input', {
              type: 'password',
              className: 'mcd-token',
              placeholder: configured ? '已配置 · 粘贴新 Token 可替换' : '粘贴官网生成的 MCP Token',
              value: token,
              spellCheck: false,
              autoComplete: 'off',
              onChange: (e) => setToken(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && token.trim()) void onSave() },
            }),
            React.createElement(
              'button',
              { className: 'primary', disabled: !!busy || !token.trim(), onClick: () => void onSave() },
              busy === 'save' ? '保存中…' : '保存并连接',
            ),
            React.createElement(
              'button',
              { disabled: !!busy || (!token.trim() && !configured), onClick: () => void onTest() },
              busy === 'test' ? '测试中…' : '测试连接',
            ),
            configured
              ? React.createElement(
                  'button',
                  { className: 'danger', disabled: !!busy, onClick: () => void onClear() },
                  busy === 'clear' ? '清除中…' : '清除 Token',
                )
              : null,
          ),
          React.createElement(
            'div',
            { className: 'mcd-row' },
            React.createElement('input', {
              type: 'text',
              style: { flex: 1, minWidth: 220 },
              placeholder: 'https://mcp.mcd.cn',
              value: endpoint,
              spellCheck: false,
              onChange: (e) => setEndpoint(e.target.value),
            }),
            React.createElement(
              'button',
              { disabled: !!busy || !configured, onClick: () => void onRefreshTools() },
              busy === 'refresh' ? '刷新中…' : '重新拉取工具',
            ),
          ),
          result
            ? React.createElement('div', { className: 'mcd-result ' + (result.ok ? 'ok' : 'bad') }, result.text)
            : null,
        ),
        React.createElement(
          'div',
          { className: 'mcd-card' },
          React.createElement(
            'div',
            { className: 'mcd-row', style: { justifyContent: 'space-between' } },
            React.createElement('div', { className: 'mcd-title' }, '工具清单'),
            React.createElement('div', { className: 'mcd-hint' }, tools.length ? tools.length + ' 项' : '暂无'),
          ),
          tools.length
            ? React.createElement(
                'div',
                { className: 'mcd-tools' },
                tools.map((tool, index) =>
                  React.createElement(
                    'div',
                    { className: 'mcd-tool', key: tool.dshName || tool.name || index },
                    React.createElement('div', { className: 'n' }, tool.dshName || tool.name),
                    React.createElement('div', { className: 'd' }, tool.description || '（无说明）'),
                  ),
                ),
              )
            : React.createElement(
                'div',
                { className: 'mcd-hint' },
                configured
                  ? '还没有拉取到工具,点「重新拉取工具」试试;若仍为空,说明 Token 无效或远端未授权。'
                  : '配置 Token 后,这里会列出远端全部工具 —— 它们会以 mcd_ 前缀注册成 DSH 原生工具。',
              ),
        ),
      )
    }

    function apply(ctx) {
      const styleEl = createOwnedStyle(CSS)
      ctx.effect(() => () => { styleEl.remove() }, 'dsh-mcd-mcp-entry: styles')

      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'mcd-mcp', order: 26, label: '麦当劳 MCP' },
          () => React.createElement(McdPanel),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    // 仅供回归测试(node --test)使用,宿主不消费
    exports.__test = { apiGet, apiPost, createOwnedStyle, STYLE_OWNER_ID }
    return module.exports
  },
})
