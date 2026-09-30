// 抖音直播游客态独立客户端验证脚本（研究用，低频率）。
// 链路：匿名取 ttwid → 房间页 HTML 解析 room_id → 无头 webmssdk 签名 → WSS im/push/v2 建连 → protobuf 解码。
// 用法：node --experimental-strip-types --no-warnings dy_client.mjs <web_rid> [观察秒数] [--no-sign]
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import WebSocket from 'ws'
import { loadWebmssdk } from './sign_node.mjs'
const { decodeFields, fint, fstr, encodeBytesField } = await import('./proto-lite.ts')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const LIVE_ORIGIN = 'https://live.douyin.com'

const webRid = process.argv[2]
const watchMs = Number(process.argv[3] || 100) * 1000
const noSign = process.argv.includes('--no-sign')
if (!webRid) {
  console.error('usage: node dy_client.mjs <web_rid> [seconds] [--no-sign]')
  process.exit(1)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- HTTP（手动 Cookie 处理） ----------

function cookieFromResponse(res) {
  const jar = {}
  const set = res.headers.getSetCookie?.() ?? []
  for (const line of set) {
    const [pair] = line.split(';')
    const i = pair.indexOf('=')
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
  }
  return jar
}

async function bootstrapCookies() {
  const res = await fetch(`${LIVE_ORIGIN}/`, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  })
  const jar = cookieFromResponse(res)
  await res.arrayBuffer()
  console.log('[bootstrap] Set-Cookie keys:', Object.keys(jar).join(', ') || '(none)')
  return jar
}

async function fetchRoomPage(jar) {
  const res = await fetch(`${LIVE_ORIGIN}/${webRid}`, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      referer: `${LIVE_ORIGIN}/`,
      cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
    },
  })
  const html = await res.text()
  for (const [k, v] of Object.entries(cookieFromResponse(res))) jar[k] = jar[k] || v
  const m = /id_str[\\":]+(\d{15,})/.exec(html)
  const room = {
    roomId: m ? m[1] : '',
    title: (html.match(/\\\\"title\\\\":\\\\"([^\\\\]{1,120})\\\\"/) || [])[1] || '',
    hasStream: /\.flv\?|\.m3u8\?/.test(html),
  }
  console.log('[room] http', res.status, 'roomId:', room.roomId, 'title:', room.title, 'streamInHTML:', room.hasStream)
  return { jar, room }
}

// ---------- im/fetch：拿 push_server 与初始游标 ----------

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
    if (wire === 0) { const v = rv(buf, pos); if (!v) break; pos = v[1]; (out.get(no) ?? out.set(no, []).get(no)).push({ v: v[0] }) }
    else if (wire === 2) { const l = rv(buf, pos); if (!l) break; pos = l[1]; const n = Number(l[0]); (out.get(no) ?? out.set(no, []).get(no)).push({ b: buf.subarray(pos, pos + n) }); pos += n }
    else if (wire === 1) pos += 8
    else if (wire === 5) pos += 4
    else break
  }
  return out
}

async function imFetchFirst(jar, roomId, webid) {
  const params = new URLSearchParams({
    resp_content_type: 'protobuf', did_rule: '3', device_id: '', app_name: 'douyin_web', endpoint: 'live_pc',
    support_wrds: '1', user_unique_id: webid, identity: 'audience', need_persist_msg_count: '15',
    insert_task_id: '', live_reason: '', room_id: roomId, version_code: '180800', last_rtt: '0',
    live_id: '1', aid: '6383', fetch_rule: '1', cursor: '', internal_ext: '', device_platform: 'web',
    cookie_enabled: 'true', screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN',
    browser_platform: 'Win32', browser_name: 'Mozilla', browser_online: 'true', tz_name: 'Asia/Shanghai',
  })
  const res = await fetch(`https://live.douyin.com/webcast/im/fetch/?${params}`, {
    headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', referer: `${LIVE_ORIGIN}/${webRid}`, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
  })
  const buf = Buffer.from(await res.arrayBuffer())
  const resp = protoFields(buf)
  const dec = (x) => x.toString('utf8')
  const pushServer = (resp.get(10)?.[0] && dec(resp.get(10)[0].b)) || (resp.get(14)?.[0] && dec(resp.get(14)[0].b)) || ''
  const cursor = resp.get(2)?.[0] ? dec(resp.get(2)[0].b) : ''
  const internalExt = resp.get(5)?.[0] ? dec(resp.get(5)[0].b) : ''
  const fetchType = resp.get(6)?.[0]?.v?.toString() ?? ''
  console.log('[im/fetch] http', res.status, 'bytes', buf.length, 'fetch_type:', fetchType, 'push_server:', pushServer)
  console.log('[im/fetch] cursor:', cursor.slice(0, 90))
  console.log('[im/fetch] internal_ext:', internalExt.slice(0, 120))
  return { pushServer, cursor, internalExt }
}

