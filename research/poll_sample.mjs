// im/fetch 长轮询采样器：低频率（默认 2s 间隔，低于页面 1.1s）收集消息批次落盘。
// 用法：DY_COOKIE_FILE=full_cookie.txt node poll_sample.mjs <web_rid> [秒数] [间隔ms]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const { decodeFields, fstr } = await import('./proto-lite.ts')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const webRid = process.argv[2]
const durMs = Number(process.argv[3] || 90) * 1000
const interval = Number(process.argv[4] || 2000)
if (!webRid) {
  console.error('usage: node poll_sample.mjs <web_rid> [seconds] [intervalMs]')
  process.exit(1)
}

const raw = readFileSync(process.env.DY_COOKIE_FILE || 'full_cookie.txt', 'utf8').trim()
const jar = Object.fromEntries(raw.split('; ').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))

// 从房间页拿 room_id（若当前 jar 请求失败则退出）
const page = await fetch(`https://live.douyin.com/${webRid}`, {
  headers: { 'user-agent': UA, accept: 'text/html', cookie: raw },
})
const html = await page.text()
const m = /id_str[\\":]+(\d{15,})/.exec(html)
if (!m) {
  console.error('room_id 解析失败')
  process.exit(1)
}
const roomId = m[1]
console.log('[room]', roomId)

const outDir = 'samples'
mkdirSync(outDir, { recursive: true })
let cursor = ''
let internalExt = ''
let batch = 0
let counts = {}
const t0 = Date.now()

function protoFields(buf) {
  const out = new Map()
  let pos = 0
  const rv = (b, p) => {
    let v = 0n, s = 0n
    for (;;) {
      if (p >= b.length) return null
      const x = b[p++]
      v |= BigInt(x & 0x7f) << s
      if (!(x & 0x80)) return [v, p]
      s += 7n
    }
  }
  while (pos < buf.length) {
    const k = rv(buf, pos)
    if (!k) break
    pos = k[1]
    const no = Number(k[0] >> 3n), wire = Number(k[0] & 7n)
    if (no === 0) break
    if (wire === 0) { const v = rv(buf, pos); if (!v) break; pos = v[1]; if (!out.has(no)) out.set(no, []); out.get(no).push({ v: v[0] }) }
    else if (wire === 2) { const l = rv(buf, pos); if (!l) break; pos = l[1]; const n = Number(l[0]); if (!out.has(no)) out.set(no, []); out.get(no).push({ b: buf.subarray(pos, pos + n) }); pos += n }
    else if (wire === 1) pos += 8
    else if (wire === 5) pos += 4
    else break
  }
  return out
}

while (Date.now() - t0 < durMs) {
  const params = new URLSearchParams({
    resp_content_type: 'protobuf', did_rule: '3', device_id: '', app_name: 'douyin_web', endpoint: 'live_pc',
    support_wrds: '1', user_unique_id: '7690425553774937654', identity: 'audience', need_persist_msg_count: '15',
    insert_task_id: '', live_reason: '', room_id: roomId, version_code: '180800',
    last_rtt: '1100', live_id: '1', aid: '6383', fetch_rule: batch === 0 ? '1' : '2',
    cursor, internal_ext: internalExt, device_platform: 'web', cookie_enabled: 'true', screen_width: '1920',
    screen_height: '1080', browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Mozilla',
    browser_version:
      '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    browser_online: 'true', tz_name: 'Asia/Shanghai',
  })
  let buf = null
  try {
    const res = await fetch(`https://live.douyin.com/webcast/im/fetch/?${params}`, {
      headers: {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        referer: `https://live.douyin.com/${webRid}`,
        cookie: raw,
      },
    })
    buf = Buffer.from(await res.arrayBuffer())
    if (res.status !== 200 || buf.length === 0) {
      console.log(`[poll #${batch}] http ${res.status} bytes ${buf.length} —— 停止（风控或房间异常）`)
      break
    }
  } catch (e) {
    console.log('[poll] 网络错误:', e.message)
    break
  }
  const resp = decodeFields(buf)
  cursor = (resp.get(2)?.[0] && resp.get(2)[0].bytes.toString('utf8')) || cursor
  internalExt = (resp.get(5)?.[0] && resp.get(5)[0].bytes.toString('utf8')) || internalExt
  const file = join(outDir, `batch-${String(batch).padStart(3, '0')}.bin`)
  writeFileSync(file, buf)
  for (const mm of resp.get(1) ?? []) {
    const msg = decodeFields(mm.bytes)
    const method = fstr(msg.get(1)?.[0])
    counts[method] = (counts[method] || 0) + 1
    if (method === 'WebcastGiftMessage') console.log(`[poll #${batch}] *** GiftMessage 命中 -> ${file}`)
  }
  batch++
  await new Promise((r) => setTimeout(r, interval))
}
console.log(`完成：${batch} 批，目录 samples/`)
console.log(JSON.stringify(counts, null, 1))
