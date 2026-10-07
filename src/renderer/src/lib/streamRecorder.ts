/**
 * 源流直录：把 FLV 旁路收集器收到的原始字节经 IPC 交主进程落盘 .flv，
 * 主进程收尾时用随包 ffmpeg 无损转封装为 MP4。不经解码/渲染/重编码，
 * 画质与播放所见一致，CPU 占用近零，窗口最小化照录。
 *
 * 时序保证：起录 =「快照（header+tail）→ recStart → 实时字节」。快照在
 * recStart 前取好并入队，await 期间到达的实时字节按序排在后面，pump 在
 * 拿到会话 id 前只入队不发送——字节流无缝无重、顺序与网络到达一致。
 */
import { api } from './dy'
import type { RecStartPayload } from '@shared/types'
import { FlvByteCollector } from './flvCollector'
import type { FlvSnapshot } from './flvCollector'
import type { FlvTapConsumer } from './flvSei'
import { subscribeFlvBytes } from './flvSei'

export interface RecMeta {
  roomId: string
  webRid?: string
  secUid?: string
  nickname: string
}

/** 每个 PlayerPane 一个：跟随 FLV 播放源订阅原始字节，托管收集器供直录起录 */
export class FlvRecTap {
  readonly collector = new FlvByteCollector()
  private url: string | null = null
  private unsub: (() => void) | null = null
  private recorder: StreamRecorder | null = null

  private consumer: FlvTapConsumer = {
    onConnStart: (id) => {
      this.collector.connStart(id)
      this.recorder?.onConnStart(id)
    },
    onChunk: (id, chunk) => {
      this.collector.feed(id, chunk)
      this.recorder?.forward(id, chunk)
    },
    onConnEnd: (id) => {
      this.collector.connEnd(id)
      this.recorder?.onConnEnd(id)
    }
  }

  constructor() {
    // 字节流失步（超限 tag 等）：连续性无法保证，立即收尾当前段避免落盘坏文件
    this.collector.onCorrupt = () => this.recorder?.onCorrupt()
  }

  /** 跟随播放源切换订阅；url=null 退订（HLS 源/非直播态） */
  retarget(url: string | null): void {
    if (url === this.url) return
    this.unsub?.()
    this.unsub = null
    this.url = url
    this.collector.reset()
    if (url) this.unsub = subscribeFlvBytes(url, this.consumer)
  }

  canRecord(): boolean {
    return this.url !== null && this.collector.ready()
  }

  beginRecording(rec: StreamRecorder): void {
    this.recorder = rec
  }

  endRecording(): void {
    this.recorder = null
  }
}

export class StreamRecorder {
  /** 连接结束/失步导致本段收尾时回调，参数为本段文件路径 */
  onInterrupted: (file: string | null) => void = () => {}

  private state: 'idle' | 'arming' | 'recording' | 'stopping' = 'idle'
  private id = 0
  private file = ''
  private connId = 0
  private startedAt = 0
  private interrupting = false

  /** 待发送字节队列；id 就绪前只入队（arm 期到达的字节不能丢） */
  private queue: Uint8Array[] = []
  private pumpP: Promise<void> = Promise.resolve()
  private starting: Promise<void> | null = null

  constructor(private tap: FlvRecTap) {}

  get active(): boolean {
    return this.state !== 'idle'
  }

  get lastStartedAt(): number {
    return this.startedAt
  }

