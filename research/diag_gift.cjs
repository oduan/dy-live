// 诊断：旁路监听指定房间的全部 IM 消息，统计每种 method 的出现次数；
// 任何 method 名含 Gift（不区分大小写）的完整 dump 字段树，用于定位小心心真实通道。
// 用法：node --experimental-strip-types diag_gift.cjs <roomId> [秒]
const fs = require('fs')
const { decodeFields, fstr } = require('./proto-lite.ts')

const raw = fs.readFileSync('full_cookie.txt', 'utf8').trim()
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const roomId = process.argv[2]
const durMs = Number(process.argv[3] || 240) * 1000

function printable(s) {
  return s.length > 0 && [...s].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
}
function dumpTree(buf, depth, maxDepth, out) {
  if (depth > maxDepth) return
  for (const [no, list] of decodeFields(buf)) {
    for (const f of list) {
      const pad = '  '.repeat(depth + 1)
      if (f.wire === 2) {
        const s = f.bytes.toString('utf8')
        if (printable(s)) out.push(`${pad}${no}: ${JSON.stringify(s.slice(0, 90))}`)
        else {
          try {
            const t = decodeFields(f.bytes)
            const total = [...t.values()].reduce((a, l) => a + l.length, 0)
            if (total > 0) {
              out.push(`${pad}${no}: msg(${f.bytes.length}B)`)
              dumpTree(f.bytes, depth + 1, maxDepth, out)
              continue
            }
          } catch {}
          out.push(`${pad}${no}: bytes(${f.bytes.length}B)`)
        }
      } else out.push(`${pad}${no}: ${f.int}`)
    }
  }
}

;(async () => {
  console.log(`监听房间 ${roomId}，${durMs / 1000}s，所有消息类型都会统计…`)
  let cursor = ''
  let internalExt = ''
  const seen = new Map()
  const t0 = Date.now()
  let batch = 0
  while (Date.now() - t0 < durMs) {
    const params = new URLSearchParams({
      resp_content_type: 'protobuf', did_rule: '3', device_id: '', app_name: 'douyin_web', endpoint: 'live_pc',
      support_wrds: '1', user_unique_id: '7690425553774937654', identity: 'audience', need_persist_msg_count: '15',
      insert_task_id: '', live_reason: '', room_id: roomId, version_code: '180800', last_rtt: '1100',
      live_id: '1', aid: '6383', fetch_rule: batch === 0 ? '1' : '2', cursor, internal_ext: internalExt,
      device_platform: 'web', cookie_enabled: 'true', screen_width: '1920', screen_height: '1080',
      browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Mozilla',
      browser_version: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      browser_online: 'true', tz_name: 'Asia/Shanghai',
    })
    let buf = null
    try {
      const res = await fetch(`https://live.douyin.com/webcast/im/fetch/?${params}`, {
        headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', referer: 'https://live.douyin.com/', cookie: raw },
      })
      buf = Buffer.from(await res.arrayBuffer())
      if (res.status !== 200 || !buf.length) {
        console.log(`http ${res.status} len ${buf.length} —— 房间可能不在播或风控，停止`)
        return
      }
    } catch (e) {
      console.log('网络错误:', e.message)
      await new Promise((r) => setTimeout(r, 3000))
      continue
    }
    const resp = decodeFields(buf)
    cursor = fstr(resp.get(2)?.[0]) || cursor
    internalExt = fstr(resp.get(5)?.[0]) || internalExt
    for (const mm of resp.get(1) ?? []) {
      const msg = decodeFields(mm.bytes)
      const method = fstr(msg.get(1)?.[0]) || '?'
      seen.set(method, (seen.get(method) || 0) + 1)
      if (/gift/i.test(method) && !/Sort/.test(method)) {
        const mp = msg.get(2)?.[0]?.bytes
        console.log(`\n=== ${method} (${mp.length}B) @${new Date().toISOString().slice(11, 19)} ===`)
        const out = []
        dumpTree(mp, 0, 4, out)
        console.log(out.join('\n'))
      }
    }
    batch++
    await new Promise((r) => setTimeout(r, 1500))
  }
  console.log('\n---- 全部消息类型统计 ----')
  for (const [m, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.log(`${n}\t${m}`)
})().catch((e) => console.error('ERR', e.message))
