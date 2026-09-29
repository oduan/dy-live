import { app, BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { ProfileInfo } from '@shared/types'
import { store } from './store'
import { createMainWindow } from './windows'
import { registerIpc } from './ipc'
import { DouyinSessions } from './douyin/sessions'
import { DouyinApi } from './douyin/api'
import { RequestQueue } from './douyin/queue'
import { LiveListService } from './douyin/liveList'
import { RoomWatcherService } from './douyin/roomWatcher'
import { log } from './util'

// www 登录态接口：间隔 ≥3s + 抖动；guest 直播接口：间隔 ≥2s + 抖动（均为串行队列）
const wwwQueue = new RequestQueue('www', 3_000, 1_500)
const guestQueue = new RequestQueue('guest', 2_000, 1_000)

const sessions = new DouyinSessions()
const api = new DouyinApi(sessions, wwwQueue, guestQueue)

let mainWindow: BrowserWindow | null = null

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

const liveList = new LiveListService({
  api,
  store,
  isLoggedIn: () => sessions.isLoggedIn(),
  broadcast
})
const watcher = new RoomWatcherService({ api, broadcast })

function handleAuthChange(loggedIn: boolean): void {
  broadcast(IPC.EvAuthChanged, {
    loggedIn,
    profile: loggedIn ? store.get().cache.profile ?? null : null
  })
  if (loggedIn) {
    ensureProfileAsync()
    liveList.reset()
  }
}

function ensureProfileAsync(): void {
  api
    .fetchProfile()
    .then((p: ProfileInfo) => {
      store.patch({ cache: { profile: p } })
      if (sessions.isLoggedIn()) {
        broadcast(IPC.EvAuthChanged, { loggedIn: true, profile: p })
      }
    })
    .catch((e: unknown) => log('auth', '拉取用户信息失败:', (e as Error)?.message))
}

function wireQueueBackoff(): void {
  const onChange = (q: RequestQueue) => {
    if (q.blocked) {
      broadcast(IPC.EvNetBlocked, { until: q.blockedUntil, reason: `接口冷却（${q.name}）` })
    } else {
      broadcast(IPC.EvNetRecovered, {})
    }
  }
  wwwQueue.setBlockedListener(onChange)
  guestQueue.setBlockedListener(onChange)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    store.load()
    sessions.init(handleAuthChange)
    wireQueueBackoff()
    registerIpc({ sessions, liveList, watcher, store, ensureProfileAsync })
    liveList.start()
    mainWindow = createMainWindow()
    // 关闭主窗口即退出整个应用：隐藏的抖音页面窗口会导致 window-all-closed 永远不触发，
    // 若不显式退出，关窗后应用会带着隐藏页面驻留后台
    mainWindow.on('closed', () => {
      app.quit()
    })

    if (process.argv.includes('--smoke')) {
      // 冒烟模式：窗口与渲染层装配成功即退出，用于无头验证
      setTimeout(() => {
        const wc = mainWindow?.webContents
        if (!wc || wc.isDestroyed()) {
          log('smoke', 'FAIL: window gone')
          app.exit(1)
          return
        }
        wc
          .executeJavaScript(
            `(() => { const r = document.getElementById('root'); return { children: r ? r.children.length : -1, hasBridge: !!window.dy, title: document.title } })()`
          )
          .then((info: any) => {
            const ok = info?.children > 0 && info?.hasBridge
            log('smoke', ok ? 'SMOKE_OK' : 'SMOKE_FAIL', JSON.stringify(info))
            app.exit(ok ? 0 : 1)
          })
          .catch((e: unknown) => {
            log('smoke', 'SMOKE_FAIL', String(e))
            app.exit(1)
          })
      }, 4_000)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    // 每项清理独立容错：任一环节抛错或挂起都不能阻断退出
    for (const fn of [() => store.flush(), () => liveList.stop(), () => watcher.teardown(), () => sessions.destroy()]) {
      try {
        fn()
      } catch (e) {
        log('quit', '清理异常:', (e as Error)?.message)
      }
    }
    // 兜底强退：正常退出流程若因任何句柄挂起（页面加载中、网络请求中等）超过 2.5s，
    // 强制结束进程，保证关窗后不留后台残留
    setTimeout(() => app.exit(0), 2500)
  })
}
