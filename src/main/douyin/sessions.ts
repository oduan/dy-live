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
  private guestReady = false
  private wwwPromise: Promise<WebContents> | null = null
  private guestPromise: Promise<WebContents> | null = null
  private lastWwwUse = 0
  private lastGuestUse = 0
  private idleTimer: ReturnType<typeof setInterval> | undefined
  private authChange?: (loggedIn: boolean) => void
  private authEvaluateTimer: ReturnType<typeof setTimeout> | undefined
  private loggedIn = false

  init(onAuthChange: (loggedIn: boolean) => void): void {
    this.authChange = onAuthChange
    const ua = cleanUserAgent(app.userAgentFallback || '')
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
    // 隐藏窗口不加载媒体/字体，节省资源
    for (const ses of [this.authSession, this.guestSession]) {
      ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
        const t = details.resourceType
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

  async ensureWww(): Promise<WebContents> {
    if (this.wwwWin && !this.wwwWin.isDestroyed() && this.wwwReady) return this.wwwWin.webContents
    this.wwwPromise ||= this.createHiddenPage('www', 'persist:douyin', 'https://www.douyin.com/')
      .then((wc) => {
        // 尽力等待页面签名函数就绪（不在则降级为无签名请求，由上层错误提示兜底）
        return withTimeout(this.waitSignFn(wc), 9000, 'sign-timeout').catch(() => wc)
      })
      .then((wc) => {
        this.wwwReady = true
        return wc
      })
      .finally(() => {
        this.wwwPromise = null
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