// ---------- WSS ----------

const WS_BASE = 'wss://webcast100-ws-web-lf.douyin.com/webcast/im/push/v2/'

function buildQS(roomId, webid, cursor, internalExt) {
  // 官方 SDK 的序列化器不做 URL 编码（k=v&k2=v2 裸拼接），这里保持一致
  const params = {
    app_name: 'douyin_web',
    version_code: '180800',
    webcast_sdk_version: '1.0.15',
    update_version_code: '1.0.15',
    compress: 'gzip',
    aid: '6383',
    live_id: '1',
    did_rule: '3',
    endpoint: 'live_pc',
    support_wrds: '1',
    user_unique_id: webid,
    im_path: '/webcast/im/fetch/',
    identity: 'audience',
    need_persist_msg_count: '15',
    insert_task_id: '',
    live_reason: '',
    room_id: roomId,
    heartbeatDuration: '0',
    cursor: cursor || `t-${Date.now()}`,
    internal_ext: internalExt || '',
    host: 'https://live.douyin.com',
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
  }
  let qs = ''
  for (const [k, v] of Object.entries(params)) qs += (qs ? '&' : '') + k + '=' + (v ?? '')
  return qs
}

function dumpTree(buf, depth = 0, maxDepth = 2, out = []) {
  if (depth > maxDepth) return out
  const fields = decodeFields(buf)
  for (const [no, list] of fields) {
    for (const f of list) {
      if (f.wire === 2) {
        const inner = f.bytes
        // 尝试作为嵌套消息解析；可解析且字段非空则递归，否则按字符串
        let nested = null
        try {
          const t = decodeFields(inner)
          const total = [...t.values()].reduce((a, l) => a + l.length, 0)
          if (total > 0 && inner.length > 2) nested = t
        } catch {}
        const asStr = inner.toString('utf8')
        const printable = asStr.length > 0 && [...asStr].every((c) => c.charCodeAt(0) >= 0x20 || c === '\n')
        if (nested && !printable) {
          out.push(`${'  '.repeat(depth)}${no}: msg(${inner.length}B)`)
          dumpTree(inner, depth + 1, maxDepth, out)
        } else if (printable) {
          out.push(`${'  '.repeat(depth)}${no}: ${JSON.stringify(asStr.slice(0, 80))}`)
        } else {
          out.push(`${'  '.repeat(depth)}${no}: bytes(${inner.length}B)`)
        }
      } else {
        out.push(`${'  '.repeat(depth)}${no}: ${f.int}`)
      }
    }
  }
  return out
}

const counts = {}
let chatShown = 0
let giftDumped = 0
let gotMsg = false
let cursor = ''
let internalExt = ''

function handleFrame(data) {
  const frame = decodeFields(data)
  const payloadType = fstr(frame.get(7)?.[0])
  const payload = frame.get(8)?.[0]?.bytes
  if (!payload || payloadType !== 'msg') return
  let body = payload
  if (payload.subarray(0, 2).toString('hex') === '1f8b') body = gunzipSync(payload)
  const resp = decodeFields(body)
  cursor = fstr(resp.get(2)?.[0]) || cursor
  internalExt = fstr(resp.get(5)?.[0]) || internalExt
  for (const m of resp.get(1) ?? []) {
    const msg = decodeFields(m.bytes)
    const method = fstr(msg.get(1)?.[0])
    const mp = msg.get(2)?.[0]?.bytes
    if (!method) continue
    counts[method] = (counts[method] || 0) + 1
    if (!gotMsg) {
      gotMsg = true
      console.log('[ws] 首条业务消息到达:', method)
    }
    if (!mp) continue
    if (method === 'WebcastChatMessage' && chatShown < 5) {
      chatShown++
      const cm = decodeFields(mp)
      const user = cm.get(2)?.[0]
      const u = user ? decodeFields(user.bytes) : null
      console.log('[chat]', fstr(u?.get(3)?.[0]), ':', fstr(cm.get(3)?.[0])?.slice(0, 50))
    }
    if (method === 'WebcastGiftMessage' && giftDumped < 3) {
      giftDumped++
      console.log(`[gift] GiftMessage 样本 #${giftDumped} (${mp.length}B) 字段树:`)
      console.log(dumpTree(mp, 1, 2).join('\n'))
    }
  }
}

