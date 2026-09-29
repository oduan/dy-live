/**
 * 直播流播放引擎：FLV（mpegts.js）与 HLS（hls.js）统一封装。
 * - 直播延迟追赶 / 卡顿看护 / 流结束（EOF）回调
 * - 语音厅与音频直播：音频流同样走 MSE 送到 <video>，画面为空（videoWidth===0）
 */
import mpegts from 'mpegts.js'
import Hls from 'hls.js'

export type StreamKind = 'flv' | 'hls'

export class LiveStreamPlayer {
  onFatal: (reason: string) => void = () => {}
  onEnded: () => void = () => {}

  private video: HTMLVideoElement | null = null
  private flvPlayer: mpegts.Player | null = null
  private hls: Hls | null = null
  private watchdog: number | null = null
  private stall = 0
  private hlsNetRetry = 0
  private hlsMediaRetry = 0
  private flvMediaRetry = 0
  private destroyed = false
  private onVideoEnded = (): void => {
    if (!this.destroyed) this.onEnded()
  }

  attach(video: HTMLVideoElement): void {
    this.video = video
    video.addEventListener('ended', this.onVideoEnded)
  }

  load(url: string, kind: StreamKind): void {
    const v = this.video
    if (!v || this.destroyed) return
    this.teardownInstance()

    if (kind === 'flv' && mpegts.getFeatureList().mseLivePlayback) {
      const p = mpegts.createPlayer(
        { type: 'flv', isLive: true, url },
        {
          enableWorker: true,
          liveBufferLatencyChasing: true,
          liveBufferLatencyMaxLatency: 6,
          liveBufferLatencyMinRemain: 0.5,
          lazyLoad: false
        }
      )
      p.on(mpegts.Events.ERROR, (errType: string, errDetail: string) => {
        if (this.destroyed) return
        if (errType === mpegts.ErrorTypes.MEDIA_ERROR && this.flvMediaRetry < 1) {
          this.flvMediaRetry++
          try {
            ;(p as unknown as { recoverMediaError: () => void }).recoverMediaError()
            return
          } catch {}
        }
        this.onFatal(`flv:${errType}/${errDetail}`)
      })
      p.on(mpegts.Events.LOADING_COMPLETE, () => {
        if (!this.destroyed) this.onEnded()
      })
      p.attachMediaElement(v)
      p.load()
      this.flvPlayer = p
      void Promise.resolve(p.play()).catch(() => this.fallbackMutedPlay())
    } else {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30,
        maxBufferLength: 8,
        liveSyncDurationCount: 3,
        fragLoadingMaxRetry: 4
      })
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (this.destroyed || !data.fatal) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.hlsNetRetry < 2) {
          this.hlsNetRetry++
          hls.startLoad()
          return
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.hlsMediaRetry < 1) {
          this.hlsMediaRetry++
          hls.recoverMediaError()
          return
        }
        this.onFatal(`hls:${data.type}/${data.details}`)
      })
      hls.loadSource(url)
      hls.attachMedia(v)
      this.hls = hls
      void v.play().catch(() => this.fallbackMutedPlay())
    }

    this.startWatchdog()
  }

  /** 自动播放被拦截时：静音重试（Electron 默认允许，这里兜底） */
  private fallbackMutedPlay(): void {
    const v = this.video
    if (!v || this.destroyed) return
    v.muted = true
    void v.play().catch(() => this.onFatal('autoplay-blocked'))
  }

  /** 跳到直播边缘 */
  jumpToLive(): void {
    const v = this.video
    if (!v || this.destroyed) return
    try {
      const b = v.buffered
      if (b.length) v.currentTime = Math.max(0, b.end(b.length - 1) - 0.3)
      void v.play().catch(() => {})
    } catch {}
  }

  private bufferedEnd(v: HTMLVideoElement): number {
    try {
      const b = v.buffered
      return b.length ? b.end(b.length - 1) : 0
    } catch {
      return 0
    }
  }

  private startWatchdog(): void {
    this.stall = 0
    this.watchdog = window.setInterval(() => {
      const v = this.video
      if (!v || this.destroyed || v.paused) return
      const end = this.bufferedEnd(v)
      // 落后太多则追赶
      if (end - v.currentTime > 10) {
        try {
          v.currentTime = end - 0.5
        } catch {}
      }
      // 缓冲不增长且贴近播放头 → 卡顿
      if (end - v.currentTime < 0.08) {
        this.stall++
        if (this.stall >= 3) {
          this.stall = 0
          this.onFatal('stalled')
        }
      } else {
        this.stall = 0
      }
    }, 4_000)
  }

  private teardownInstance(): void {
    if (this.watchdog !== null) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    if (this.flvPlayer) {
      try {
        this.flvPlayer.pause()
        this.flvPlayer.unload()
        this.flvPlayer.detachMediaElement()
        this.flvPlayer.destroy()
      } catch {}
      this.flvPlayer = null
    }
    if (this.hls) {
      try {
        this.hls.destroy()
      } catch {}
      this.hls = null
    }
    this.hlsNetRetry = 0
    this.hlsMediaRetry = 0
    this.flvMediaRetry = 0
  }

  destroy(): void {
    this.destroyed = true
    this.teardownInstance()
    if (this.video) {
      this.video.removeEventListener('ended', this.onVideoEnded)
      try {
        this.video.pause()
        this.video.removeAttribute('src')
        this.video.load()
      } catch {}
      this.video = null
    }
  }
}
