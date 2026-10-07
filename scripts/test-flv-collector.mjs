/**
 * flvCollector 单元验证（node 直跑，无需 Electron）：
 *   node scripts/test-flv-collector.mjs
 * 构造合成 FLV 流（元数据/seq header/关键帧/P 帧/音频），按任意块切分喂入，
 * 断言：快照 header/tail 与源字节严格一致、拼接文件 tag 全程对齐（无缝无重）、
 * 纯音频流封口、失步保护、连接重置。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'flvc-'))
await build({
  entryPoints: [join(process.cwd(), 'src/renderer/src/lib/flvCollector.ts')],
  outfile: join(dir, 'flvCollector.mjs'),
  bundle: true,
  format: 'esm',
  logLevel: 'silent'
})
const { FlvByteCollector } = await import(pathToFileURL(join(dir, 'flvCollector.mjs')).href)

// ---------- 合成 FLV ----------
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
const u24 = (n) => new Uint8Array([(n >>> 16) & 255, (n >>> 8) & 255, n & 255])

function flvHeader() {
  const h = new Uint8Array(13)
  h.set([0x46, 0x4c, 0x56, 1, 5], 0)
  h.set(u32(9), 9)
  return h
}
function tag(type, data, ts) {
  const t = new Uint8Array(11 + data.length + 4)
  t[0] = type
  t.set(u24(data.length), 1)
  t.set(u24(ts & 0xffffff), 4)
  t[7] = (ts >>> 24) & 255
  t.set(u32(data.length), 11 + data.length)
  t.set(data, 11)
  return t
}
function videoTag(frameType, avcPkt, ts, seed, len) {
  const d = new Uint8Array(len)
  d[0] = (frameType << 4) | 7
  d[1] = avcPkt
  d[2] = d[3] = d[4] = 0
  for (let i = 5; i < len; i++) d[i] = (seed + i) & 255
  return tag(9, d, ts)
}
function audioTag(aacPkt, ts, seed, len) {
  const d = new Uint8Array(len)
  d[0] = 0xaf // AAC
  d[1] = aacPkt
  for (let i = 2; i < len; i++) d[i] = (seed + i) & 255
  return tag(8, d, ts)
}
function scriptTag() {
  const d = new Uint8Array(64).fill(0x11)
  return tag(18, d, 0)
}

/** 流：头 + script + 视频seq + 音频seq + 若干 GOP（关键帧/P 帧/音频交错） */
function makeStream(gops = 3, perGop = 4) {
  const parts = [flvHeader(), scriptTag(), videoTag(1, 0, 0, 100, 40), audioTag(0, 0, 200, 8)]
  let ts = 0
  for (let g = 0; g < gops; g++) {
    parts.push(videoTag(1, 1, ts, g * 1000, 3000 + g))
    for (let i = 0; i < perGop; i++) {
      ts += 33
      parts.push(videoTag(2, 1, ts, g * 1000 + i * 10, 800))
      parts.push(audioTag(1, ts, g * 1000 + i * 10 + 5, 120))
    }
    ts += 33
  }
  return concat(parts)
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let p = 0
  for (const x of parts) {
    out.set(x, p)
    p += x.length
  }
  return out
}

/** 任意不规则块切分 */
function splitBytes(buf) {
  const sizes = [1, 7, 13, 1024, 3, 65536, 2, 5000, 1, 1, 100000, 11]
  const chunks = []
  let p = 0
  let i = 0
  while (p < buf.length) {
    const n = Math.min(sizes[i++ % sizes.length], buf.length - p)
    chunks.push(buf.subarray(p, p + n))
    p += n
  }
  return chunks
}

/** 校验整段字节是 tag 全程对齐的合法 FLV（到末尾恰好用尽） */
function assertAlignedFlv(buf, label) {
  if (buf[0] !== 0x46 || buf[1] !== 0x4c || buf[2] !== 0x56) throw new Error(`${label}: FLV magic 缺失`)
  let p = 13
  while (p < buf.length) {
    if (buf.length - p < 11) throw new Error(`${label}: 残缺 tag 头 @${p}`)
    const size = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]
    if (size > 4_000_000) throw new Error(`${label}: tag 超限 @${p}`)
    p += 11 + size + 4
  }
  if (p !== buf.length) throw new Error(`${label}: 末尾越界 ${p} != ${buf.length}`)
}

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log('✓', name)
  } catch (e) {
    failures++
    console.error('✗', name, '—', e.message)
  }
}

// ---------- 用例 ----------
const stream = makeStream()
const chunks = splitBytes(stream)

function feedAll(c, list, id = 1) {
  for (const ck of list) c.feed(id, ck)
}

/** 源流里第一个关键帧 tag 的起点（按 tag 顺序走） */
function firstKeyframeStart(buf) {
  let p = 13
  while (p < buf.length) {
    const type = buf[p]
    const size = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]
    if (type === 9 && size >= 2 && buf[p + 11] >> 4 === 1 && (buf[p + 11] & 15) === 7 && buf[p + 12] === 1) return p
    p += 11 + size + 4
  }
  return -1
}
/** 源流里最后一个关键帧 tag 的起点 */
function lastKeyframeStart(buf) {
  let last = -1
  let p = 13
  while (p < buf.length) {
    const type = buf[p]
    const size = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]
    if (type === 9 && size >= 2 && buf[p + 11] >> 4 === 1 && (buf[p + 11] & 15) === 7 && buf[p + 12] === 1) last = p
    p += 11 + size + 4
  }
  return last
}

