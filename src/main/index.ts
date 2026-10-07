import path from 'node:path'
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
import { ChatService } from './douyin/chat'
import { UpdateService } from './updater'
import { RecordService } from './recorder'
import { log } from './util'

// 开发/未打包运行使用独立数据目录：单实例锁按 userData 路径判定，
// 设置、登录 Cookie、缓存也随之与正式版完全隔离，两边可同时运行互不影响
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'dy-live-dev'))
}

// www 登录态接口：间隔 ≥3s + 抖动；guest 直播接口：间隔 ≥2s + 抖动（均为串行队列）
const wwwQueue = new RequestQueue('www', 3_000, 1_500)
const guestQueue = new RequestQueue('guest', 2_000, 1_000)

// 直播录制依赖页面持续出帧：禁用 Windows 窗口遮挡判定，
// 避免窗口被遮挡/最小化时视频帧停发导致录出来的画面缺失
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const sessions = new DouyinSessions()
const api = new DouyinApi(sessions, wwwQueue, guestQueue)

let mainWindow: BrowserWindow | null = null
const recorder = new RecordService()
/** 录制收尾完成后放行关窗（防止 MP4 收尾块没写入就退出） */
let recCloseReady = false

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

const liveList = new LiveListService({
  api,
  store,
  isLoggedIn: () => sessions.isLoggedIn(),
  broadcast
})
const chat = new ChatService({ sessions, broadcast })
const watcher = new RoomWatcherService({ api, chat, broadcast })
const updater = new UpdateService(broadcast)

function handleAuthChange(loggedIn: boolean): void {
  broadcast(IPC.EvAuthChanged, {
    loggedIn,
    profile: loggedIn ? store.get().cache.profile ?? null : null
  })
  if (loggedIn) {
    // 启动预热：列表是首屏核心，先于用户信息入队，隐藏页就绪后立即拉取；
    // 渲染层稍后的 listLoad 会复用这次进行中/刚完成的拉取，不重复排队
    liveList.reset()
    void liveList.refresh(true).catch((e: unknown) => log('liveList', '预热拉取失败:', (e as Error)?.message))
    ensureProfileAsync()
  }
}

let profileInflight = false

function ensureProfileAsync(): void {
  if (profileInflight) return
  profileInflight = true
  api
    .fetchProfile()
    .then((p: ProfileInfo) => {
      store.patch({ cache: { profile: p } })
      if (sessions.isLoggedIn()) {
        broadcast(IPC.EvAuthChanged, { loggedIn: true, profile: p })
      }
    })
    .catch((e: unknown) => log('auth', '拉取用户信息失败:', (e as Error)?.message))
    .finally(() => {
      profileInflight = false
    })
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
    registerIpc({
      sessions,
      liveList,
      watcher,
      store,
      ensureProfileAsync,
      updater,
      recorder,
      onRecFinalized: () => {
        recCloseReady = true
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
      },
      chatStart: () => {
        const cur = watcher.getCurrentRoom()
        if (!cur?.roomId) return false
        chat.start({ roomId: cur.roomId, webRid: cur.webRid })
        return true
      }
    })
    liveList.start()
    updater.start()
    mainWindow = createMainWindow()

    // 录制中关窗：先让渲染层停止录制并把 MP4 收尾块落盘，再真正关闭（4s 兜底强关）
    mainWindow.on('close', (e) => {
      if (recCloseReady || !recorder.active) return
      e.preventDefault()
      broadcast(IPC.EvRecFinalize, {})
      setTimeout(() => {
        recCloseReady = true
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
      }, 4_000)
    })
    // 渲染层重载（开发热重载/异常恢复）会丢失录制器，直接结束落盘，避免句柄挂死
    mainWindow.webContents.on('did-start-navigation', (_ev, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) recorder.stop()
    })

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
    for (const fn of [
      () => store.flush(),
      () => liveList.stop(),
      () => watcher.teardown(),
      () => recorder.stop(),
      () => sessions.destroy()
    ]) {
      try {
        fn()
      } catch (e) {
        log('quit', '清理异常:', (e as Error)?.message)
      }
    }
    // 兜底强退：正常退出流程若因任何句柄挂起（页面加载中、网络请求中等）超过宽限期，
    // 强制结束进程，保证关窗后不留后台残留；录制收尾（渲染层落盘）需要更长的宽限
    setTimeout(() => app.exit(0), recorder.active ? 6_000 : 2_500)
  })
}
