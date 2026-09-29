/**
 * 公屏弹幕（方案 C：自建 WS 客户端）。
 * 直连 douyin IM 推送服务（webcast3-ws-web-lf.douyin.com，路径 /webcast/im/push/v2/）：
 * - 签名参数 signature 复用隐藏 guest 页里的 byted_acrawler.frontierSign 计算
 * - 帧为 protobuf（proto-lite 手工解码），PushFrame.payload 多为 gzip
 * - 每 10s 发一次 payload_type='hb' 心跳；断线指数退避重连
 * 字段号参照公开的 douyin webcast proto（PushFrame/Response/ChatMessage/User），
 * 协议漂移时优先核对本文件与 proto-lite.ts。
 */
import WebSocket from 'ws'
import { gunzipSync } from 'node:zlib'
import { IPC } from '@shared/ipc'
import type { ChatItem, ChatEvent } from '@shared/types'
import { decodeFields, encodeBytesField, fstr } from './proto-lite'
import { log } from '../util'
import type { DouyinSessions } from './sessions'

const WS_BASE = 'wss://webcast100-ws-web-lf.douyin.com/webcast/im/push/v2/'
const HB_INTERVAL_MS = 10_000
const MAX_RECONNECT = 6
const FLUSH_MS = 400

export interface ChatServiceDeps {
  sessions: DouyinSessions
  broadcast: (channel: string, payload: unknown) => void
}

function colorFor(nick: string): number {
  let h = 0
  for (let i = 0; i < nick.length; i++) h = (h * 31 + nick.charCodeAt(i)) >>> 0
  return h % 360
}

export class ChatService {
  private ws: WebSocket | null = null
  private roomId = ''
  private webRid = ''
  private stopped = true
  private hbTimer: NodeJS.Timeout | undefined
  private flushTimer: NodeJS.Timeout | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private buffer: ChatItem[] = []
  /** 去重键（msg_id 优先，缺省用 昵称+内容）→ 最近出现时间 */
  private seenKeys = new Map<string, number>()
  private cursor = ''
  private internalExt = ''
  private attempts = 0
  private webid = ''
  private gotMsg = false

  constructor(private deps: ChatServiceDeps) {}