check('phase2 快照：header/tail 与源字节严格一致', () => {
  const c = new FlvByteCollector()
  c.connStart(1)
  feedAll(c, chunks)
  const snap = c.snapshot()
  if (!snap.ready) throw new Error('ready 应为 true')
  const kfStart = firstKeyframeStart(stream)
  const lastKf = lastKeyframeStart(stream)
  if (snap.header.length !== kfStart) throw new Error(`header 长度 ${snap.header.length} != ${kfStart}`)
  for (let i = 0; i < kfStart; i++) if (snap.header[i] !== stream[i]) throw new Error(`header 字节不一致 @${i}`)
  if (snap.tail.length !== stream.length - lastKf)
    throw new Error(`tail 长度 ${snap.tail.length} != ${stream.length - lastKf}`)
  for (let i = 0; i < snap.tail.length; i++) if (snap.tail[i] !== stream[lastKf + i]) throw new Error(`tail 字节不一致 @${i}`)
})

check('起录拼接：header+tail 是 tag 全程对齐的合法 FLV', () => {
  const c = new FlvByteCollector()
  c.connStart(1)
  feedAll(c, chunks)
  const snap = c.snapshot()
  assertAlignedFlv(concat([snap.header, snap.tail]), '拼接文件')
})

check('起录后续流无缝：快照+后续 chunk 仍 tag 对齐', () => {
  const c = new FlvByteCollector()
  c.connStart(1)
  const half = Math.floor(chunks.length / 2)
  feedAll(c, chunks.slice(0, half))
  const snap = c.snapshot()
  feedAll(c, chunks.slice(half))
  const file = concat([snap.header, snap.tail, ...chunks.slice(half)])
  assertAlignedFlv(file, '快照+实时')
})

check('逐字节喂入与整块喂入结果一致', () => {
  const a = new FlvByteCollector()
  a.connStart(1)
  feedAll(a, [stream])
  const b = new FlvByteCollector()
  b.connStart(1)
  feedAll(b, chunks)
  const sa = a.snapshot()
  const sb = b.snapshot()
  if (sa.header.length !== sb.header.length || sa.tail.length !== sb.tail.length) throw new Error('长度不一致')
  for (let i = 0; i < sa.header.length; i++) if (sa.header[i] !== sb.header[i]) throw new Error('header 不一致')
  for (let i = 0; i < sa.tail.length; i++) if (sa.tail[i] !== sb.tail[i]) throw new Error('tail 不一致')
})

check('phase1 起录（关键帧未到）：快照即全部已收字节', () => {
  // 停在首个关键帧 tag 中间
  const kfStart = firstKeyframeStart(stream)
  const cut = kfStart + 100
  const c = new FlvByteCollector()
  c.connStart(1)
  feedAll(c, splitBytes(stream.subarray(0, cut)))
  const snap = c.snapshot()
  if (snap.header.length !== cut) throw new Error(`header 应含全部 ${cut} 字节，实际 ${snap.header.length}`)
  if (snap.tail.length !== 0) throw new Error('phase1 不应有 tail')
  for (let i = 0; i < cut; i++) if (snap.header[i] !== stream[i]) throw new Error(`字节不一致 @${i}`)
})

check('纯音频流：首个音频帧前封口，tail 为其后全部', () => {
  const parts = [flvHeader(), scriptTag(), audioTag(0, 0, 200, 8)]
  for (let i = 0; i < 10; i++) parts.push(audioTag(1, i * 40, i * 7, 120))
  const s = concat(parts)
  const headerEnd = 13 + (11 + 64 + 4) + (11 + 8 + 4) // 头 + script + audioSeq
  const c = new FlvByteCollector()
  c.connStart(1)
  feedAll(c, splitBytes(s))
  const snap = c.snapshot()
  if (snap.header.length !== headerEnd) throw new Error(`header ${snap.header.length} != ${headerEnd}`)
  if (snap.tail.length !== s.length - headerEnd) throw new Error('tail 长度不符')
  assertAlignedFlv(concat([snap.header, snap.tail]), '纯音频拼接')
})

check('连接切换：旧连接字节被忽略，新连接重新收集', () => {
  const c = new FlvByteCollector()
  c.connStart(1)
  feedAll(c, chunks.slice(0, 5))
  c.connStart(2)
  if (c.isOpen(1)) throw new Error('旧连接应已关闭')
  feedAll(c, chunks.slice(0, 3), 1) // 旧连接迟到字节应被忽略
  feedAll(c, chunks, 2)
  const snap = c.snapshot()
  if (snap.connId !== 2) throw new Error('connId 应为 2')
  assertAlignedFlv(concat([snap.header, snap.tail]), '新连接拼接')
})

check('垃圾流失步保护：非 FLV 头或超限 tag 触发 onCorrupt', () => {
  let corrupt = 0
  const c = new FlvByteCollector()
  c.onCorrupt = () => corrupt++
  c.connStart(1)
  c.feed(1, new Uint8Array(64).fill(0x99))
  if (corrupt !== 1 || c.snapshot().ready) throw new Error('非 FLV 头应 kill')
  const c2 = new FlvByteCollector()
  let corrupt2 = 0
  c2.onCorrupt = () => corrupt2++
  c2.connStart(1)
  c2.feed(1, flvHeader())
  c2.feed(1, tag(9, new Uint8Array(5_000_000), 0))
  if (corrupt2 !== 1 || c2.snapshot().ready) throw new Error('超限 tag 应 kill')
})

check('非当前连接的 feed 被忽略', () => {
  const c = new FlvByteCollector()
  c.connStart(1)
  c.feed(2, chunks[0])
  if (c.snapshot().ready) throw new Error('错连接不应产生数据')
})

rmSync(dir, { recursive: true, force: true })
if (failures) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
