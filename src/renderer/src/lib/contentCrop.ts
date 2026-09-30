/**
 * PK/连麦智能取景：主播打 PK 时流仍是竖屏分辨率，但下游合成器把 2/3/4 人
 * 的横条画面居中放在竖屏流里，上下留大片纯色灰边。
 *
 * 两级策略：
 * 1. SEI 精确布局（优先）：FLV 旁路解析 payload_type=100 的业务 SEI，直接拿到
 *    各参与者的归一化矩形（见 flvSei.ts），精确、即时、无误判；
 * 2. 像素检测兜底：无 SEI（HLS 源/非 H.264/SEI 失效）时定期抽帧检测有效内容区。
 *
 * 把内容区 contain 放大居中到播放器可视区；PK 结束画面恢复全幅后自动还原。
 * 检测不到明确留边时不动画面（不影响正常竖屏/横屏直播）。
 */

import { FlvSeiTap, SeiLayout, tapFlvSei } from './flvSei'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 抽帧宽度（等比缩放后采样，控制 getImageData 开销） */
const SAMPLE_W = 120
/** 像素与背景色的最小通道差，超过才算内容像素 */
const BG_DIFF = 24
/** 一行/列中内容像素占比达到该值才算内容行/列 */
const CONTENT_RATIO = 0.04
/** 留边超过该帧维度的 10% 才启用放大 */
const ENABLE_BAR = 0.1
/** 内容宽高占比回到 97% 以上视为恢复全幅 */
const RESET_RATIO = 0.97
/** 连续采样一致才应用/还原（防镜头切换、暗场误判） */
const CONFIRM_COUNT = 2
const CHECK_INTERVAL = 2000
/** 两次候选视为一致的偏差容限（归一化） */
const TOLERANCE = 0.02
/** SEI 布局的新鲜期：期内直接采用，超时回退像素检测 */
const SEI_FRESH_MS = 15_000

const closeTo = (a: Rect | null, b: Rect | null): boolean => {
  if (!a || !b) return a === b
  return (
    Math.abs(a.x - b.x) < TOLERANCE &&
    Math.abs(a.y - b.y) < TOLERANCE &&
    Math.abs(a.w - b.w) < TOLERANCE &&
    Math.abs(a.h - b.h) < TOLERANCE
  )
}

export class ContentCropper {
  private video: HTMLVideoElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private timer: number | undefined
  private debounce: number | undefined
  private candidate: Rect | null = null
  private candidateHits = 0
  /** 当前已应用到 transform 的内容区；null 表示全幅原始状态 */
  private applied: Rect | null = null
  /** SEI 给出的内容带（新鲜期内权威）；seAt 用于过期回退像素检测 */
  private seiRect: Rect | null = null
  private seiAt = 0
  private tap: FlvSeiTap | null = null
  /** 画布被跨域污染等不可恢复错误，之后不再尝试 */
  private broken = false

  attach(video: HTMLVideoElement): void {
    this.destroy()
    this.video = video
    this.canvas = document.createElement('canvas')
    video.addEventListener('loadedmetadata', this.onMaybe)
    video.addEventListener('playing', this.onMaybe)
    // 分辨率变化（PK 开始/结束可能换档）时立即复检
    video.addEventListener('resize', this.onMaybe)
    window.addEventListener('resize', this.onMaybe)
    this.timer = window.setInterval(this.check, CHECK_INTERVAL)
  }

  destroy(): void {
    window.clearInterval(this.timer)
    window.clearTimeout(this.debounce)
    this.tap?.dispose()
    this.tap = null
    if (this.video) {
      this.video.removeEventListener('loadedmetadata', this.onMaybe)
      this.video.removeEventListener('playing', this.onMaybe)
      this.video.removeEventListener('resize', this.onMaybe)
      this.video.style.transform = ''
    }
    window.removeEventListener('resize', this.onMaybe)
    this.video = null
    this.canvas = null
    this.candidate = null
    this.candidateHits = 0
    this.applied = null
    this.seiRect = null
  }

  private onMaybe = (): void => {
    window.clearTimeout(this.debounce)
    this.debounce = window.setTimeout(this.check, 400)
  }

  /** 接管 FLV 拉流响应，旁路解析 SEI 布局（仅 flv 源调用；必须在 player.load 之前） */
  tapStream(url: string): void {
    this.tap?.dispose()
    this.tap = tapFlvSei(url, (l) => this.onSeiLayout(l))
  }

  /** SEI 布局到达：刷新新鲜度；内容带变化且画布与视频一致时立即应用 */
  private onSeiLayout(l: SeiLayout): void {
    this.seiAt = Date.now()
    const v = this.video
    if (!v || !v.videoWidth || !v.videoHeight || !l.canvasW || !l.canvasH) return
    // SEI 矩形基于合成画布；画布与视频帧纵横比不一致时不可信（横屏直播等），弃用
    const va = v.videoWidth / v.videoHeight
    const ca = l.canvasW / l.canvasH
    if (Math.abs(va - ca) / ca > 0.02) return
    const rect: Rect = { x: l.bounds.x, y: l.bounds.y, w: l.bounds.w, h: l.bounds.h }
    if (closeTo(rect, this.seiRect)) return
    this.seiRect = rect
    this.check()
  }

