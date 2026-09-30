// 最终对照：Node ws + 同一会话 jar + im/fetch 签发的 cursor/internal_ext + 正确签名
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { loadWebmssdk } from './sign_node.mjs'

const raw = readFileSync('full_cookie.txt', 'utf8').trim()
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const roomId = '7691093117956606739'
const cursor = 't-1790725611257_r-7691107931059725193_d-1_u-1_h-1'
const internalExt = 'internal_src:dim|wss_push_room_id:7691093117956606739|wss_push_did:7691096345697207834|first_req_ms:1790725433498|fetch_time:1790725611257|seq:78|wss_info:1-1790725433584-0-77|wrds_v:7691107931059653602'

const { byted_acrawler } = loadWebmssdk()
const md5empty = createHash('md5').update('').digest('hex')
const signature = byted_acrawler.frontierSign({ 'X-MS-STUB': md5empty })['X-Bogus']

const params = {
  app_name: 'douyin_web', version_code: '180800', webcast_sdk_version: '1.0.15', update_version_code: '1.0.15',
  compress: 'gzip', aid: '6383', live_id: '1', did_rule: '3', endpoint: 'live_pc', support_wrds: '1',
  user_unique_id: '7690425553774937654', im_path: '/webcast/im/fetch/', identity: 'audience',
  need_persist_msg_count: '15', insert_task_id: '', live_reason: '', room_id: roomId, heartbeatDuration: '0',
  cursor, internal_ext: internalExt, host: 'https://live.douyin.com', device_platform: 'web',
  cookie_enabled: 'true', screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN',
  browser_platform: 'Win32', browser_name: 'Mozilla',
  browser_version: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  browser_online: 'true', tz_name: 'Asia/Shanghai',
}
let qs = ''
for (const [k, v] of Object.entries(params)) qs += (qs ? '&' : '') + k + '=' + (v ?? '')
const url = `wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/?${qs}&signature=${signature}`
const ws = new WebSocket(url, { headers: { Cookie: raw, 'User-Agent': UA, Origin: 'https://live.douyin.com' } })
ws.on('open', () => { console.log('OPEN 会话绑定建连成功'); ws.send(Buffer.from([0x3a, 0x02, 0x68, 0x62])); setTimeout(() => process.exit(0), 10000) })
ws.on('message', (d) => console.log('frame', d.length, 'B'))
ws.on('unexpected-response', (_q, r) => { console.log('HTTP', r.statusCode); process.exit(1) })
ws.on('error', (e) => { console.log('error:', e.message) })
setTimeout(() => process.exit(2), 15000)
