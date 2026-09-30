// FlvSeiParser 单元测试：用实测捕获的 SEI 报文构造合成 FLV，验证任意 chunk 切分下的解析
// 用法: node --experimental-strip-types sei_parser_test.mjs
import { createFlvSeiParser } from '../src/renderer/src/lib/flvSei.ts'
import assert from 'node:assert'

// ---------- 构造合成 FLV ----------

// 内层 app_data（结构对齐实测报文，数值取自「老17」房间捕获）
const inner = JSON.stringify({
  land_mask_timestamp: null,
  mix_grids: [
    { w: 0.5, h: 0.40625, x: 0, p: 0, y: 0.19, type: 1, uid_str: '1_148818f7a74748ab00a6b712865587af', talk_volume: 46, mute_audio: 0 },
    { w: 0.5, h: 0.40625, x: 0.5, p: 1, y: 0.19, type: 1, uid_str: '1_54bf6e929d877c053579a233838405ba', mute_audio: 1 }
  ],
  grids: [{ w: 0.5, h: 0.40625, x: 0.5, y: 0.19, uid_str: '1_54bf6e929d877c053579a233838405ba', mute_audio: 1 }],
  anchor_interact_info: { scale_type: 0, owner_index: 0, align_mode: 4, is_horizontal: 0, layout_type: 0, ui_layout: 1, focus_id: '0' },
  channel_id: '7691236225698190390',
  ver: 2,
  canvas: { width: 360, background: '#1F212C', height: 640 },
  vendor: 'byte',
  timestamp: 1790756709719.166
})
// 全幅布局（PK 结束/单人）
const innerFull = JSON.stringify({
  mix_grids: [{ w: 1, h: 1, x: 0, y: 0, type: 1, uid_str: '1_aaa' }],
  ver: 2,
  canvas: { width: 360, height: 640 }
})

// 外层 SEI 明文（网页 KR 解析的目标：含包裹文本 + JSON）
const seiText = (appData) =>
  '  \x00 garbage prefix {"app_data":' + JSON.stringify(appData) + ',"sei_index":194902} trailing'

const u32 = (v) => new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255])
const be24 = (v) => new Uint8Array([(v >>> 16) & 255, (v >>> 8) & 255, v & 255])

/** AVC NALU 包的 VideoTagBody：sequence header + NALU 包(SEI-100) */
function videoTagBody(seiPayload) {
  const seq = new Uint8Array([0x17, 0x00, 0, 0, 0, 0, 0, 0, 1, 0x67, 0x64, 0x00]) // 简化 seq header
  const seiNal = [0x06, 100] // NALU 头(type=6 SEI) + payload_type=100
  // 变长 size 编码（payload > 255 时走 0xFF 续接）
  const n = seiPayload.length
  const sizeBytes = []
  let rest = n
  while (rest >= 255) {
    sizeBytes.push(255)
    rest -= 255
  }
  sizeBytes.push(rest)
  seiNal.push(...sizeBytes)
  for (const ch of seiPayload) seiNal.push(ch.charCodeAt(0) & 0xff)
  seiNal.push(0x80) // rbsp trailing bits
  const nal = new Uint8Array(seiNal)
  const body = new Uint8Array([0x17, 0x01, 0, 0, 0]) // keyframe + AVC NALU 包 + CTS
  const parts = [body, u32(seq.length), seq, u32(nal.length), nal]
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function flv(tags) {
  const head = new Uint8Array([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0])
  const parts = [head]
  for (const { type, data } of tags) {
    parts.push(new Uint8Array([type, ...be24(data.length), 0, 0, 1, 0, 0, 0, 0]))
    parts.push(data)
    parts.push(u32(11 + data.length))
  }
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const pkFlv = flv([
  { type: 18, data: new Uint8Array([0, 3, 0, 0, 0, 9]) }, // script tag（应被忽略）
  { type: 9, data: videoTagBody(seiText(inner)) },
  { type: 8, data: new Uint8Array([0xaf, 0x01, 1]) } // audio tag（应被忽略）
])
const fullFlv = flv([{ type: 9, data: videoTagBody(seiText(innerFull)) }])

// ---------- 断言 ----------

function collect() {
  const layouts = []
  const parser = createFlvSeiParser((l) => layouts.push(l))
  return { layouts, parser }
}

// 1) 一次喂入
{
  const { layouts, parser } = collect()
  parser.feed(pkFlv)
  assert.equal(layouts.length, 1, '一次喂入应产出 1 条布局')
  const l = layouts[0]
  assert.equal(l.ver, 2)
  assert.equal(l.canvasW, 360)
  assert.equal(l.canvasH, 640)
  assert.deepEqual(
    { x: l.bounds.x, y: l.bounds.y, w: +l.bounds.w.toFixed(5), h: +l.bounds.h.toFixed(5) },
    { x: 0, y: 0.19, w: 1, h: 0.40625 },
    '包围盒应等于双人内容带'
  )
}

// 2) 任意 1~N 字节切分喂入（覆盖 tag 跨 chunk、SEI 跨 chunk）
for (const step of [1, 2, 3, 7, 13, 64, 4096]) {
  const { layouts, parser } = collect()
  for (let i = 0; i < pkFlv.length; i += step) parser.feed(pkFlv.subarray(i, i + step))
  assert.equal(layouts.length, 1, `step=${step} 应恰好产出 1 条布局`)
}

// 3) 独立实例喂全幅布局（生产中每次重连都是新 parser：新 tap + 新 fetch）
{
  const layouts = []
  const parser = createFlvSeiParser((l) => layouts.push(l))
  parser.feed(fullFlv)
  assert.equal(layouts.length, 1)
  assert.deepEqual(layouts[0].bounds, { x: 0, y: 0, w: 1, h: 1 }, '全幅布局应为 0,0,1,1')
}

// 4) 非目标 SEI 类型（payload_type=5）与损坏 tag 不产出、不抛异常
{
  const layouts = []
  const parser = createFlvSeiParser((l) => layouts.push(l))
  // 构造 payload_type=5 的 SEI
  const badFlv = flv([
    {
      type: 9,
      data: (() => {
        const nal = new Uint8Array([0x06, 5, 4, 1, 2, 3, 4, 0x80])
        const body = new Uint8Array([0x17, 0x01, 0, 0, 0])
        const out = new Uint8Array(body.length + 4 + nal.length)
        out.set(body, 0)
        out.set(u32(nal.length), body.length)
        out.set(nal, body.length + 4)
        return out
      })()
    },
    { type: 9, data: new Uint8Array([0x17, 0x01, 0, 0, 0, 0, 0, 0, 255, 0xff, 0xff, 0xff, 0xff]) } // 损坏 NALU 长度
  ])
  parser.feed(badFlv)
  assert.equal(layouts.length, 0, '非 100 类 SEI 不应产出')
}

console.log('sei_parser_test: 全部通过 ✓')