  private check = (): void => {
    const v = this.video
    if (!v || this.broken) return
    if (document.hidden || v.readyState < 2 || v.videoWidth === 0) return
    // 音频房视频是隐藏占位；下播定格走 CSS 模糊，都不做取景
    if (v.classList.contains('ghost')) return
    if (v.classList.contains('ended')) {
      if (this.applied) {
        this.applied = null
        this.applyTransform(null)
      }
      return
    }

    // SEI 精确布局优先：新鲜期内直接采用，无需像素采样与二次确认
    if (this.seiRect && Date.now() - this.seiAt < SEI_FRESH_MS) {
      const target = this.decide(this.seiRect)
      if (!closeTo(target, this.applied)) {
        this.applied = target
        this.applyTransform(target)
      }
      return
    }
    this.seiRect = null

    const rect = this.sample()
    if (closeTo(rect, this.candidate)) this.candidateHits++
    else {
      this.candidate = rect
      this.candidateHits = 1
    }
    if (this.candidateHits < CONFIRM_COUNT) return

    const target = this.decide(rect)
    if (closeTo(target, this.applied)) return
    this.applied = target
    this.applyTransform(target)
  }

  /** 迟滞判定：明确留边 → 取景；恢复全幅 → 还原；中间带维持现状 */
  private decide(rect: Rect | null): Rect | null {
    if (!rect) return null
    if (rect.h <= 1 - ENABLE_BAR || rect.w <= 1 - ENABLE_BAR) return rect
    if (rect.h >= RESET_RATIO && rect.w >= RESET_RATIO) return null
    return this.applied
  }

  /** 抽帧检测有效内容区（归一化坐标）；无内容/不可靠时返回 null */
  private sample(): Rect | null {
    const v = this.video
    const c = this.canvas
    if (!v || !c) return null
    const vw = v.videoWidth
    const vh = v.videoHeight
    const w = SAMPLE_W
    const h = Math.max(2, Math.round((SAMPLE_W * vh) / vw))
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
    }
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      this.broken = true
      return null
    }
    try {
      ctx.drawImage(v, 0, 0, w, h)
    } catch {
      this.broken = true
      return null
    }
    let data: Uint8ClampedArray
    try {
      data = ctx.getImageData(0, 0, w, h).data
    } catch {
      this.broken = true
      return null
    }

    // 背景色取四角 6x6 均值（PK 灰边/黑边都适用）
    const corner = (cx: number, cy: number): [number, number, number] => {
      let r = 0
      let g = 0
      let b = 0
      const n = 36
      for (let y = cy; y < cy + 6; y++) {
        for (let x = cx; x < cx + 6; x++) {
          const i = (y * w + x) * 4
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
        }
      }
      return [r / n, g / n, b / n]
    }
    const corners = [corner(0, 0), corner(w - 6, 0), corner(0, h - 6), corner(w - 6, h - 6)]
    const bg = [0, 1, 2].map((k) => corners.reduce((s, cc) => s + cc[k], 0) / corners.length)
    const isContent = (i: number): boolean =>
      Math.abs(data[i] - bg[0]) > BG_DIFF ||
      Math.abs(data[i + 1] - bg[1]) > BG_DIFF ||
      Math.abs(data[i + 2] - bg[2]) > BG_DIFF

    const rows = new Array<number>(h).fill(0)
    for (let y = 0; y < h; y++) {
      let count = 0
      for (let x = 0; x < w; x++) if (isContent((y * w + x) * 4)) count++
      rows[y] = count
    }
    const rowTh = w * CONTENT_RATIO
    let top = 0
    while (top < h && rows[top] < rowTh) top++
    if (top === h) return null // 全帧纯色（黑屏/占位帧）
    let bottom = h - 1
    while (bottom > top && rows[bottom] < rowTh) bottom--

    const cols = new Array<number>(w).fill(0)
    for (let y = top; y <= bottom; y++) {
      for (let x = 0; x < w; x++) if (isContent((y * w + x) * 4)) cols[x]++
    }
    const colTh = (bottom - top + 1) * CONTENT_RATIO
    let left = 0
    while (left < w && cols[left] < colTh) left++
    let right = w - 1
    while (right > left && cols[right] < colTh) right--

    const rect: Rect = {
      x: left / w,
      y: top / h,
      w: (right - left + 1) / w,
      h: (bottom - top + 1) / h
    }
    // 内容区过小视为检测不可靠（如转场黑帧），不处理
    if (rect.w < 0.15 || rect.h < 0.15) return null
    return rect
  }

  /** 把内容区 contain 放大并居中到视频元素可视区（基于未变换的布局尺寸计算） */
  private applyTransform(rect: Rect | null): void {
    const v = this.video
    if (!v) return
    if (!rect) {
      v.style.transform = ''
      return
    }
    const ew = v.offsetWidth
    const eh = v.offsetHeight
    const vw = v.videoWidth
    const vh = v.videoHeight
    if (!ew || !eh || !vw || !vh) return
    // object-fit: contain 的实际渲染矩形
    const k = Math.min(ew / vw, eh / vh)
    const rw = vw * k
    const rh = vh * k
    const ox = (ew - rw) / 2
    const oy = (eh - rh) / 2
    const cw = rect.w * rw
    const ch = rect.h * rh
    const s = Math.max(1, Math.min(ew / cw, eh / ch))
    const cx = ox + (rect.x + rect.w / 2) * rw
    const cy = oy + (rect.y + rect.h / 2) * rh
    const tx = s * (ew / 2 - cx)
    const ty = s * (eh / 2 - cy)
    v.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${s.toFixed(4)})`
  }
}
