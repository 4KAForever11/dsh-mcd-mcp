/**
 * 生成市场卡片用的 PNG 图标(icon.svg 是矢量源,但收录规则只接受位图)。
 *
 * 不引第三方依赖:直接手写 PNG(签名 + IHDR + IDAT + IEND),
 * 图形用两段「拱门」拼出金拱门 M —— 与 icon.svg 的几何一致,
 * 4x 超采样做抗锯齿,最后缩回 180px(市场按 ~96px 显示,180 够清晰)。
 *
 * 用法: node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'assets')
const SIZE = 180
const SS = 4 // 超采样倍数

// 每个颜色都必须是 4 分量:少写一个 alpha,写进 Uint8Array 会变成 0(全透明)。
const RED = [0xda, 0x29, 0x1c, 255]
const YELLOW = [0xff, 0xc7, 0x2c, 255]
const TRANSPARENT = [0, 0, 0, 0]

// --- 几何:全部以 48x48 的 SVG 坐标系表达,再按 SIZE/48 缩放 ---
const S = 48
const RADIUS = 11 // 与 icon.svg 的 rx 一致
const ARCH = { top: 14, cy: 21, R: 7, r: 3.2, cx1: 17, cx2: 31, bottom: 35 }

const inRoundedRect = (x, y, w, h, rad) => {
  if (x < 0 || y < 0 || x > w || y > h) return false
  const cx = Math.min(Math.max(x, rad), w - rad)
  const cy = Math.min(Math.max(y, rad), h - rad)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= rad * rad
}

/** 一段拱门:上半是内半径 r、外半径 R 的圆环,下半是两条直腿。 */
const inArch = (x, y, cx) => {
  const dx = x - cx
  if (y < ARCH.top || y > ARCH.bottom) return false
  if (y <= ARCH.cy) {
    const d = Math.hypot(dx, y - ARCH.cy)
    return d >= ARCH.r && d <= ARCH.R
  }
  const ax = Math.abs(dx)
  return ax >= ARCH.r && ax <= ARCH.R
}

const inM = (x, y) => inArch(x, y, ARCH.cx1) || inArch(x, y, ARCH.cx2)

// --- 渲染:先超采样得到 RGBA,再盒式下采样 ---
const hi = SIZE * SS
const buf = new Uint8Array(hi * hi * 4)

for (let py = 0; py < hi; py += 1) {
  for (let px = 0; px < hi; px += 1) {
    // 像素中心映射回 SVG 坐标
    const sx = ((px + 0.5) / hi) * S
    const sy = ((py + 0.5) / hi) * S
    const i = (py * hi + px) * 4
    let color = TRANSPARENT
    if (inRoundedRect(sx, sy, S, S, RADIUS)) color = inM(sx, sy) ? YELLOW : RED
    buf[i] = color[0]
    buf[i + 1] = color[1]
    buf[i + 2] = color[2]
    buf[i + 3] = color[3]
  }
}

const out = new Uint8Array(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let oy = 0; oy < SS; oy += 1) {
      for (let ox = 0; ox < SS; ox += 1) {
        const i = ((y * SS + oy) * hi + (x * SS + ox)) * 4
        const alpha = buf[i + 3] / 255
        // 预乘后累加,避免透明边缘出现暗边
        r += buf[i] * alpha
        g += buf[i + 1] * alpha
        b += buf[i + 2] * alpha
        a += buf[i + 3]
      }
    }
    const n = SS * SS
    const aAvg = a / n
    const o = (y * SIZE + x) * 4
    if (aAvg < 0.5) {
      out[o] = 0
      out[o + 1] = 0
      out[o + 2] = 0
      out[o + 3] = 0
    } else {
      const alphaSum = a / 255
      out[o] = Math.round(r / alphaSum)
      out[o + 1] = Math.round(g / alphaSum)
      out[o + 2] = Math.round(b / alphaSum)
      out[o + 3] = Math.round(aAvg)
    }
  }
}

// --- PNG 编码 ---
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

const crc32 = (bytes) => {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // colour type: RGBA
ihdr[10] = 0 // deflate
ihdr[11] = 0 // adaptive filtering
ihdr[12] = 0 // no interlace

// 每行前置一个 filter byte(0 = None)
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y += 1) {
  const rowStart = y * (SIZE * 4 + 1)
  raw[rowStart] = 0
  Buffer.from(out.buffer, y * SIZE * 4, SIZE * 4).copy(raw, rowStart + 1)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(OUT_DIR, { recursive: true })
const target = join(OUT_DIR, 'icon-180.png')
writeFileSync(target, png)
console.log(`wrote ${target} (${png.length} bytes, ${SIZE}x${SIZE})`)
