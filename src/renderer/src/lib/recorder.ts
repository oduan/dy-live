/**
 * 直播录制：
 * - FLV 源 → 源流直录（StreamRecorder）：旁路原始字节直接落盘，无损、流畅、无花屏
 * - 其余（HLS 等）→ 画面捕获（LiveRecorder）：captureStream + MediaRecorder 兜底
 * 音频从 WebAudio 源节点直接旁路，不随音量/静音变化，尽量还原直播原始响度。
 */
import { api } from './dy'
import type { RecStartPayload } from '@shared/types'
import { StreamRecorder } from './streamRecorder'
import type { FlvRecTap } from './streamRecorder'

export interface RecMeta {
  roomId: string
  webRid?: string
  secUid?: string
  nickname: string
}

/** 抖音直播为 H.264 + AAC，优先 MP4 容器；不支持再退 WebM */
const VIDEO_MIMES = [
  'video/mp4;codecs="avc1.640028,mp4a.40.2"',
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4',
  'video/webm;codecs="h264,opus"',
  'video/webm'
]
const AUDIO_MIMES = ['audio/mp4;codecs="mp4a.40.2"', 'audio/mp4', 'audio/webm;codecs="opus"', 'audio/webm']

function pickMime(withVideo: boolean): string {
  for (const m of withVideo ? VIDEO_MIMES : AUDIO_MIMES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m
    } catch {}
  }
  return ''
}

type RecState = 'idle' | 'recording' | 'stopping'

export class LiveRecorder {
  /** 轨道意外结束（断流/切流）导致本段收尾时回调，参数为本段文件路径 */
  onInterrupted: (file: string | null) => void = () => {}

  private state: RecState = 'idle'
  private rec: MediaRecorder | null = null
  private id = 0
  private file = ''
  private writes: Promise<void> = Promise.resolve()
  private startedAt = 0
  private trackCleanups: (() => void)[] = []
  private interrupting = false

  get active(): boolean {
    return this.state !== 'idle'
  }

  get lastStartedAt(): number {
    return this.startedAt
  }

  /** 开始录制；成功返回保存路径，失败抛错（主进程侧不会留下残留会话） */
  async start(video: HTMLVideoElement, audioTrack: MediaStreamTrack | null, meta: RecMeta): Promise<string> {
    if (this.state !== 'idle') throw new Error('已在录制中')
    // captureStream 在当前 TS lib.dom 无声明，按能力探测
    const el = video as HTMLVideoElement & { captureStream?: () => MediaStream }
    if (typeof el.captureStream !== 'function') throw new Error('当前环境不支持画面捕获')
    const raw = el.captureStream()
    const vTracks = raw.getVideoTracks()
    const mime = pickMime(vTracks.length > 0)
    if (!mime) throw new Error('当前内核不支持 MP4/WebM 录制')
    const ext = mime.includes('mp4') ? 'mp4' : 'webm'

    const started = await api.recStart({ ...meta, ext } satisfies RecStartPayload)
    if (!started.ok) throw new Error(started.message)

    const stream = new MediaStream()
    for (const t of vTracks) stream.addTrack(t)
    const at = audioTrack ?? raw.getAudioTracks()[0] ?? null
    if (at) stream.addTrack(at)
    if (stream.getTracks().length === 0) {
      void api.recStop(started.data.id)
      throw new Error('没有可录制的音视频轨')
    }

    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 128_000 })
    } catch (e) {
      void api.recStop(started.data.id)
      throw new Error(`录制器初始化失败：${String((e as Error)?.message ?? e)}`)
    }

    this.id = started.data.id
    this.file = started.data.file
    this.rec = rec
    this.state = 'recording'
    this.startedAt = Date.now()

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.enqueue(e.data)
    }
    // 视频轨结束（切流/断流重连导致元素换源）→ 收尾本段，由上层决定是否续录
    const vt = vTracks[0]
    if (vt) {
      const onEnd = (): void => this.interrupt()
      vt.addEventListener('ended', onEnd)
      this.trackCleanups.push(() => vt.removeEventListener('ended', onEnd))
    }
    rec.start(1000)
    return this.file
  }

  private enqueue(blob: Blob): void {
    this.writes = this.writes
      .then(async () => {
        const buf = await blob.arrayBuffer()
        const r = await api.recWrite(this.id, buf)
        if (!r.ok || !r.data) throw new Error(r.ok ? '写入录制文件失败' : r.message)
      })
      .catch(() => {
        // 落盘失败（磁盘/权限等）：尽快收尾，避免继续产生无效分片
        this.interrupt()
      })
  }

  private interrupt(): void {
    if (this.state !== 'recording' || this.interrupting) return
    this.interrupting = true
    void this.stop().then((file) => {
      this.interrupting = false
      this.onInterrupted(file)
    })
  }

  /** 停止并落盘；返回最终文件路径（未在录制时返回 null） */
  async stop(): Promise<string | null> {
    if (this.state === 'idle') return null
    const rec = this.rec
    this.rec = null
    this.state = 'stopping'
    if (rec && rec.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        const done = (): void => resolve()
        rec.onstop = done
        try {
          rec.stop()
        } catch {
          done()
        }
        setTimeout(done, 3_000)
      })
    }
    for (const fn of this.trackCleanups.splice(0)) {
      try {
        fn()
      } catch {}
    }
    await this.writes.catch(() => {})
    this.state = 'idle'
    const r = await api.recStop(this.id).catch(() => null)
    const file = (r && r.ok ? r.data : null) || this.file || null
    this.file = ''
    return file
  }
}

/**
 * 录制门面：FLV 源且旁路就绪时走源流直录，否则退回画面捕获。
 * 对外接口与 LiveRecorder 一致，PlayerPane 无感知。
 */
export class RecController {
  onInterrupted: (file: string | null) => void = () => {}
  private impl: LiveRecorder | StreamRecorder | null = null

  constructor(private getFlvTap: () => FlvRecTap | null) {}

  get active(): boolean {
    return this.impl?.active ?? false
  }

  get lastStartedAt(): number {
    return this.impl?.lastStartedAt ?? 0
  }

  start(video: HTMLVideoElement, audioTrack: MediaStreamTrack | null, meta: RecMeta): Promise<string> {
    const tap = this.getFlvTap()
    const rec = tap && tap.canRecord() ? new StreamRecorder(tap) : new LiveRecorder()
    rec.onInterrupted = (f) => {
      this.onInterrupted(f)
    }
    this.impl = rec
    return rec.start(video, audioTrack, meta)
  }

  async stop(): Promise<string | null> {
    const impl = this.impl
    if (!impl) return null
    this.impl = null
    return impl.stop()
  }
}
