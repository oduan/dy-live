// 礼物采样器：多房间并发 im/fetch 长轮询，仅落盘含 GiftMessage 的批次 + 全类型统计
// 用法：node poll_gifts.cjs <秒数> [间隔ms] room1 room2 ...
// 单房间节奏仍 ≤2.5s/次（页面自身 1.1s），总请求速率受控
const fs = require('fs')
const path = require('path')
const { decodeFields, fstr } = require('./proto-lite.ts')

const raw = fs.readFileSync('full_cookie.txt', 'utf8').trim()
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const durMs = Number(process.argv[2] || 600) * 1000
const interval = Number(process.argv[3] || 2500)
const webRids = process.argv.slice(4)
if (!webRids.length) {
  console.error('usage: node poll_gifts.cjs <seconds> [intervalMs] webRid...')
  process.exit(1)
}
const outDir = 'gift_samples'
fs.mkdirSync(outDir, { recursive: true })

const stats = {}
let giftBatches = 0
let totalGifts = 0
const t0 = Date.now()

function printStats() {
  const el = Math.round((Date.now() - t0) / 1000)
  console.log(`[t=${el}s] 礼物批次=${giftBatches} 礼物总数=${totalGifts} 类型=${JSON.stringify(stats)}`)
}

async function pollRoom(webRid) {
  // room_id 从房间页解析
  let roomId = ''
  try {
    const page = await fetch(`https://live.douyin.com/${webRid}`, {
      headers: { 'user-agent': UA, accept: 'text/html', cookie: raw },
    })
    const html = await page.text()
    roomId = /id_str[\\":]+(\d{15,})/.exec(html)?.[1] || ''
  } catch (e) {}
  if (!roomId) {
    console.log(`[${webRid}] room_id 解析失败，跳过`)
    return
  }
  console.log(`[${webRid}] room=${roomId} 开始采样`)
  let cursor = ''
  let internalExt = ''
  let batch = 0
  while (Date.now() - t0 < durMs) {
    const params = new URLSearchParams({
      resp_content_type: 'protobuf',
      did_rule: '3',
      device_id: '',
      app_name: 'douyin_web',
      endpoint: 'live_pc',
      support_wrds: '1',
      user_unique_id: '7690425553774937654',
      identity: 'audience',
      need_persist_msg_count: '15',
      insert_task_id: '',
      live_reason: '',
      room_id: roomId,
      version_code: '180800',
      last_rtt: '1100',
      live_id: '1',
      aid: '6383',
      fetch_rule: batch === 0 ? '1' : '2',
      cursor,
      internal_ext: internalExt,
      device_platform: 'web',
      cookie_enabled: 'true',
      screen_width: '1920',
      screen_height: '1080',
      browser_language: 'zh-CN',
      browser_platform: 'Win32',
      browser_name: 'Mozilla',
      browser_version:
        '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      browser_online: 'true',
      tz_name: 'Asia/Shanghai',
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
        console.log(`[${webRid}] poll #${batch} http ${res.status} len ${buf.length} —— 停止该房间`)
        return
      }
    } catch (e) {
      console.log(`[${webRid}] 网络错误:`, e.message)
      await new Promise((r) => setTimeout(r, 3000))
      continue
    }
    const resp = decodeFields(buf)
    cursor = fstr(resp.get(2)?.[0]) || cursor
    internalExt = fstr(resp.get(5)?.[0]) || internalExt
    let hasGift = false
    for (const mm of resp.get(1) ?? []) {
      const msg = decodeFields(mm.bytes)
      const method = fstr(msg.get(1)?.[0]) || '?'
      stats[method] = (stats[method] || 0) + 1
      if (method === 'WebcastGiftMessage') hasGift = true
    }
    if (hasGift) {
      const file = path.join(outDir, `${webRid}-b${String(batch).padStart(4, '0')}.bin`)
      fs.writeFileSync(file, buf)
      giftBatches++
      const n = (stats['WebcastGiftMessage'] ?? 0)
      totalGifts++
      console.log(`[${webRid}] *** GiftMessage 命中 -> ${file}`)
    }
    batch++
    const spent = Date.now() % interval
    await new Promise((r) => setTimeout(r, interval))
  }
  console.log(`[${webRid}] 采样结束`)
}

;(async () => {
  const timer = setInterval(printStats, 30000)
  await Promise.all(webRids.map((r) => pollRoom(r).catch((e) => console.log(`[${r}] ERR`, e.message))))
  clearInterval(timer)
  printStats()
})()
