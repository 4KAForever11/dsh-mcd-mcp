#!/usr/bin/env node
/**
 * 发布前护栏：确保仓库里没有泄露任何 Token。
 *
 * 检查两件事：
 *   1. 常见凭证形态（Bearer、sk-、ghp_、github_pat_ 等）是否出现在被 git 跟踪的文件里；
 *   2. 若本机存在 ~/.dsh/dsh-mcd-mcp.json，其 token 原文是否出现在任何跟踪文件里。
 *
 * 不打印 Token 内容。命中则退出码 1，`npm test` 会因此失败。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 本机 DSH 配置里存着的 token（存在才读，读不到就跳过这条检查）。 */
function localToken() {
  const p = process.env.DSH_MCD_CONFIG || join(homedir(), '.dsh', 'dsh-mcd-mcp.json')
  if (!existsSync(p)) return null
  try {
    const t = JSON.parse(readFileSync(p, 'utf8'))?.token
    return typeof t === 'string' && t.length >= 8 ? t : null
  } catch {
    return null
  }
}

/** 被 git 跟踪的文件列表（发布物就是这些）。 */
function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
  } catch {
    // 没有 git 时退化为扫描常见源码文件，避免脚本变成摆设。
    return ['index.js', 'client.js', 'package.json', 'README.md', 'cordis.patch.yml']
      .filter((f) => existsSync(join(ROOT, f)))
  }
}

const PATTERNS = [
  { name: 'Bearer token', re: /Bearer\s+[A-Za-z0-9._~+/-]{16,}/g },
  { name: 'sk- secret', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'GitHub PAT (ghp_)', re: /\bghp_[A-Za-z0-9]{20,}/g },
  { name: 'GitHub PAT (github_pat_)', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: '疑似硬编码 token 赋值', re: /(?:token|secret|password|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9._~+/-]{24,}['"]/gi },
]

const token = localToken()
const hits = []

for (const rel of trackedFiles()) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) continue
  let text
  try {
    text = readFileSync(abs, 'utf8')
  } catch {
    continue // 二进制/不可读，跳过
  }
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0
      if (re.test(line)) hits.push({ rel, line: i + 1, name })
    }
    if (token && line.includes(token)) hits.push({ rel, line: i + 1, name: '本机真实 token 原文' })
  })
}

if (hits.length > 0) {
  console.error('✗ 发现疑似凭证，已阻止：')
  for (const h of hits) console.error(`  ${h.rel}:${h.line} — ${h.name}`)
  console.error('\nToken 必须只存在 ~/.dsh/dsh-mcd-mcp.json，不能进入仓库。')
  process.exit(1)
}

console.log(`✓ 未发现凭证：已检查 ${trackedFiles().length} 个跟踪文件${token ? '（含本机 token 原文比对）' : ''}`)
