import { BrowserWindow, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import type { IpcResult, RoomEnterRef, Settings } from '@shared/types'
import { clamp } from './util'
import type { DouyinSessions } from './douyin/sessions'
import type { LiveListService } from './douyin/liveList'
import type { RoomWatcherService } from './douyin/roomWatcher'

export interface IpcContext {
  sessions: DouyinSessions
  liveList: LiveListService
  watcher: RoomWatcherService
  store: StoreLike
  ensureProfileAsync: () => void
  updater: UpdaterLike
  /** 弹幕：用户在房间内打开弹幕开关时对当前房间建连 */
  chatStart: () => boolean
}

interface UpdaterLike {
  getState(): { status: string; version?: string; percent?: number; message?: string } | null
  startDownload(): boolean
}

interface StoreLike {
  get(): { settings: Settings; cache: { list?: any; profile?: any } }
  patch(p: { settings?: Partial<Settings> } | { cache?: any }): void
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function wrap<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  return fn().then(
    (data) => ok(data),
    (e: unknown) => ({ ok: false, message: String((e as Error)?.message ?? e) })
  )
}

export function registerIpc(ctx: IpcContext): void {
  ipcMain.handle(IPC.AuthGetState, async () => {
    const loggedIn = ctx.sessions.isLoggedIn()
    if (loggedIn) ctx.ensureProfileAsync()
    // 直接返回（渲染层按 AuthState 使用，未走 IpcResult 包装）
    return { loggedIn, profile: ctx.store.get().cache.profile ?? null }
  })

  ipcMain.handle(IPC.AuthLogout, async () => {
    await ctx.watcher.teardown()
    ctx.liveList.reset()
    await ctx.sessions.logout()
    return ok(true)
  })

  ipcMain.handle(IPC.ListGetCached, () => ok(ctx.store.get().cache.list ?? null))
  ipcMain.handle(IPC.ListLoad, () => wrap(() => ctx.liveList.initial()))
  ipcMain.handle(IPC.ListLoadMore, () => wrap(() => ctx.liveList.loadMore()))
  ipcMain.handle(IPC.ListRefresh, () => wrap(() => ctx.liveList.refresh(true)))

  ipcMain.handle(IPC.RoomEnter, (_e, ref: RoomEnterRef | undefined) =>
    ctx.watcher.enter({ roomId: ref?.roomId, webRid: ref?.webRid })
  )
  ipcMain.handle(IPC.RoomStop, async () => {
    await ctx.watcher.teardown()
    return ok(true)
  })
  ipcMain.handle(IPC.RoomCheckStatus, () => wrap(() => ctx.watcher.checkStatus()))

  ipcMain.handle(IPC.SettingsGet, () => ctx.store.get().settings)
  ipcMain.handle(IPC.SettingsSet, (_e, patch: Partial<Settings> | undefined) => {
    const cur = ctx.store.get().settings
    const next: Settings = {
      volume: clamp(Number(patch?.volume ?? cur.volume), 0, 1),
      muted: typeof patch?.muted === 'boolean' ? patch.muted : cur.muted,
      loudnessNorm: typeof patch?.loudnessNorm === 'boolean' ? patch.loudnessNorm : cur.loudnessNorm,
      appGainDb: clamp(Number(patch?.appGainDb ?? cur.appGainDb) || 0, -24, 12)
    }
    ctx.store.patch({ settings: next })
    return next
  })

  ipcMain.handle(IPC.WinMinimize, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
    return ok(true)
  })
  ipcMain.handle(IPC.WinMaximize, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize()
    return ok(true)
  })
  ipcMain.handle(IPC.WinClose, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
    return ok(true)
  })
  ipcMain.handle(IPC.WinFullscreen, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w) w.setFullScreen(!w.isFullScreen())
    return ok(true)
  })
  ipcMain.handle(IPC.OpenExternal, (_e, url: unknown) => {
    // 仅允许打开抖音页面
    if (typeof url === 'string' && /^https:\/\/(live\.douyin\.com|www\.douyin\.com)\//.test(url)) {
      void shell.openExternal(url)
    }
    return ok(true)
  })

  ipcMain.handle(IPC.UpdateGetState, () => ctx.updater.getState())
  ipcMain.handle(IPC.UpdateInstall, () => ok(ctx.updater.startDownload()))
  ipcMain.handle(IPC.ChatStart, () => ok(ctx.chatStart()))
}
