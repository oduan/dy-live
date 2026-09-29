/** 渲染进程与主进程共享的数据类型 */

export interface ProfileInfo {
  secUid: string
  uid?: string
  nickname: string
  avatarUrl?: string
}

/** 关注中正在直播的主播（列表项） */
export interface LiveItem {
  secUid: string
  nickname: string
  avatarUrl?: string
  roomId: string
  webRid?: string
  title: string
  coverUrl?: string
  viewerCount?: number
  status: number
}

export interface ListResult {
  items: LiveItem[]
  hasMore: boolean
  total: number
  updatedAt: number
  nextAutoAt?: number
}

export interface CachedList {
  items: LiveItem[]
  at: number
}

export type StreamKind = 'flv' | 'hls'

export interface StreamChoice {
  url: string
  kind: StreamKind
}

export type RoomTypeHint = 'video' | 'audio' | 'voice' | 'unknown'

export interface RoomInfo {
  roomId: string
  webRid?: string
  title: string
  nickname: string
  avatarUrl?: string
  coverUrl?: string
  /** 2 = 直播中，4 = 已结束 */
  status: number
  viewerCountText?: string
  streams: StreamChoice[]
  typeHint: RoomTypeHint
  startedAt?: number
}

export type RoomEnterCode =
  | 'OK'
  | 'ROOM_CLOSED'
  | 'UNSUPPORTED'
  | 'VERIFY_REQUIRED'
  | 'GUEST_INIT_FAILED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'UNKNOWN'

export interface RoomEnterResult {
  ok: boolean
  code: RoomEnterCode
  message: string
  /** 即使失败（如已下播）也尽量带房间基本信息用于展示 */
  info?: RoomInfo
  /** 诊断信息（兜底提示用） */
  detail?: string
}

export interface RoomStatusEvent {
  roomId: string
  status: number
  viewerCountText?: string
  streams?: StreamChoice[]
  at: number
}

export interface Settings {
  /** 列表自动刷新间隔（秒），默认 300，范围 120–1800 */
  refreshIntervalSec: number
  volume: number
  muted: boolean
}

export interface AuthState {
  loggedIn: boolean
  profile: ProfileInfo | null
}

export interface AuthChangedEvent extends AuthState {}

export interface NetBlockedEvent {
  until: number
  reason: string
}

/** IPC 返回的统一包装 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; message: string }

export interface RoomEnterRef {
  roomId?: string
  webRid?: string
  secUid?: string
}
