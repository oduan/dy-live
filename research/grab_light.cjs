// 抓 WebcastLightGiftMessage（轻礼物）：落盘含该消息的批次 + 首条 dump 字段树
// 用法：node --experimental-strip-types grab_light.cjs <秒> <间隔ms> <web_rid...>
const fs = require('fs')
const path = require('path')
const { decodeFields, fstr } = require('./proto-lite.ts')

const raw = fs.readFileSync('full_cookie.txt', 'utf8').trim()
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const durMs = Number(process.argv[2] || 600) * 1000
const interval = Number(process.argv[3] || 2500)
const webRids = process.argv.slice(4)
const outDir = 'light_samples'
fs.mkdirSync(outDir, { recursive: true })

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

let caught = 0
const t0 = Date.now()
async function pollRoom(webRid) {
  let roomId = ''
  try {
    const page = await fetch(`https://live.douyin.com/${webRid}`, {
      headers: { 'user-agent': UA, accept: 'text/html', cookie: raw },
    })
    roomId = /id_str[\\":]+(\d{15,})/.exec(await page.text())?.[1] || ''
  } catch {}
  if (!roomId) return console.log(`[${webRid}] room_id 解析失败`)
  console.log(`[${webRid}] room=${roomId}`)
  let cursor = ''
  let internalExt = ''
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
        headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', referer: `https://live.douyin.com/${webRid}`, cookie: raw },
      })
      buf = Buffer.from(await res.arrayBuffer())
      if (res.status !== 200 || !buf.length) return console.log(`[${webRid}] http ${res.status} —— 停止`)
    } catch (e) {
      await new Promise((r) => setTimeout(r, 3000))
      continue
    }
    const resp = decodeFields(buf)
    cursor = fstr(resp.get(2)?.[0]) || cursor
    internalExt = fstr(resp.get(5)?.[0]) || internalExt
    let hasLight = false
    for (const mm of resp.get(1) ?? []) {
      const msg = decodeFields(mm.bytes)
      const method = fstr(msg.get(1)?.[0])
      if (method === 'WebcastLightGiftMessage') {
        hasLight = true
        const mp = msg.get(2)?.[0]?.bytes
        const file = path.join(outDir, `${webRid}-b${String(batch).padStart(4, '0')}.bin`)
        fs.writeFileSync(file, buf)
        caught++
        if (caught <= 5) {
          console.log(`\n=== WebcastLightGiftMessage (${mp.length}B, ${file}) ===`)
          const out = []
          dumpTree(mp, 0, 4, out)
          console.log(out.join('\n'))
        } else {
          console.log(`[${webRid}] *** LightGift 命中 #${caught} -> ${file}`)
        }
      }
    }
    batch++
    await new Promise((r) => setTimeout(r, interval))
  }
}
;(async () => {
  await Promise.all(webRids.map((r) => pollRoom(r).catch((e) => console.log(`[${r}] ERR`, e.message))))
  console.log(`\n完成：${caught} 条 LightGiftMessage -> ${outDir}/`)
})()
