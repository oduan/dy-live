/**
 * 公屏弹幕（自建 WS 客户端，签名/游标借页面侧捕获）。
 * 直连 douyin IM 推送服务（webcast100-ws-web-lf.douyin.com，路径 /webcast/im/push/v2/）：
 * - 签名参数 signature 借隐藏 guest 页里的 byted_acrawler.frontierSign 计算
 * - 帧为 protobuf（proto-lite 手工解码），payload 标 'pb' 实为 gzip，按魔数判断解压
 * - 每 10s 心跳；30s 无数据主动断开重连；断线指数退避，全程以系统弹幕同步状态
 * 字段号参照公开的 douyin webcast proto（PushFrame/Response/ChatMessage/User/GiftMessage），
 * 协议漂移时优先核对本文件与 proto-lite.ts。
 */
import WebSocket from 'ws'
import { gunzipSync } from 'node:zlib'
import { IPC } from '@shared/ipc'
import type { ChatItem, ChatEvent } from '@shared/types'
import { decodeFields, encodeBytesField, fint, fstr } from './proto-lite'
import { log } from '../util'
import type { DouyinSessions } from './sessions'

const WS_BASE = 'wss://webcast100-ws-web-lf.douyin.com/webcast/im/push/v2/'
const HB_INTERVAL_MS = 10_000
/** 超过该时长未收到任何帧视为连接已死，主动断开重连 */
const DEAD_AFTER_MS = 30_000
const LIVENESS_CHECK_MS = 10_000
const MAX_RECONNECT = 10
const FLUSH_MS = 400
const DEDUP_WINDOW_MS = 3_000

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
  private livenessTimer: NodeJS.Timeout | undefined
  private flushTimer: NodeJS.Timeout | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private buffer: ChatItem[] = []
  /** 去重键（msg_id 优先，缺省用 类型+昵称+内容）→ 最近出现时间 */
  private seenKeys = new Map<string, number>()
  private cursor = ''
  private internalExt = ''
  private attempts = 0
  private webid = ''
  private gotMsg = false
  private lastFrameAt = 0

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
    this.seenKeys = new Map()
    this.sys('正在连接弹幕…')
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.hbTimer)
    clearInterval(this.livenessTimer)
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

  /** 系统弹幕：连接生命周期同步给用户（立即推送，不参与批量缓冲） */
  private sys(content: string): void {
    if (this.stopped) return
    log('chat', '[sys]', content)
    const ev: ChatEvent = { roomId: this.roomId, items: [{ kind: 'sys', nick: '', color: 0, content }] }
    this.deps.broadcast(IPC.EvChatMessage, ev)
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
      // 弹幕连接参数优先借页面侧捕获（含合法签名与游标）；自建 URL 仅作兜底
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
        this.lastFrameAt = Date.now()
        this.sys('弹幕连接已建立')
        clearInterval(this.hbTimer)
        this.hbTimer = setInterval(() => {
          try {
            ws.send(this.heartbeat())
          } catch {}
        }, HB_INTERVAL_MS)
        // 静默死亡检测：网络假死时不会有 close 事件，超时主动断开触发重连
        clearInterval(this.livenessTimer)
        this.livenessTimer = setInterval(() => {
          if (Date.now() - this.lastFrameAt > DEAD_AFTER_MS) {
            log('chat', '超过 30s 未收到数据，主动断开重连')
            ws.terminate()
          }
        }, LIVENESS_CHECK_MS)
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
    clearInterval(this.hbTimer)
    clearInterval(this.livenessTimer)
    this.attempts++
    if (this.attempts > MAX_RECONNECT) {
      this.sys('弹幕连接已断开，重新打开弹幕开关可重试')
      log('chat', `重连 ${MAX_RECONNECT} 次失败，放弃（${reason}）`)
      return
    }
    const delay = Math.min(30_000, 2_000 * 2 ** (this.attempts - 1))
    this.sys(`弹幕连接中断，正在重连（第 ${this.attempts} 次）…`)
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
    this.lastFrameAt = Date.now()
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
      else if (method === 'WebcastGiftMessage') this.onGift(mp)
    }
  }

  /** 去重：msg_id 优先；缺失时按 类型+昵称+内容 在短窗口内去重（多路由重复投递都在同一秒内） */
  private isDup(key: string): boolean {
    const now = Date.now()
    const last = this.seenKeys.get(key)
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) return true
    this.seenKeys.set(key, now)
    if (this.seenKeys.size > 800) {
      for (const [k, t] of this.seenKeys) {
        if (now - t > 120_000) this.seenKeys.delete(k)
      }
      if (this.seenKeys.size > 800) this.seenKeys.clear()
    }
    return false
  }

  private msgIdOf(cm: Map<number, import('./proto-lite').ProtoField[]>): string {
    const common = cm.get(1)?.[0]
    return common ? fstr(decodeFields(common.bytes).get(2)?.[0]) : ''
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
    if (this.isDup(this.msgIdOf(cm) || `c|${nick}|${content}`)) return
    if (!this.gotMsg) {
      this.gotMsg = true
      log('chat', '已收到首条弹幕')
    }
    this.buffer.push({ kind: 'chat', nick, color: colorFor(nick), content })
    this.scheduleFlush()
  }

  /**
   * 礼物弹幕。GiftMessage{ common=1, gift_id=2, repeat_count=5, user=7, gift=16 }；
   * 礼物名在 GiftStruct 内，字段号未完全确认：取第一个短中文字符串字段兜底。
   */
  private onGift(buf: Buffer): void {
    const gm = decodeFields(buf)
    const user = gm.get(7)?.[0]
    if (!user) return
    const u = decodeFields(user.bytes)
    const nick = fstr(u.get(3)?.[0])
    if (!nick) return
    const count = fint(gm.get(5)?.[0]) || 1
    let name = ''
    const gift = gm.get(16)?.[0]
    if (gift) {
      const gf = decodeFields(gift.bytes)
      for (const [no, list] of gf) {
        const f = list[0]
        if (!f || f.wire !== 2) continue
        const s = f.bytes.toString('utf8')
        // 调试留痕：确认礼物名字段号后收紧此启发式
        log('chat', `[gift字段] ${no} = ${s.slice(0, 24)}`)
        if (!name && /^[\u4e00-\u9fa5A-Za-z0-9]{1,12}$/.test(s)) name = s
      }
    }
    const msgId = this.msgIdOf(gm)
    const key = msgId || `g|${nick}|${name}|${count}`
    if (this.isDup(key)) return
    this.buffer.push({
      kind: 'gift',
      nick,
      color: colorFor(nick),
      content: `送出「${name || '礼物'}」×${count}`
    })
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