async function main() {
  console.log(`[plan] web_rid=${webRid} 观察窗口=${watchMs / 1000}s 签名=${noSign ? '禁用(反证实验)' : '无头生成'}`)
  let jar
  if (process.env.DY_COOKIE_FILE) {
    const raw = readFileSync(process.env.DY_COOKIE_FILE, 'utf8').trim()
    jar = Object.fromEntries(raw.split('; ').map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]))
    console.log('[cookies] 使用外部 Cookie 文件:', process.env.DY_COOKIE_FILE, `(${Object.keys(jar).length} 个)`)
  } else {
    jar = await bootstrapCookies()
  }
  if (!jar.ttwid) throw new Error('未获得 ttwid，匿名引导失败')
  await sleep(2500)
  const { room } = await fetchRoomPage(jar)
  if (!room.roomId) throw new Error('未能从房间页解析 room_id')
  await sleep(2500)

  const webid = String(1_000_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 8_999_999_999_999_999_999)))
  let { pushServer, cursor: imCursor, internalExt: imExt } = await imFetchFirst(jar, room.roomId, webid)
  // im/fetch 可能因 Cookie 不全被软拒（需要 secsdk 安全 Cookie）；此时用已知推送端点兜底
  if (!pushServer) {
    pushServer = 'wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/'
    console.log('[im/fetch] 未下发 push_server，使用兜底端点:', pushServer)
  } else {
    await sleep(2000)
  }

  const { createHash } = await import('node:crypto')
  const md5empty = createHash('md5').update('').digest('hex')
  const { byted_acrawler } = loadWebmssdk()
  let signature = ''
  if (!noSign) {
    const t0 = Date.now()
    const out = byted_acrawler.frontierSign({ 'X-MS-STUB': md5empty })
    signature = out?.['X-Bogus'] || out?.signature || ''
    console.log('[sign] frontierSign({X-MS-STUB:md5("")}):', JSON.stringify(out), `${Date.now() - t0}ms`)
  }
  const qs = buildQS(room.roomId, webid, imCursor, imExt)
  const url = `${pushServer}?${qs}${signature ? `&signature=${signature}` : ''}`

  const cookieHeader = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
  const ws = new WebSocket(url, {
    headers: { Cookie: cookieHeader, 'User-Agent': UA, Origin: LIVE_ORIGIN },
  })
  let hb
  ws.on('unexpected-response', (_req, res) => {
    let b = ''
    res.on('data', (c) => (b += c.toString()))
    res.on('end', () => console.log(`[ws] 握手被拒 HTTP ${res.statusCode}:`, b.slice(0, 200) || '(无响应体)'))
  })
  ws.on('open', () => {
    console.log('[ws] 已连接 (101)', noSign ? '(无签名反证实验)' : '')
    hb = setInterval(() => {
      try {
        ws.send(encodeBytesField(7, Buffer.from('hb')))
      } catch {}
    }, 10000)
  })
  ws.on('message', handleFrame)
  ws.on('error', (e) => console.log('[ws] 错误:', e.message))
  ws.on('close', (code, reason) => {
    clearInterval(hb)
    console.log('[ws] 关闭', code, reason?.toString?.().slice(0, 80))
  })
  setTimeout(() => {
    try {
      ws.close()
    } catch {}
    console.log('=== 统计 ===')
    console.log('消息类型计数:', JSON.stringify(counts, null, 1))
    console.log('最终 cursor:', cursor)
    console.log('最终 internal_ext:', internalExt.slice(0, 160) || '(空)')
    process.exit(0)
  }, watchMs)
}

main().catch((e) => {
  console.error('FATAL:', e.message)
  process.exit(1)
})
