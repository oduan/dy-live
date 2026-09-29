// 生成 build/icon.ico（Windows）与 build/icon.icns（macOS）
// 用法：npm i --no-save sharp && node scripts/gen-icons.mjs
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const outDir = path.resolve('build')
fs.mkdirSync(outDir, { recursive: true })

// Windows：全出血圆角；macOS：Big Sur 风格，内容区 824/1024 留边
const squareSvg = (margin = 0) => {
  const size = 1024 - margin * 2
  return `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b2b38"/>
      <stop offset="1" stop-color="#101016"/>
    </linearGradient>
    <linearGradient id="tri" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="#ff5f6d"/>
      <stop offset="1" stop-color="#fe2c55"/>
    </linearGradient>
  </defs>
  <rect x="${margin}" y="${margin}" width="${size}" height="${size}" rx="185" fill="url(#bg)"/>
  <path d="M385 300 L770 512 L385 724 Z" fill="#25d8ff" transform="translate(${margin - 30},0)" opacity="0.9"/>
  <path d="M385 300 L770 512 L385 724 Z" transform="translate(${margin},0)" fill="url(#tri)"/>
</svg>`
}

async function renderPng(svg, size, file) {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png()
    .toFile(file)
  return fs.readFileSync(file)
}

// ---- ICO：多尺寸 PNG 条目（Vista+ 支持 PNG 压缩图标）----
async function buildIco() {
  const svg = squareSvg(0)
  const sizes = [16, 32, 48, 64, 128, 256]
  const pngs = []
  for (const s of sizes) {
    const tmp = path.join(outDir, `.tmp-${s}.png`)
    pngs.push({ size: s, data: await renderPng(svg, s, tmp) })
    fs.unlinkSync(tmp)
  }
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + pngs.length * 16
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0) // width（256 写 0）
    e.writeUInt8(size >= 256 ? 0 : size, 1) // height
    e.writeUInt8(0, 2) // 调色板色数
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
  }
  fs.writeFileSync(
    path.join(outDir, 'icon.ico'),
    Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]),
  )
}

// ---- ICNS：ic07/ic08/ic09/ic10/ic11/ic12，PNG 数据块 ----
async function buildIcns() {
  const svg = squareSvg(100) // macOS 留边
  const types = [
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
  ]
  const chunks = []
  for (const [type, size] of types) {
    const tmp = path.join(outDir, `.tmp-${size}.png`)
    const data = await renderPng(svg, size, tmp)
    fs.unlinkSync(tmp)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(data.length + 8, 4)
    chunks.push(head, data)
  }
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(body.length + 8, 4)
  fs.writeFileSync(path.join(outDir, 'icon.icns'), Buffer.concat([header, body]))
}

// 1024 预览图，便于人工确认
await renderPng(squareSvg(0), 1024, path.join(outDir, 'icon-preview.png'))

await buildIco()
await buildIcns()
console.log('build/icon.ico 与 build/icon.icns 已生成')