  start(ref: { roomId: string; webRid?: string }): void {
    this.stop()
    this.stopped = false
    this.roomId = ref.roomId
    this.webRid = ref.webRid ?? ''
    this.attempts = 0
    this.gotMsg = false
    this.cursor = ''
    this.internalExt = ''
    this.buffer = []
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.hbTimer)
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    clearTimeout(this.reconnectTimer)
    // 切房/退出：旧房间的缓冲直接丢弃（flush 会把旧房间的消息推给新房间的渲染层）
    this.buffer = []
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      try {
        ws.removeAllListeners()
        // CONNECTING 阶段 close() 会异步 emit error；挂空监听防止无人接收导致主进程崩溃
        ws.on('error', () => {})
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate()
        else ws.close()
      } catch {}
    }
  }

  // ---------- 连接 ----------

  /** 参数模板与抖音网页端自建的弹幕 WS 一致（字段/顺序照抄真实抓包，勿随意增删） */
  private async buildUrl(): Promise<string> {
    const ses = this.deps.sessions
    const ttwid = await ses.getGuestCookie('ttwid')
    if (!ttwid) log('chat', '警告：guest 会话无 ttwid Cookie')
    if (!this.webid) {
      this.webid =
        (await ses.getGuestCookie('webid')) ||
        String(1_000_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 8_999_999_999_999_999_999)))
    }
    const params: Record<string, string> = {
      app_name: 'douyin_web',
      version_code: '180800',
      webcast_sdk_version: '1.0.15',
      update_version_code: '1.0.15',
      compress: 'gzip',
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
      cursor: this.cursor || `t-${Date.now()}`,
      internal_ext: this.internalExt,
      host: 'https://live.douyin.com',
      aid: '6383',
      live_id: '1',
      did_rule: '3',
      endpoint: 'live_pc',
      support_wrds: '1',
      user_unique_id: this.webid,
      im_path: '/webcast/im/fetch/',
      identity: 'audience',
      need_persist_msg_count: '15',
      insert_task_id: '',
      live_reason: '',
      room_id: this.roomId,
      heartbeatDuration: '0'
    }
    const qs = new URLSearchParams(params).toString()
    // 对最终查询串原样计算 frontierSign（取其 X-Bogus），与页面行为一致；真实 URL 中 signature 不做 URL 编码
    const signature = await ses.frontierSign(qs)
    if (!signature) log('chat', '警告：签名为空，连接大概率被拒')
    return `${WS_BASE}?${qs}&signature=${signature}`
  }

  private async connect(): Promise<void> {
    try {
      // 弹幕连接参数来自页面侧捕获（含合法签名与游标）；自建 URL 仅作兜底
      let url = ''
      if (this.webRid) {
        url = await this.deps.sessions.captureRoomWSUrl(this.webRid, this.roomId)
        if (url) log('chat', '已获取页面侧弹幕连接参数')
      }
      if (!url) {
        log('chat', '未捕获到页面连接参数，尝试自建 URL')
        url = await this.buildUrl()
      }
      // WS 升级请求必须带浏览器同款头：Cookie(ttwid 等) 缺失会被风控拒（回 200 而非 101）
      const cookie = await this.deps.sessions.getGuestCookieHeader()
      const ua = this.deps.sessions.getUserAgent()
      const ws = new WebSocket(url, {
        headers: {
          Cookie: cookie,
          'User-Agent': ua,
          Origin: 'https://live.douyin.com'
        }
      })
      this.ws = ws
      ws.on('open', () => {
        log('chat', '弹幕服务已连接', this.roomId)
        this.attempts = 0
        clearInterval(this.hbTimer)
        this.hbTimer = setInterval(() => {
          try {
            ws.send(this.heartbeat())
          } catch {}
        }, HB_INTERVAL_MS)
      })
      ws.on('message', (data: Buffer) => this.handleFrame(data))
      ws.on('error', (e) => log('chat', 'WS 错误:', e.message))
      // 握手被拒时抓响应体，服务器通常会说明拒绝原因
      ws.on('unexpected-response', (_req, res) => {
        let body = ''
        res.on('data', (c: Buffer) => {
          body += c.toString()
        })
        res.on('end', () => {
          log('chat', `握手被拒 HTTP ${res.statusCode}:`, body.slice(0, 260) || '(无响应体)')
        })
      })
      ws.on('close', () => this.scheduleReconnect('closed'))
    } catch (e) {
      log('chat', '连接失败:', (e as Error)?.message)
      this.scheduleReconnect('error')
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return
    this.attempts++
    if (this.attempts > MAX_RECONNECT) {
      log('chat', `重连 ${MAX_RECONNECT} 次失败，放弃（${reason}）`)
      return
    }
    const delay = Math.min(5_000, 1_500 * 2 ** (this.attempts - 1))
    log('chat', `${delay}ms 后重连（第 ${this.attempts} 次，${reason}）`)
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) void this.connect()
    }, delay)
  }

  // ---------- 帧处理 ----------

  private heartbeat(): Buffer {
    // PushFrame{ payload_type='hb' }
    return encodeBytesField(7, Buffer.from('hb'))
  }

  private handleFrame(data: Buffer): void {
    const frame = decodeFields(data)
    const payloadType = fstr(frame.get(7)?.[0]) // payload_type
    const payload = frame.get(8)?.[0]?.bytes
    if (!payload) return
    if (payloadType !== 'msg') return

    let body = payload
    // payload_encoding 实测为 'pb'，但数据实为 gzip（1f 8b 魔数），按魔数判断最稳
    if (payload.subarray(0, 2).toString('hex') === '1f8b') {
      try {
        body = gunzipSync(payload)
      } catch (e) {
        log('chat', 'gunzip 失败:', (e as Error)?.message)
        return
      }
    }
    const resp = decodeFields(body)
    const cursor = fstr(resp.get(2)?.[0])
    if (cursor) this.cursor = cursor
    const ext = fstr(resp.get(6)?.[0])
    if (ext) this.internalExt = ext
    for (const m of resp.get(1) ?? []) {
      const msg = decodeFields(m.bytes)
      const method = fstr(msg.get(1)?.[0])
      const mp = msg.get(2)?.[0]?.bytes
      if (!mp) continue
      if (method === 'WebcastChatMessage') this.onChat(mp)
    }
  }

  /** ChatMessage{ common=1, user=2, content=3 }；Common{ method=1, msg_id=2 }；User{ id=1, nick_name=3 } */
  private onChat(buf: Buffer): void {
    const cm = decodeFields(buf)
    const content = fstr(cm.get(3)?.[0])
    const user = cm.get(2)?.[0]
    if (!content || !user) return
    const u = decodeFields(user.bytes)
    const nick = fstr(u.get(3)?.[0])
    if (!nick) return
    // IM 服务器会经多路由重复投递：msg_id 相同视为重复；msg_id 缺失时按 昵称+内容 在 3s 窗口内去重
    const common = cm.get(1)?.[0]
    const msgId = common ? fstr(decodeFields(common.bytes).get(2)?.[0]) : ''
    const key = msgId || `${nick}\u0001${content}`
    const now = Date.now()
    const last = this.seenKeys.get(key)
    if (last !== undefined && now - last < 3_000) return
    this.seenKeys.set(key, now)
    if (this.seenKeys.size > 800) {
      for (const [k, t] of this.seenKeys) {
        if (now - t > 120_000) this.seenKeys.delete(k)
      }
      if (this.seenKeys.size > 800) this.seenKeys.clear()
    }
    if (!this.gotMsg) {
      this.gotMsg = true
      log('chat', '已收到首条弹幕')
    }
    this.buffer.push({ nick, color: colorFor(nick), content })
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flushNow(), FLUSH_MS)
  }

  private flushNow(): void {
    this.flushTimer = undefined
    if (this.stopped || !this.buffer.length) return
    const ev: ChatEvent = { roomId: this.roomId, items: this.buffer.splice(0) }
    this.deps.broadcast(IPC.EvChatMessage, ev)
  }
}
