/**
 * 公屏弹幕。
 * 主路径：HTTP 长轮询（webcast/im/fetch，fetch_rule=1 握手 + 2 增量，~1.2s/次）——
 *   与官方页面同款传输，无签名要求，研究实测稳定投递全部消息类型；
 *   请求借常驻 guest 页发出（完整 Cookie 环境），全程不导航房间页。
 * 兜底：握手失败时回退 WSS（webcast100-ws-web-{lf,hl}.douyin.com /webcast/im/push/v2/），
 *   signature = frontierSign({X-MS-STUB: md5("")}) 的 X-Bogus；
 *   再兜底借页面进房捕获连接参数。协议细节见 research/douyin-live-protocol.md。
 * 帧为 protobuf（proto-lite 手工解码）；长轮询响应无 gzip 外壳，WSS payload 标 'pb' 实为 gzip。
 * 字段号参照公开的 douyin webcast proto（Response/ChatMessage/User/GiftMessage），
 * 协议漂移时优先核对本文件与 proto-lite.ts。
 */
import WebSocket from 'ws'
import { gunzipSync } from 'node:zlib'
import { IPC } from '@shared/ipc'
import type { ChatItem, ChatEvent } from '@shared/types'
import { decodeFields, encodeBytesField, fint, fstr, type ProtoField } from './proto-lite'
import { GiftAggregator, dumpProtoTree, parseGiftMessage, parseLightGiftMessage, type ParsedGift } from './gift'
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
/** 长轮询间隔：与官方页面一致（响应里的 fetch_interval 实测为 1000ms） */
const POLL_INTERVAL_MS = 1_200
/** 连续轮询失败次数达到该值后重新握手（fetch_rule=1） */
const POLL_ERRORS_BEFORE_REHANDSHAKE = 3
/** 长轮询静默判定：请求一直成功但超过该时长无任何消息下行，视为 IM 会话在服务端已失效 */
const POLL_SILENT_MS = 60_000
/** 重同步（重新握手）后的窗口：本会话见过的消息一律按服务端回放历史丢弃，避免恢复时刷旧弹幕 */
const RESYNC_SUPPRESS_MS = 10_000

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
  /** 本次会话内是否成功建连过（用于失败升级判断） */
  private everOpened = false
  /** 页面捕获模式：自建路径连续失败后升级，本次会话内不再回退自建 */
  private captureMode = false
  /** 调试计数：本次连接收到的帧数（DY_CHAT_DEBUG=1 时输出前 8 帧详情） */
  private frameCount = 0
  /** 服务端在 im/fetch 握手里指派的 WSS 端点（字段 10/14），缺省用 WS_BASE */
  private pushServer = ''
  /** 礼物连击聚合 + 礼物档案缓存（gift.ts） */
  private gifts = new GiftAggregator()
  // ---------- 长轮询传输 ----------
  private pollTimer: NodeJS.Timeout | undefined
  private polling = false
  private pollErrors = 0
  /** 会话代际：start() 递增；在途的轮询/连接完成后发现代际不符即自行退出（防跨 stop/start 污染与双循环） */
  private pollEpoch = 0
  /** 最近一次收到任何消息下行的时间（轮询静默看门狗用；空响应不刷新） */
  private lastMsgAt = 0
  /** 最近一次重同步（重新握手）时刻；其后短暂窗口内已见过的 msg_id 视为服务端回放 */
  private resyncAt = 0
  /** 静默看门狗的用户提示本轮静默期只发一次，恢复收到消息后复位 */
  private silentWarned = false
  /** 服务端最近下发的 fetch_type（传输升级指令观察用，仅记录不切换） */
  private lastFetchType = 0

  constructor(private deps: ChatServiceDeps) {}

  start(ref: { roomId: string; webRid?: string }): void {
    this.stop()
    this.stopped = false
    this.roomId = ref.roomId
    this.webRid = ref.webRid ?? ''
    this.attempts = 0
    this.gotMsg = false
    this.everOpened = false
    this.captureMode = false
    this.pushServer = ''
    this.frameCount = 0
    this.polling = false
    this.pollErrors = 0
    this.pollEpoch++
    this.lastMsgAt = Date.now()
    this.resyncAt = 0
    this.silentWarned = false
    this.lastFetchType = 0
    this.cursor = ''
    this.internalExt = ''
    this.buffer = []
    this.seenKeys = new Map()
    this.gifts.reset()
    log('chat', `开始连接房间 roomId=${this.roomId || '(缺)'} webRid=${this.webRid || '(缺)'}`)
    this.sys('正在连接弹幕…')
    void this.startPolling()
  }

  stop(): void {
    this.stopped = true
    this.polling = false
    clearTimeout(this.pollTimer)
    this.pollTimer = undefined
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
      // 必须用与 guest 会话配套的真实设备 ID（Tea SDK 缓存）；随机数会被服务端静默拒绝路由
      this.webid = (await ses.getGuestWebId()) || String(1_000_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 8_999_999_999_999_999_999)))
      log('chat', '弹幕设备 ID:', this.webid)
    }
    const params: Record<string, string> = {
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
      user_unique_id: this.webid,
      im_path: '/webcast/im/fetch/',
      identity: 'audience',
      need_persist_msg_count: '15',
      insert_task_id: '',
      live_reason: '',
      room_id: this.roomId,
      heartbeatDuration: '0',
      cursor: this.cursor || `t-${Date.now()}`,
      internal_ext: this.internalExt,
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
    // 官方 IM SDK 的序列化器是裸拼接（k=v&k2=v2，不做 URL 编码），保持一致
    let qs = ''
    for (const [k, v] of Object.entries(params)) qs += (qs ? '&' : '') + k + '=' + (v ?? '')
    // 签名输入为 { X-MS-STUB: md5("") }（websocket_key 白名单为空），见 sessions.frontierSign
    const signature = await ses.frontierSign()
    if (!signature) log('chat', '警告：签名为空，连接大概率被拒')
    const base = this.pushServer || WS_BASE
    return `${base}?${qs}&signature=${signature}`
  }

  /**
   * 借页面进房捕获自建 WS 连接参数（导航房间页约 7s，仅在缺 room_id 或自建路径失败时使用）。
   * 捕获的 URL 由页面 SDK 生成（含页面侧签名与游标），roomId 允许从 URL 反解。
   */
  private async captureUrl(): Promise<string> {
    if (!this.webRid) return ''
    const url = await this.deps.sessions.captureRoomWSUrl(this.webRid, this.roomId)
    if (!url) return ''
    log('chat', '已借页面捕获弹幕连接参数')
    const m = /([?&])room_id=(\d+)/.exec(url)
    if (!this.roomId && m) {
      this.roomId = m[2]
      log('chat', '从捕获 URL 解析 room_id:', this.roomId)
    }
    return url
  }

  /** im/fetch 请求 URL（fetch_rule=1 初始握手 / 2 增量续传；响应为 protobuf，无签名要求） */
  private imFetchUrl(fetchRule: 1 | 2): string {
    const params = new URLSearchParams({
      resp_content_type: 'protobuf',
      did_rule: '3',
      device_id: '',
      app_name: 'douyin_web',
      endpoint: 'live_pc',
      support_wrds: '1',
      user_unique_id: this.webid,
      identity: 'audience',
      need_persist_msg_count: '15',
      insert_task_id: '',
      live_reason: '',
      room_id: this.roomId,
      version_code: '180800',
      last_rtt: fetchRule === 1 ? '0' : '1100',
      live_id: '1',
      aid: '6383',
      fetch_rule: String(fetchRule),
      cursor: fetchRule === 1 ? '' : this.cursor,
      internal_ext: fetchRule === 1 ? '' : this.internalExt,
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
      tz_name: 'Asia/Shanghai'
    })
    return `https://live.douyin.com/webcast/im/fetch/?${params.toString()}`
  }

  /**
   * WSS 会话握手：借 guest 页做一次 im/fetch（fetch_rule=1），取服务端签发的
   * cursor/internal_ext（内含 wss_push_room_id/wss_push_did 绑定）与 push_server 端点。
   * 跳过此握手直接建连：服务端接受连接但不路由房间消息（实测只回心跳）。
   * 注意：游客会话不投递礼物消息（实测，见 research/douyin-live-protocol.md §5.2），
   * 弹幕保持游客身份即收不到礼物行——如需礼物展示，把这里的页面换成
   * 「persist:douyin 会话加载 live.douyin.com 的隐藏页」（登录态），gift.ts 解析层已就绪。
   */
  private async fetchImSession(): Promise<void> {
    const ses = this.deps.sessions
    const wc = await ses.ensureGuest()
    const res = await ses.pageFetchBinary(wc, this.imFetchUrl(1))
    if (res.status !== 200 || !res.body.length) {
      throw new Error(`HTTP ${res.status} len=${res.body.length} ${res.err ?? ''}`)
    }
    const resp = decodeFields(res.body)
    // Response{ messages=1, cursor=2, fetch_interval=3, now=4, internal_ext=5, push_server=10/14 }
    const cursor = fstr(resp.get(2)?.[0])
    const ext = fstr(resp.get(5)?.[0])
    const push = fstr(resp.get(10)?.[0]) || fstr(resp.get(14)?.[0])
    if (cursor) this.cursor = cursor
    if (ext) this.internalExt = ext
    if (/^wss:\/\//.test(push)) this.pushServer = push
    log('chat', `im/fetch 握手完成 cursor=${(cursor || '(空)').slice(0, 48)} ext=${ext ? '有' : '无'} push=${push || '(默认)'}`)
  }

  // ---------- 长轮询传输（主路径，与官方页面同款） ----------

  /**
   * 长轮询主路径：借 guest 页每 ~1.2s 拉一次增量消息。
   * 研究实测该通道无签名要求、稳定投递全部消息类型（WSS 直连在本环境被服务端静默不路由）。
   */
  private async startPolling(): Promise<void> {
    const epoch = this.pollEpoch
    this.polling = true
    try {
      await this.fetchImSession()
    } catch (e) {
      if (this.stopped || epoch !== this.pollEpoch) return
      log('chat', '长轮询握手失败，回退 WebSocket:', (e as Error)?.message)
      this.polling = false
      return this.connect()
    }
    // 握手期间可能已被 stop()/start() 更代：旧会话的收尾到此为止
    if (this.stopped || epoch !== this.pollEpoch) return
    this.attempts = 0
    this.pollErrors = 0
    this.sys('弹幕连接已建立')
    void this.pollOnce()
  }

  private async pollOnce(): Promise<void> {
    const epoch = this.pollEpoch
    if (this.stopped || !this.polling || epoch !== this.pollEpoch) return
    const t0 = Date.now()
    try {
      // 静默看门狗：HTTP 一直成功但长时间没有任何消息下行，多为 IM 会话在服务端已失效
      // （cursor 过期、guest 页重建后绑定失效、网络切换/睡眠恢复）——此时 pollErrors 恒为 0，
      // 只能靠主动重握手自愈，否则列表永久静默冻结
      if (Date.now() - this.lastMsgAt > POLL_SILENT_MS) {
        if (!this.silentWarned) {
          this.silentWarned = true
          this.sys('弹幕长时间无消息，正在重新同步…')
        }
        log('chat', '看门狗：轮询静默超时，重新握手同步')
        this.cursor = ''
        this.internalExt = ''
        await this.fetchImSession()
        // 重握手本身证明通道存活：重置静默计时（真安静房间最多每 60s 重同步一次）
        this.lastMsgAt = Date.now()
        this.resyncAt = Date.now()
      }
      const ses = this.deps.sessions
      const wc = await ses.ensureGuest()
      const res = await ses.pageFetchBinary(wc, this.imFetchUrl(2))
      if (res.status !== 200 || !res.body.length) {
        throw new Error(`HTTP ${res.status} len=${res.body.length}`)
      }
      this.handleImResponse(res.body)
      this.pollErrors = 0
    } catch (e) {
      if (this.stopped || !this.polling || epoch !== this.pollEpoch) return
      this.pollErrors++
      log('chat', `轮询失败（第 ${this.pollErrors} 次）:`, (e as Error)?.message)
      if (this.pollErrors === POLL_ERRORS_BEFORE_REHANDSHAKE) {
        this.sys('弹幕连接不稳定，正在尝试恢复…')
      }
      if (this.pollErrors >= POLL_ERRORS_BEFORE_REHANDSHAKE) {
        try {
          this.cursor = ''
          this.internalExt = ''
          await this.fetchImSession()
          this.pollErrors = 0
          this.lastMsgAt = Date.now()
          this.resyncAt = Date.now()
          this.sys('弹幕连接已恢复')
        } catch (e2) {
          log('chat', '重新握手失败:', (e2 as Error)?.message)
        }
      }
    }
    if (this.stopped || !this.polling || epoch !== this.pollEpoch) return
    const wait = Math.max(300, POLL_INTERVAL_MS - (Date.now() - t0))
    this.pollTimer = setTimeout(() => void this.pollOnce(), wait)
  }

  /** 解析 im/fetch 响应（protobuf Response，无 PushFrame/gzip 外壳）并分发 */
  private handleImResponse(buf: Buffer): void {
    const resp = decodeFields(buf)
    const cursor = fstr(resp.get(2)?.[0])
    if (cursor) this.cursor = cursor
    const ext = fstr(resp.get(5)?.[0])
    if (ext) this.internalExt = ext
    // fetch_type：服务端指挥客户端升级传输的信号（1=Socket，附 push_server）。
    // 出现即说明服务端期望换通道，可能与「轮询 200 但无消息」相关——先留日志观察，不据此切换
    const fetchType = fint(resp.get(6)?.[0])
    if (fetchType !== 0 && fetchType !== this.lastFetchType) {
      this.lastFetchType = fetchType
      log('chat', `服务端下发 fetch_type=${fetchType}（观察：若此后消息中断，需处理传输升级）`)
    }
    this.dispatchMessages(resp)
  }

  /** 遍历 Response.messages 并分发（长轮询与 WSS 帧共用） */
  private dispatchMessages(resp: Map<number, ProtoField[]>): void {
    const messages = resp.get(1) ?? []
    // 只要有任何消息下行（含本应用未处理的类型）即证明会话存活
    if (messages.length) {
      this.lastMsgAt = Date.now()
      this.silentWarned = false
    }
    for (const m of messages) {
      const msg = decodeFields(m.bytes)
      const method = fstr(msg.get(1)?.[0])
      const mp = msg.get(2)?.[0]?.bytes
      if (!method || !mp) continue
      if (method === 'WebcastChatMessage') this.onChat(mp)
      else if (method === 'WebcastGiftMessage') this.onGift(mp)
      // 轻礼物消息类型（实测登录会话下轻礼物多走普通 GiftMessage，此通道备用兼容）
      else if (method === 'WebcastLightGiftMessage') this.onLightGift(mp)
      // 表情聊天：电台房的小心心等互动走此通道，显示为普通弹幕
      else if (method === 'WebcastEmojiChatMessage') this.onEmojiChat(mp)
      else this.diagMethod(method, mp)
    }
  }

  /**
   * 诊断：DY_CHAT_DEBUG=1 时，每种未处理消息类型首次出现时记录名称；
   * 方法名含 Gift 的消息完整 dump 字段树（协议漂移/新礼物通道定位用）。
   */
  private diagMethods = new Set<string>()
  private diagMethod(method: string, mp: Buffer): void {
    if (!process.env.DY_CHAT_DEBUG) return
    if (/gift/i.test(method)) {
      log('chat', `[debug] ${method} (${mp.length}B) 字段树:`)
      log('chat', dumpProtoTree(mp))
    } else if (!this.diagMethods.has(method)) {
      this.diagMethods.add(method)
      log('chat', `[debug] 未处理消息类型: ${method}`)
    }
  }

  private async connect(): Promise<void> {
    const epoch = this.pollEpoch
    try {
      // 主路径：纯算法构造 URL（签名借常驻 guest 页计算，全程不导航房间页，切房/重连秒级）
      let url = ''
      let captureTried = false
      if (this.captureMode) {
        captureTried = true
        url = await this.captureUrl()
      }
      if (!url && this.roomId) {
        // WSS 会话绑定在 im/fetch 握手上：先取服务端签发的 cursor/internal_ext 再建连
        if (!this.cursor) {
          try {
            await this.fetchImSession()
          } catch (e) {
            log('chat', 'im/fetch 握手失败，降级直连:', (e as Error)?.message)
          }
        }
        url = await this.buildUrl()
        if (url) log('chat', '使用自建弹幕连接参数')
      }
      // 兜底1：仅知 webRid 缺 room_id（热门房间）→ 借页面进房一次，顺带解析真实 room_id
      if (!url && this.webRid && !captureTried) {
        url = await this.captureUrl()
        // 捕获只是为了补 room_id：拿到后回到自建模式，重连不再导航页面
        if (url && this.roomId) this.captureMode = false
      }
      if (!url) {
        log('chat', '连接参数缺失，最后尝试自建 URL')
        url = await this.buildUrl()
      }
      // WS 升级请求必须带浏览器同款头：Cookie(ttwid 等) 缺失会被风控拒（回 200 而非 101）
      const cookie = await this.deps.sessions.getGuestCookieHeader()
      const ua = this.deps.sessions.getUserAgent()
      // 参数收集期间会话可能已被 stop()/start() 更代：丢弃本次连接，防旧 WS 覆盖新会话
      if (this.stopped || epoch !== this.pollEpoch) return
      const ws = new WebSocket(url, {
        headers: {
          Cookie: cookie,
          'User-Agent': ua,
          Origin: 'https://live.douyin.com'
        }
      })
      this.ws = ws
      ws.on('open', () => {
        if (this.stopped || epoch !== this.pollEpoch) {
          try {
            ws.close()
          } catch {}
          return
        }
        log('chat', '弹幕服务已连接', this.roomId)
        this.attempts = 0
        this.everOpened = true
        this.frameCount = 0
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
      ws.on('close', () => {
        // 旧会话的连接关闭不得触发新会话的重连调度
        if (!this.stopped && epoch === this.pollEpoch) this.scheduleReconnect('closed')
      })
    } catch (e) {
      log('chat', '连接失败:', (e as Error)?.message)
      if (!this.stopped && epoch === this.pollEpoch) this.scheduleReconnect('error')
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return
    clearInterval(this.hbTimer)
    clearInterval(this.livenessTimer)
    this.attempts++
    // 自建路径连续失败且从未建连成功 → 升级为页面捕获模式（本次会话内保持）
    if (!this.everOpened && !this.captureMode && this.attempts >= 2 && this.webRid) {
      this.captureMode = true
      log('chat', '自建连接连续失败，切换为页面捕获模式')
      this.sys('自建连接受阻，切换页面捕获模式…')
    }
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

  /**
   * 表情聊天。EmojiChatMessage{ common=1, emoji_id=2, user=3, emoji_content=4 }（字段号待实测校准）。
   * 内容缺省时以 emoji_id 占位展示。
   */
  private onEmojiChat(buf: Buffer): void {
    const em = decodeFields(buf)
    const user = em.get(3)?.[0]
    if (!user) return
    const u = decodeFields(user.bytes)
    const nick = fstr(u.get(3)?.[0])
    if (!nick) return
    let content = fstr(em.get(4)?.[0])
    if (!content) {
      const eid = fstr(em.get(2)?.[0])
      if (!eid) return
      content = `[表情:${eid.slice(0, 12)}]`
    }
    const msgId = this.msgIdOf(em)
    if (this.isDup(msgId || `e|${nick}|${content}`)) return
    this.buffer.push({ kind: 'chat', nick, color: colorFor(nick), content })
    this.scheduleFlush()
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
    if (process.env.DY_CHAT_DEBUG) {
      this.frameCount++
      if (this.frameCount <= 3) {
        log('chat', `[debug] 帧#${this.frameCount} hex=${data.toString('hex').slice(0, 180)}`)
      } else if (this.frameCount <= 8) {
        log('chat', `[debug] 帧#${this.frameCount} payload_type=${payloadType || '(空)'} payload=${payload?.length ?? 0}B`)
      }
    }
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
    // Response{ messages=1, cursor=2, fetch_interval=3, now=4, internal_ext=5, fetch_type=6, ... }
    // （此前误读 6 为 internal_ext——6 实为 fetch_type；cursor 单独即可续传，5 为空不影响）
    const cursor = fstr(resp.get(2)?.[0])
    if (cursor) this.cursor = cursor
    const ext = fstr(resp.get(5)?.[0])
    if (ext) this.internalExt = ext
    const messages = resp.get(1) ?? []
    if (process.env.DY_CHAT_DEBUG && this.frameCount <= 8) {
      const methods = messages
        .map((m) => fstr(decodeFields(m.bytes).get(1)?.[0]))
        .filter(Boolean)
        .slice(0, 6)
      log('chat', `[debug] 帧#${this.frameCount} 解出 ${messages.length} 条: ${methods.join(', ') || '(空)'}`)
    }
    this.dispatchMessages(resp)
  }

  /** 去重：msg_id 优先；缺失时按 类型+昵称+内容 在短窗口内去重（多路由重复投递都在同一秒内） */
  private isDup(key: string): boolean {
    const now = Date.now()
    const last = this.seenKeys.get(key)
    // 重同步窗口内：本会话见过的 key 不论多久之前都按服务端回放的历史丢弃
    if (last !== undefined && (now - last < DEDUP_WINDOW_MS || now - this.resyncAt < RESYNC_SUPPRESS_MS)) {
      return true
    }
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
   * 礼物弹幕。字段标定与连击聚合见 gift.ts（公开 proto 三源交叉验证 + 实测抓包）。
   * 连击帧由 GiftAggregator 合并为同 key 行，渲染层原位更新计数；
   * 设置 DY_CHAT_DEBUG=1 可输出解析详情（用于协议漂移时重新校准）。
   */
  private onGift(buf: Buffer): void {
    this.emitGift(parseGiftMessage(buf))
  }

  /** 轻礼物（WebcastLightGiftMessage）：匿名，无发送者信息（gift.ts 有字段标定） */
  private onLightGift(buf: Buffer): void {
    this.emitGift(parseLightGiftMessage(buf))
  }

  private emitGift(parsed: ParsedGift | null): void {
    if (!parsed) return
    if (process.env.DY_CHAT_DEBUG) {
      log(
        'chat',
        `[debug] Gift: gift_id=${parsed.giftId} name='${parsed.name}' diamond=${parsed.diamond} ` +
          `count=${parsed.repeatCount} end=${parsed.repeatEnd ? 1 : 0} group=${parsed.groupId || '-'} ` +
          `user='${parsed.nick || '(匿名)'}' msg_id='${parsed.msgId || '-'}' icon=${parsed.icon ? '有' : '无'}`
      )
    }
    const msgId = parsed.msgId
    const key = msgId || `g|${parsed.uid || parsed.nick}|${parsed.giftId}|${parsed.groupId}|${parsed.repeatCount}`
    if (this.isDup(key)) return
    const agg = this.gifts.consume(parsed)
    if (!agg) return
    this.buffer.push({
      kind: 'gift',
      nick: agg.nick,
      color: colorFor(agg.nick),
      content: agg.nick ? `送出「${agg.name}」×${agg.count}` : `轻礼物「${agg.name}」×${agg.count}`,
      gift: {
        key: agg.key,
        name: agg.name,
        count: agg.count,
        icon: agg.icon || undefined,
        avatar: agg.avatar || undefined,
        diamond: agg.diamond || undefined
      }
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
