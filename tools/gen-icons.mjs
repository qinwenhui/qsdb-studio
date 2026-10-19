// 生成 Tauri 图标（不引图像依赖：手写 PNG/ICO 编码）。
// 用法：node tools/gen-icons.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'src-tauri', 'icons')
mkdirSync(outDir, { recursive: true })

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

// 圆角方形 + 数据库圆柱（白） + 两道浅蓝环。
function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const ss = 3 // 3x3 超采样
  const radius = size * 0.22
  const cx = size * 0.5
  const rx = size * 0.26
  const ry = size * 0.095
  const top = size * 0.30
  const bottom = size * 0.70
  const bandR = rx
  const bandRy = ry
  const bands = [size * 0.46, size * 0.58]
  const bandW = Math.max(size * 0.018, 0.9)

  const inRound = (x, y) => {
    const dx = Math.max(Math.abs(x - size / 2) - (size / 2 - radius), 0)
    const dy = Math.max(Math.abs(y - size / 2) - (size / 2 - radius), 0)
    return dx * dx + dy * dy <= radius * radius
  }
  const inCylinder = (x, y) => {
    if (y >= top && y <= bottom && Math.abs(x - cx) <= rx) return true
    const dxt = (x - cx) / rx
    const dyt = (y - top) / ry
    if (y <= top && dxt * dxt + dyt * dyt <= 1) return true
    const dyb = (y - bottom) / ry
    if (y >= bottom && dxt * dxt + dyb * dyb <= 1) return true
    return false
  }
  const onBand = (x, y) => {
    for (const by of bands) {
      const dx = (x - cx) / bandR
      const dy = (y - by) / bandRy
      const d = Math.sqrt(dx * dx + dy * dy)
      const width = bandW / bandR
      if (Math.abs(d - 1) <= width) {
        // 只画下半圈，视觉上像圆柱的接缝
        if (y >= by - bandRy * 1.05) return true
      }
    }
    return false
  }

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgA = 0
      let cylA = 0
      let bandA = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = px + (sx + 0.5) / ss
          const y = py + (sy + 0.5) / ss
          if (!inRound(x, y)) continue
          bgA++
          if (inCylinder(x, y)) {
            cylA++
            if (onBand(x, y)) bandA++
          }
        }
      }
      const total = ss * ss
      const i = (py * size + px) * 4
      // 背景渐变 #1e3a8a -> #2563eb
      const t = py / Math.max(1, size - 1)
      let r = lerp(30, 37, t)
      let g = lerp(58, 99, t)
      let b = lerp(138, 235, t)
      const bg = bgA / total
      // 圆柱白色
      if (cylA > 0) {
        const c = cylA / total
        r = lerp(r, 248, c)
        g = lerp(g, 250, c)
        b = lerp(b, 255, c)
        // 接缝用浅蓝
        if (bandA > 0) {
          const w = bandA / total
          r = lerp(r, lerp(147, 30, bg), w * 0.85)
          g = lerp(g, lerp(197, 58, bg), w * 0.85)
          b = lerp(b, lerp(253, 138, bg), w * 0.85)
        }
      }
      rgba[i] = Math.round(r)
      rgba[i + 1] = Math.round(g)
      rgba[i + 2] = Math.round(b)
      rgba[i + 3] = Math.round(255 * bg)
    }
  }
  return encodePng(size, rgba)
}

function encodeIco(png, size) {
  const header = Buffer.from([0, 0, 1, 0, 1, 0])
  const entry = Buffer.alloc(16)
  entry[0] = size >= 256 ? 0 : size
  entry[1] = size >= 256 ? 0 : size
  entry[2] = 0
  entry[3] = 0
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([header, entry, png])
}

const sizes = [
  [32, '32x32.png'],
  [128, '128x128.png'],
  [256, '128x128@2x.png'],
]
let png256
for (const [size, name] of sizes) {
  const png = render(size)
  writeFileSync(join(outDir, name), png)
  if (size === 256) png256 = png
  console.log(`wrote ${name}`)
}
writeFileSync(join(outDir, 'icon.ico'), encodeIco(png256, 256))
console.log('wrote icon.ico')
