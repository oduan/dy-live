/** 渲染进程侧的 IPC 类型化封装 */
import { IPC } from '@shared/ipc'
import type {
  AuthChangedEvent,
  AuthState,
  CachedList,
  IpcResult,
  ListResult,
  NetBlockedEvent,
  RoomEnterRef,
  RoomEnterResult,
  RoomStatusEvent,
  Settings,
  UpdateStateEvent
} from '@shared/types'

const dy = window.dy!

async function inv<T>(channel: string, payload?: unknown): Promise<T> {
  return dy.invoke(channel, payload) as Promise<T>
}

export const api = {
  authGetState: () => inv<AuthState>(IPC.AuthGetState),
  logout: () => inv<IpcResult<boolean>>(IPC.AuthLogout),

  listGetCached: () => inv<IpcResult<CachedList | null>>(IPC.ListGetCached),
  listLoad: () => inv<IpcResult<ListResult>>(IPC.ListLoad),
  listLoadMore: () => inv<IpcResult<ListResult>>(IPC.ListLoadMore),
  listRefresh: () => inv<IpcResult<ListResult>>(IPC.ListRefresh),

  roomEnter: (ref: RoomEnterRef) => inv<RoomEnterResult>(IPC.RoomEnter, ref),
  roomStop: () => inv<IpcResult<boolean>>(IPC.RoomStop),
  roomCheckStatus: () => inv<IpcResult<RoomStatusEvent | null>>(IPC.RoomCheckStatus),

  settingsGet: () => inv<Settings>(IPC.SettingsGet),
  settingsSet: (patch: Partial<Settings>) => inv<Settings>(IPC.SettingsSet, patch),

  winMaximize: () => inv<IpcResult<boolean>>(IPC.WinMaximize),
  winFullscreen: () => inv<IpcResult<boolean>>(IPC.WinFullscreen),
  openExternal: (url: string) => inv<IpcResult<boolean>>(IPC.OpenExternal, url),

  updateGetState: () => inv<UpdateStateEvent | null>(IPC.UpdateGetState),
  updateInstall: () => inv<IpcResult<boolean>>(IPC.UpdateInstall),

  onAuthChanged: (cb: (e: AuthChangedEvent) => void) => dy.on(IPC.EvAuthChanged, cb as (d: unknown) => void),
  onListAutoUpdated: (cb: (e: ListResult) => void) => dy.on(IPC.EvListAutoUpdated, cb as (d: unknown) => void),
  onNextRefresh: (cb: (e: { at: number }) => void) => dy.on(IPC.EvNextRefresh, cb as (d: unknown) => void),
  onRoomStatus: (cb: (e: RoomStatusEvent) => void) => dy.on(IPC.EvRoomStatus, cb as (d: unknown) => void),
  onNetBlocked: (cb: (e: NetBlockedEvent) => void) => dy.on(IPC.EvNetBlocked, cb as (d: unknown) => void),
  onNetRecovered: (cb: () => void) => dy.on(IPC.EvNetRecovered, cb as () => void),
  onUpdateState: (cb: (e: UpdateStateEvent) => void) => dy.on(IPC.EvUpdateState, cb as (d: unknown) => void)
}
