// 手动拉 3 批 im/fetch，dump 其中的 GiftSortMessage（内嵌礼物档案）
const fs = require('fs')
const { decodeFields, fstr } = require('./proto-lite.ts')

const raw = fs.readFileSync('full_cookie.txt', 'utf8').trim()
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

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
  const webRid = process.argv[2]
  const page = await fetch(`https://live.douyin.com/${webRid}`, {
    headers: { 'user-agent': UA, accept: 'text/html', cookie: raw },
  })
  const html = await page.text()
  const roomId = /id_str[\\":]+(\d{15,})/.exec(html)?.[1]
  console.log('room', roomId)
  let cursor = ''
  let internalExt = ''
  for (let batch = 0; batch < 4; batch++) {
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
    const res = await fetch(`https://live.douyin.com/webcast/im/fetch/?${params}`, {
      headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', referer: `https://live.douyin.com/${webRid}`, cookie: raw },
    })
    const buf = Buffer.from(await res.arrayBuffer())
    if (res.status !== 200 || !buf.length) {
      console.log(`batch ${batch}: http ${res.status} len ${buf.length} — 停止`)
      break
    }
    const resp = decodeFields(buf)
    cursor = fstr(resp.get(2)?.[0]) || cursor
    internalExt = fstr(resp.get(5)?.[0]) || internalExt
    for (const mm of resp.get(1) ?? []) {
      const msg = decodeFields(mm.bytes)
      const method = fstr(msg.get(1)?.[0])
      if (method === 'WebcastGiftSortMessage' || method === 'WebcastGiftMessage') {
        const mp = msg.get(2)?.[0]?.bytes
        console.log(`\n=== ${method} (${mp.length}B, batch ${batch}) ===`)
        const out = []
        dumpTree(mp, 0, 5, out)
        console.log(out.join('\n'))
      }
    }
    await new Promise((r) => setTimeout(r, 2200))
  }
})().catch((e) => console.error('ERR', e.message))
