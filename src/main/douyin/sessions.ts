import { app, BrowserWindow, session, type Session, type WebContents } from 'electron'
import { appendFile as fsAppend } from 'node:fs/promises'
import { join } from 'node:path'
import { sleep, withTimeout, log } from '../util'

/** 清理 UA 中的 Electron/App 痕迹，降低风控特征 */
export function cleanUserAgent(ua: string): string {
  const appName = app.getName()
  return ua
    .split(' ')
    .filter((t) => !/^Electron\//i.test(t) && !(appName && t.toLowerCase().startsWith(appName.toLowerCase() + '/')))
    .join(' ')
    .trim()
}

export interface PageFetchResult {
  ok: boolean
  status: number
  body: string
  err?: string
  ms: number
}

/**
 * 在页面上下文执行的 fetch：携带页面自身的 Cookie 与环境（签名由页面内 SDK 计算）。
 * sign=true 时尝试用页面内的 window._webmsxyw 生成 a_bogus / X-Bogus。
 */
async function __pageFetch(url: string, sign: boolean): Promise<PageFetchResult> {
  let target = url
  try {
    if (sign) {
      const m = /(?:^|;\s*)msToken=([^;]+)/.exec(document.cookie)
      if (m && m[1]) target += (target.indexOf('?') >= 0 ? '&' : '?') + 'msToken=' + encodeURIComponent(m[1])
      if (typeof (window as any)._webmsxyw === 'function') {
        const r = await (window as any)._webmsxyw(target)
        let p = ''
        if (typeof r === 'string' && r.length > 8) {
          p = 'a_bogus=' + encodeURIComponent(r)
        } else if (r && typeof r === 'object') {
          const v = r['X-Bogus'] || r.a_bogus || r['a_bogus']
          if (typeof v === 'string' && v.length > 4) p = (r['X-Bogus'] ? 'X-Bogus' : 'a_bogus') + '=' + encodeURIComponent(v)
        }
        if (p) target += (target.indexOf('?') >= 0 ? '&' : '?') + p
      }
    }
  } catch (e) {}
  const t0 = Date.now()
  try {
    const resp = await fetch(target, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json, text/plain, */*' }
    })
    const body = await resp.text()
    return { ok: resp.ok, status: resp.status, body: body.slice(0, 2_000_000), ms: Date.now() - t0 }
  } catch (err: any) {
    return { ok: false, status: 0, body: '', err: String(err?.message ?? err), ms: Date.now() - t0 }
  }
}

/**
 * 在页面上下文执行的二进制 fetch：返回 base64（protobuf 接口用，避免 text 编码损伤字节）。
 * 页内自带 AbortController 超时：网络假死时快速失败（主进程 EXEC_TIMEOUT 25s 只作外层兜底）。
 */
async function __pageFetchBinary(url: string, timeoutMs = 10_000): Promise<{ status: number; b64: string; err?: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json, text/plain, */*' },
      signal: ctl.signal
    })
    const buf = new Uint8Array(await resp.arrayBuffer())
    let bin = ''
    const CH = 0x8000
    for (let i = 0; i < buf.length; i += CH) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH) as unknown as number[])
    }
    return { status: resp.status, b64: btoa(bin) }
  } catch (err: any) {
    return { status: 0, b64: '', err: String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 抖音会话管理：
 * - persist:douyin：登录态会话（登录 webview + 隐藏 www 页，用于关注列表等需登录接口）
 * - guest：未登录会话（隐藏 live.douyin.com 页，以游客身份加载直播间，与登录态完全隔离）
 */
export class DouyinSessions {
  private _authSession: Session | null = null
  private _guestSession: Session | null = null

  get authSession(): Session {
    this._authSession ||= session.fromPartition('persist:douyin')
    return this._authSession
  }

  get guestSession(): Session {
    this._guestSession ||= session.fromPartition('guest')
    return this._guestSession
  }

  private wwwWin: BrowserWindow | null = null
  private guestWin: BrowserWindow | null = null
  private wwwReady = false
  private wwwSignReady = false
  private guestReady = false
  private wwwPromise: Promise<WebContents> | null = null
  private guestPromise: Promise<WebContents> | null = null
  private lastWwwUse = 0
  private lastGuestUse = 0
  private idleTimer: ReturnType<typeof setInterval> | undefined
  private authChange?: (loggedIn: boolean) => void
  private authEvaluateTimer: ReturnType<typeof setTimeout> | undefined
  private loggedIn = false
  private ua = ''
  /** 调试：捕获页面自建的 douyin wss 连接 URL（弹幕参数对照用） */
  private capturedWS: string[] = []

  init(onAuthChange: (loggedIn: boolean) => void): void {
    this.authChange = onAuthChange
    const ua = cleanUserAgent(app.userAgentFallback || '')
    this.ua = ua
    app.userAgentFallback = ua
    for (const [tag, ses] of [
      ['default', session.defaultSession],
      ['auth', this.authSession],
      ['guest', this.guestSession]
    ] as const) {
      ses.setUserAgent(ua)
      try {
        ses.setSpellCheckerEnabled(false)
      } catch {}
      // 页面内的外部协议唤起（douyin 页会尝试 bitbrowser:// 等唤端链接）一律静默拒绝，
      // 否则 Electron 交给系统处理，Windows 会弹"没有可打开此链接的应用"
      ses.setPermissionRequestHandler((wc, permission, callback, details) => {
        if (permission === 'openExternal') {
          const url = 'externalURL' in details ? details.externalURL : details?.requestingUrl
          log('sessions', `[${tag}] 已拦截外部协议唤起:`, String(url ?? '').slice(0, 160))
          try {
            // 主进程 stdout 在部分启动方式下不可见，追加文件留痕便于排查
            fsAppend(
              join(app.getPath('userData'), 'blocked-protocols.log'),
              `${new Date().toISOString()} [${tag}] ${String(url ?? '')}\n`
            )
          } catch {}
          callback(false)
          return
        }
        callback(true)
      })
    }
    // 隐藏窗口不加载媒体/字体，节省资源；顺带捕获页面自建的 douyin 弹幕 WS 连接
    for (const ses of [this.authSession, this.guestSession]) {
      ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'wss://*/*'] }, (details, cb) => {
        const t = details.resourceType
        if (t === 'webSocket' && details.url.includes('douyin.com')) {
          this.capturedWS.push(details.url)
          if (this.capturedWS.length > 8) this.capturedWS.shift()
        }
        cb(t === 'media' || t === 'font' ? ({ cancel: true } as any) : ({} as any))
      })
    }
    this.authSession.cookies.on('changed', (_e, cookie) => {
      if (cookie.domain && cookie.domain.includes('douyin')) this.scheduleAuthEvaluate()
    })
    this.scheduleAuthEvaluate(100)
    // 空闲时轮换隐藏页面（www / guest 各自独立计时），防止长驻页面内存增长
    this.idleTimer = setInterval(() => this.recycleIdlePages(), 5 * 60_000)
  }

  isLoggedIn(): boolean {
    return this.loggedIn
  }

  private scheduleAuthEvaluate(delay = 700): void {
    clearTimeout(this.authEvaluateTimer)
    this.authEvaluateTimer = setTimeout(() => void this.evaluateAuth(), delay)
  }

  private async evaluateAuth(): Promise<void> {
    let ok = false
    try {
      const cookies = await this.authSession.cookies.get({ domain: '.douyin.com' })
      ok = cookies.some((c) => c.name === 'sessionid' && !!c.value)
    } catch {}
    if (ok !== this.loggedIn) {
      this.loggedIn = ok
      this.authChange?.(ok)
    }
  }

  // ---------- 隐藏 www 页（登录态，签名接口） ----------

  async ensureWww(needSign = true): Promise<WebContents> {
    const wc = await this.ensureWwwPage()
    // 免签接口（如关注直播 feed）不必等签名函数：隐藏页加载完即可发请求
    if (needSign && !this.wwwSignReady) {
      // 尽力等待页面签名函数就绪（超时则降级为无签名请求，由上层错误提示兜底）
      await withTimeout(this.waitSignFn(wc), 9000, 'sign-timeout').catch(() => undefined)
      this.wwwSignReady = true
    }
    return wc
  }

  private ensureWwwPage(): Promise<WebContents> {
    if (this.wwwWin && !this.wwwWin.isDestroyed() && this.wwwReady) return Promise.resolve(this.wwwWin.webContents)
    this.wwwPromise ||= this.createHiddenPage('www', 'persist:douyin', 'https://www.douyin.com/').then((wc) => {
      this.wwwReady = true
      return wc
    })
    return this.wwwPromise
  }

  private async waitSignFn(wc: WebContents): Promise<WebContents> {
    for (let i = 0; i < 14; i++) {
      if (wc.isDestroyed()) return wc
      const t = await wc.executeJavaScript('typeof window._webmsxyw').catch(() => 'undefined')
      if (t === 'function') break
      await sleep(600)
    }
    return wc
  }

  async reloadWww(): Promise<void> {
    if (this.wwwWin && !this.wwwWin.isDestroyed()) {
      this.wwwReady = false
      this.wwwSignReady = false
      try {
        this.wwwWin.destroy()
      } catch {}
      this.wwwWin = null
    }
    await this.ensureWww().catch(() => undefined)
  }

  private recycleIdlePages(): void {
    const now = Date.now()
    const idle = 10 * 60_000
    if (this.wwwWin && !this.wwwWin.isDestroyed() && now - this.lastWwwUse > idle) {
      this.wwwReady = false
      try {
        this.wwwWin.destroy()
      } catch {}
      this.wwwWin = null
      log('sessions', '空闲回收 www 隐藏页')
    }
    if (this.guestWin && !this.guestWin.isDestroyed() && now - this.lastGuestUse > idle) {
      this.guestReady = false
      try {
        this.guestWin.destroy()
      } catch {}
      this.guestWin = null
      log('sessions', '空闲回收 guest 隐藏页')
    }
  }

  // ---------- 隐藏 guest 页（游客态，直播 webcast 接口） ----------

  /** 读取 guest 会话下 douyin 域的指定 Cookie */
  async getGuestCookie(name: string): Promise<string> {
    try {
      const cookies = await this.guestSession.cookies.get({ domain: 'douyin.com' })
      return cookies.find((c) => c.name === name)?.value ?? ''
    } catch {
      return ''
    }
  }

  /** guest 会话 douyin Cookie 的请求头形态（WS 升级请求需要带 ttwid 等） */
  async getGuestCookieHeader(): Promise<string> {
    try {
      const cookies = await this.guestSession.cookies.get({ domain: 'douyin.com' })
      return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    } catch {
      return ''
    }
  }

  /**
   * 读取 guest 页 Tea SDK 缓存的设备 ID——页面自建 WS/接口所用 user_unique_id 与其同源
   * （localStorage.__tea_cache_tokens_6383 = { web_id, user_unique_id }）。
   * 用随机数会被服务端静默拒绝路由（握手成功但不下发房间消息）。
   */
  async getGuestWebId(): Promise<string> {
    const expr = `(() => {
      try {
        const raw = localStorage.getItem('__tea_cache_tokens_6383')
        if (raw) {
          const t = JSON.parse(raw)
          if (t && typeof t.user_unique_id === 'string' && /^\\d{15,20}$/.test(t.user_unique_id)) return t.user_unique_id
          if (t && typeof t.web_id === 'string' && /^\\d{15,20}$/.test(t.web_id)) return t.web_id
        }
      } catch (e) {}
      return ''
    })()`
    for (let i = 0; i < 3; i++) {
      try {
        const wc = await this.ensureGuest()
        const id = (await wc.executeJavaScript(expr, false)) as unknown
        if (typeof id === 'string' && id) return id
      } catch {}
      await sleep(800) // Tea 缓存可能在页面加载完成后稍晚写入
    }
    return this.getGuestCookie('webid')
  }

  getUserAgent(): string {
    return this.ua
  }

  getCapturedWS(): string[] {
    return this.capturedWS
  }

  /**
   * 借 guest 页进一次直播间，捕获页面自建的弹幕 WS 连接 URL（含合法签名与游标），
   * 然后页面回到首页（页面自己的连接断开，不影响调用方用捕获的 URL 建连）。
   */
  async captureRoomWSUrl(webRid: string, roomId: string): Promise<string> {
    try {
      const wc = await this.ensureGuest()
      await wc.loadURL(`https://live.douyin.com/${webRid}`)
      await sleep(7_000)
      await wc.loadURL('https://live.douyin.com/').catch(() => undefined)
      const hit = this.capturedWS
        .filter((u) => u.includes('/webcast/im/push/v2/') && u.includes(`room_id=${roomId}`))
        .pop()
      return hit ?? ''
    } catch (e) {
      log('chat', '捕获弹幕连接参数失败:', (e as Error)?.message)
      return ''
    }
  }

  /** guest 页是否具备 byted_acrawler 签名能力 */
  async hasSigner(): Promise<boolean> {
    try {
      const wc = await this.ensureGuest()
      return await wc.executeJavaScript(
        `!!(window.byted_acrawler && typeof window.byted_acrawler.frontierSign === 'function')`,
        false
      )
    } catch {
      return false
    }
  }

  /**
   * 在 guest 页面上下文调用抖音 frontierSign（IM 弹幕 WS 的 signature 参数）。
   * 逆向结论（详见 research/douyin-live-protocol.md）：IM SDK 的签名输入不是查询串，
   * 而是 { X-MS-STUB: md5(签名参数白名单逗号串) }；web 端 websocket_key 白名单为空数组，
   * 故 stub 恒为 md5("") = d41d8cd98f00b204e9800998ecf8427e，返回值取 X-Bogus。
   */
  async frontierSign(): Promise<string> {
    const MD5_EMPTY = 'd41d8cd98f00b204e9800998ecf8427e'
    try {
      const wc = await this.ensureGuest()
      const expr = `(() => {
        const ba = window.byted_acrawler
        if (!ba || typeof ba.frontierSign !== 'function') return { __missing: true }
        try {
          return ba.frontierSign({ 'X-MS-STUB': ${JSON.stringify(MD5_EMPTY)} })
        } catch (e) {
          return { __error: String(e) }
        }
      })()`
      const r = (await wc.executeJavaScript(expr, false)) as unknown
      if (r && typeof r === 'object' && '__missing' in (r as Record<string, unknown>)) {
        log('chat', 'guest 页无 byted_acrawler（页面未加载 webmssdk）')
        return ''
      }
      if (r && typeof r === 'object' && '__error' in (r as Record<string, unknown>)) {
        log('chat', 'frontierSign 执行异常:', String((r as Record<string, unknown>).__error))
        return ''
      }
      let sig = ''
      if (typeof r === 'string') sig = r
      else if (r && typeof r === 'object') {
        const o = r as Record<string, unknown>
        for (const key of ['X-Bogus', 'signature']) {
          if (typeof o[key] === 'string') {
            sig = o[key] as string
            break
          }
        }
        if (!sig) {
          const v = Object.values(o).find((x) => typeof x === 'string' && (x as string).length > 8)
          sig = typeof v === 'string' ? v : ''
        }
      }
      return sig
    } catch (e) {
      log('chat', 'frontierSign 执行失败:', (e as Error)?.message)
      return ''
    }
  }

  async ensureGuest(): Promise<WebContents> {
    if (this.guestWin && !this.guestWin.isDestroyed() && this.guestReady) return this.guestWin.webContents
    this.guestPromise ||= this.createHiddenPage('guest', 'guest', 'https://live.douyin.com/')
      .then(async (wc) => {
        await sleep(1200) // 等待 ttwid 等 Cookie 写入并稳定
        this.guestReady = true
        return wc
      })
      .finally(() => {
        this.guestPromise = null
      })
    return this.guestPromise
  }

  private async createHiddenPage(tag: string, partition: string, url: string): Promise<WebContents> {
    const existing = tag === 'www' ? this.wwwWin : this.guestWin
    if (existing && !existing.isDestroyed()) existing.destroy()

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    if (tag === 'www') this.wwwWin = win
    else this.guestWin = win
    // 隐藏页面只用于取数，必须静音：抖音首页/直播页会自动播放视频与直播流，
    // 否则后台会漏出干扰声音（MSE/WebAudio 不走 media 资源类型，仅拦请求拦不住）
    const mute = (): void => {
      try {
        win.webContents.setAudioMuted(true)
      } catch {}
    }
    mute()
    win.webContents.on('did-navigate', mute)
    const markUnready = () => {
      if (tag === 'www') this.wwwReady = false
      else this.guestReady = false
    }
    win.webContents.on('render-process-gone', markUnready)
    await this.loadReady(win, url)
    return win.webContents
  }

  private loadReady(win: BrowserWindow, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`GUEST_INIT_FAILED:${url} 加载超时`))
      }, 45_000)
      const cleanup = () => {
        clearTimeout(timeout)
        win.webContents.removeListener('did-finish-load', onLoad)
        win.webContents.removeListener('did-fail-load', onFail)
      }
      const onLoad = () => {
        cleanup()
        resolve()
      }
      const onFail = (_e: unknown, code: number, desc: string, _u: string, isMain: boolean) => {
        if (isMain && code !== -3) {
          cleanup()
          reject(new Error(`GUEST_INIT_FAILED:加载失败 ${code} ${desc}`))
        }
      }
      win.webContents.once('did-finish-load', onLoad)
      win.webContents.on('did-fail-load', onFail)
      win.loadURL(url).catch((e: unknown) => {
        cleanup()
        reject(new Error(`GUEST_INIT_FAILED:${String((e as Error)?.message ?? e)}`))
      })
    })
  }

  /** 二进制形态的页面内 fetch（base64 传输），供 protobuf 接口（im/fetch 握手）使用 */
  async pageFetchBinary(wc: WebContents, url: string): Promise<{ status: number; body: Buffer; err?: string }> {
    if (wc === this.guestWin?.webContents) this.lastGuestUse = Date.now()
    if (wc.isDestroyed()) {
      if (wc === this.guestWin?.webContents) this.guestReady = false
      throw new Error('PAGE_DEAD')
    }
    const expr = `(${__pageFetchBinary.toString()})(${JSON.stringify(url)})`
    try {
      const res = (await withTimeout(wc.executeJavaScript(expr, false) as Promise<{ status: number; b64: string; err?: string }>, 25_000, 'EXEC_TIMEOUT')) as {
        status: number
        b64: string
        err?: string
      }
      return { status: res.status, body: Buffer.from(res.b64 || '', 'base64'), err: res.err }
    } catch (e) {
      if (wc === this.guestWin?.webContents) this.guestReady = false
      throw new Error(`PAGE_EXEC_FAILED:${String((e as Error)?.message ?? e)}`)
    }
  }

  // ---------- 页面内 fetch ----------

  async pageFetch(wc: WebContents, url: string, sign: boolean): Promise<PageFetchResult> {
    // 各页面独立计时：游客页的轮询不应为 www 页"续命"，反之亦然
    if (wc === this.wwwWin?.webContents) this.lastWwwUse = Date.now()
    else if (wc === this.guestWin?.webContents) this.lastGuestUse = Date.now()
    if (wc.isDestroyed()) {
      if (wc === this.wwwWin?.webContents) this.wwwReady = false
      if (wc === this.guestWin?.webContents) this.guestReady = false
      throw new Error('PAGE_DEAD')
    }
    const expr = `(${__pageFetch.toString()})(${JSON.stringify(url)}, ${sign ? 'true' : 'false'})`
    try {
      const res = await withTimeout(wc.executeJavaScript(expr, false) as Promise<PageFetchResult>, 25_000, 'EXEC_TIMEOUT')
      return res
    } catch (e) {
      // 页面执行失败时标记不可用，下次 ensure 重建
      if (wc === this.wwwWin?.webContents) this.wwwReady = false
      if (wc === this.guestWin?.webContents) this.guestReady = false
      throw new Error(`PAGE_EXEC_FAILED:${String((e as Error)?.message ?? e)}`)
    }
  }

  // ---------- 登出 ----------

  async logout(): Promise<void> {
    try {
      await this.authSession.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'shadercache', 'websql']
      })
    } catch (e) {
      console.warn('[sessions] 登出清理失败:', e)
    }
    if (this.wwwWin && !this.wwwWin.isDestroyed()) {
      this.wwwReady = false
      try {
        this.wwwWin.destroy()
      } catch {}
      this.wwwWin = null
    }
    if (this.loggedIn) {
      this.loggedIn = false
      this.authChange?.(false)
    }
  }

  destroy(): void {
    clearInterval(this.idleTimer)
    clearTimeout(this.authEvaluateTimer)
    for (const w of [this.wwwWin, this.guestWin]) {
      if (w && !w.isDestroyed()) {
        try {
          w.destroy()
        } catch {}
      }
    }
    this.wwwWin = null
    this.guestWin = null
  }
}
