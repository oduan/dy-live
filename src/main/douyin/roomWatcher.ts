import type { RoomEnterResult, RoomInfo, RoomStatusEvent } from '@shared/types'
import { IPC } from '@shared/ipc'
import type { DouyinApi } from './api'
import type { ChatService } from './chat'
import { log } from '../util'

/** 活跃房间轮询间隔：60s + 抖动（仅对当前观看的一个房间轮询） */
const POLL_MS = 60_000
/** 下播后继续轮询的次数（用于检测“重新开播”），之后停止 */
const END_TICKS = 3
/** 手动状态查询的最小间隔 */
const MANUAL_CHECK_DEBOUNCE = 8_000

export interface RoomWatcherDeps {
  api: DouyinApi
  chat: ChatService
  /** 弹幕开关（设置实时读取）：关闭时不建连，降低请求面 */
  chatEnabled: () => boolean
  broadcast: (channel: string, payload: unknown) => void
}

/** 当前观看房间的状态轮询：下播检测、在线人数更新、流地址续期 */
export class RoomWatcherService {
  private cur: { roomId?: string; webRid?: string } | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private endTicks = 0
  private stopped = true
  private lastManualCheck = 0
  private lastEvent: RoomStatusEvent | null = null

  constructor(private deps: RoomWatcherDeps) {}

  async enter(ref: { roomId?: string; webRid?: string }): Promise<RoomEnterResult> {
    this.stopTimer()
    this.cur = { roomId: ref.roomId, webRid: ref.webRid }
    this.endTicks = 0
    this.lastEvent = null
    const res = await this.deps.api.guestRoomEnter(ref)
    if (res.ok && res.info) {
      this.cur = { roomId: res.info.roomId || ref.roomId, webRid: res.info.webRid || ref.webRid }
      this.lastEvent = this.toEvent(res.info)
      this.startTimer()
      // 公屏弹幕：跟随当前观看的房间；开关关闭时不建连（省资源、降低风控面）
      if (this.deps.chatEnabled()) {
        this.deps.chat.start({ roomId: this.cur.roomId ?? '', webRid: this.cur.webRid })
      } else {
        this.deps.chat.stop()
      }
    } else {
      this.deps.chat.stop()
    }
    return res
  }

  getCurrentRoom(): { roomId?: string; webRid?: string } | null {
    return this.cur
  }

  async teardown(): Promise<void> {
    this.stopTimer()
    this.cur = null
    this.deps.chat.stop()
  }

  private startTimer(): void {
    this.stopped = false
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.tick(), POLL_MS + Math.random() * 5_000)
  }

  private stopTimer(): void {
    clearTimeout(this.timer)
    this.stopped = true
  }

  private async tick(): Promise<void> {
    if (!this.cur) return
    try {
      const res = await this.deps.api.guestRoomEnter(this.cur)
      const info = res.ok ? res.info : res.code === 'ROOM_CLOSED' ? res.info : undefined
      if (info) {
        this.emit(info)
        if (info.status === 4) {
          this.endTicks++
          if (this.endTicks >= END_TICKS) return this.stopTimer()
        } else {
          this.endTicks = 0
        }
      }
    } catch (e) {
      // 队列冷却 / 网络异常：保留计时器，下轮继续
      log('roomWatcher', '轮询失败:', (e as Error)?.message)
    }
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.tick(), POLL_MS + Math.random() * 5_000)
    }
  }

  private emit(info: RoomInfo): void {
    const ev = this.toEvent(info)
    this.lastEvent = ev
    this.deps.broadcast(IPC.EvRoomStatus, ev)
  }

  private toEvent(info: RoomInfo): RoomStatusEvent {
    return {
      roomId: info.roomId,
      status: info.status,
      viewerCountText: info.viewerCountText,
      streams: info.streams,
      at: Date.now()
    }
  }

  /** 渲染端播放异常/流结束时立即校验状态（带防抖） */
  async checkStatus(): Promise<RoomStatusEvent | null> {
    if (!this.cur) return null
    const now = Date.now()
    if (now - this.lastManualCheck < MANUAL_CHECK_DEBOUNCE) return this.lastEvent
    this.lastManualCheck = now
    try {
      const res = await this.deps.api.guestRoomEnter(this.cur)
      const info = res.ok ? res.info : res.code === 'ROOM_CLOSED' ? res.info : undefined
      if (info) {
        this.emit(info)
        return this.lastEvent
      }
      return null
    } catch {
      return null
    }
  }
}
