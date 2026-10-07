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
  /** 直播间背景图（电台/语音房展示用；部分房间不下发，回退 coverUrl） */
  backgroundUrl?: string
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
  volume: number
  muted: boolean
  /** 响度自动平衡：各直播间响度归一化到统一目标（BS.1770 纯增益），默认开 */
  loudnessNorm: boolean
  /** 应用级增益（dB），叠加在归一化之上，范围 -24 ~ +12，默认 0 */
  appGainDb: number
  /** 直播录制保存根目录；为空时使用默认位置（系统视频目录/dy-live） */
  recordDir?: string
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

/** 应用更新状态（主进程 → 渲染进程） */
export interface UpdateStateEvent {
  status: 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'
  /** 新版本号，如 "0.2.0" */
  version?: string
  /** 下载进度 0-100 */
  percent?: number
  /** status=error 时的说明 */
  message?: string
}

/** 礼物消息附加信息（ChatItem.kind='gift' 时存在） */
export interface GiftInfo {
  /** 渲染层原位合并键：同键行随连击原位更新计数（连击合并） */
  key: string
  /** 礼物名 */
  name: string
  /** 连击累计数量（服务端 repeat_count 累计值） */
  count: number
  /** 礼物静态图 */
  icon?: string
  /** 发送者头像 */
  avatar?: string
  /** 抖币单价（0 = 免费礼物/未下发） */
  diamond?: number
}

/** 公屏弹幕消息（主进程 → 渲染进程，批量推送） */
export interface ChatItem {
  /** 消息类型：chat 普通弹幕 / sys 系统提示 / gift 礼物 */
  kind: 'chat' | 'sys' | 'gift'
  nick: string
  /** 昵称展示色（HSL hue），sys 消息忽略 */
  color: number
  content: string
  gift?: GiftInfo
}

export interface ChatEvent {
  roomId: string
  items: ChatItem[]
}

/** IPC 返回的统一包装 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; message: string }

/** 开始录制请求（渲染层 → 主进程） */
export interface RecStartPayload {
  roomId: string
  webRid?: string
  secUid?: string
  nickname: string
  /** 容器扩展名（mp4/webm/flv）：mp4/webm 由渲染层按 MediaRecorder 能力决定，flv 为源流直录 */
  ext: string
}

/** 开始录制结果：会话 id 用于后续 write/stop 匹配，file 为完整保存路径 */
export interface RecStartResult {
  id: number
  file: string
}

export interface RoomEnterRef {
  roomId?: string
  webRid?: string
  secUid?: string
}