  async start(_video: HTMLVideoElement, _audioTrack: MediaStreamTrack | null, meta: RecMeta): Promise<string> {
    if (this.state !== 'idle') throw new Error('已在录制中')
    if (!this.tap.canRecord()) throw new Error('FLV 流尚未就绪')
    this.state = 'arming'
    this.tap.beginRecording(this)
    const snap: FlvSnapshot = this.tap.collector.snapshot()
    if (!snap.ready) {
      this.abort()
      throw new Error('FLV 流尚未就绪')
    }
    this.connId = snap.connId
    // 快照先入队（队首），arm 期间的实时字节自然排在其后
    this.enqueue(snap.header)
    if (snap.tail.length) this.enqueue(snap.tail)

    this.starting = (async () => {
      let started: Awaited<ReturnType<typeof api.recStart>>
      try {
        started = await api.recStart({ ...meta, ext: 'flv' } satisfies RecStartPayload)
      } catch (e) {
        this.abort()
        throw e
      }
      if (!started.ok) {
        this.abort()
        throw new Error(started.message)
      }
      this.id = started.data.id
      this.file = started.data.file
      this.startedAt = Date.now()
      this.state = 'recording'
      // arm 期入队的字节可能早于任何新 chunk（流停顿时），补一步泵送确保落盘
      this.pumpP = this.pumpP.then(() => this.pumpStep())
      void this.pumpP.then(() => {
        // recStart 期间连接已断：先把快照字节落成一段，再走中断续录
        if (this.state === 'recording' && !this.tap.collector.isOpen(this.connId)) this.interrupt()
      })
    })()
    await this.starting
    return this.file
  }

  /** 实时字节：录制会话存续期间按序入队（含 arm 期） */
  forward(id: number, chunk: Uint8Array): void {
    if ((this.state === 'arming' || this.state === 'recording') && id === this.connId) {
      this.enqueue(chunk)
    }
  }

  /** 录制中重连：旧连接的 end 触发分段，新连接由上层续录 */
  onConnStart(_id: number): void {}

  onConnEnd(id: number): void {
    if (id === this.connId && this.state === 'recording') this.interrupt()
  }

  onCorrupt(): void {
    if (this.state === 'recording') this.interrupt()
  }

  async stop(): Promise<string | null> {
    if (this.state === 'idle') return null
    if (this.state === 'arming' && this.starting) {
      try {
        await this.starting
      } catch {}
    }
    // await 期间状态可能已被 starting 回调改为 idle，TS 无法推断，这里显式放宽
    if ((this.state as string) === 'idle') return null
    this.state = 'stopping'
    this.tap.endRecording()
    await this.pumpP
    const r = await api.recStop(this.id).catch(() => null)
    const file = (r && r.ok ? r.data : null) || this.file || null
    this.cleanup()
    return file
  }

  private enqueue(chunk: Uint8Array): void {
    if (!chunk.length) return
    this.queue.push(chunk)
    this.pumpP = this.pumpP.then(() => this.pumpStep())
  }

  private async pumpStep(): Promise<void> {
    // stopping 期间也要继续写：fd 在 recStop 前一直有效，收尾字节不能丢
    if (!this.id) return
    const item = this.queue.shift()
    if (!item) return
    try {
      const r = await api.recWrite(this.id, toArrayBuffer(item))
      if (!r.ok || !r.data) throw new Error(r.ok ? '写入录制文件失败' : r.message)
    } catch {
      // 落盘失败（磁盘/权限等）：尽快收尾，避免继续产生无效分片。
      // 当前正处于 pump 链内，interrupt→stop→await pumpP 会死等本步，延后触发
      this.queue = []
      setTimeout(() => this.interrupt(), 0)
    }
  }

  private interrupt(): void {
    if (this.state !== 'recording' || this.interrupting) return
    this.interrupting = true
    void this.stop().then((file) => {
      this.interrupting = false
      this.onInterrupted(file)
    })
  }

  private abort(): void {
    this.tap.endRecording()
    this.cleanup()
  }

  private cleanup(): void {
    this.state = 'idle'
    this.id = 0
    this.file = ''
    this.connId = 0
    this.queue = []
  }
}

/** 网络读到的 Uint8Array 不会被复用；整段持有时直接送底层数组，避免多一次拷贝 */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer as ArrayBuffer
  return u8.slice().buffer as ArrayBuffer
}
