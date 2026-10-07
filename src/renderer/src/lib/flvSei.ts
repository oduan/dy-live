/**
 * FLV 字节旁路：解析 AVC SEI（payload_type=100）提取 PK/连麦合成布局。
 *
 * 抖音合成流的每个关键帧携带一条自定义 SEI，内容为 UTF-8 JSON：
 *   外层 {"app_data":"<内层JSON字符串>","sei_index":N}
 *   内层 {ver:2双人/6多人, mix_grids:[{uid_str,x,y,w,h,...}], canvas:{width,height,background}, ...}
 * 矩形为画布归一化坐标（灰边即画布底色），抖音网页 PKSEIPlugin 即据此做布局。
 * 这里在 fetch 层 tee 播放器的 FLV 响应，旁路喂给增量解析器，把内容带包围盒
 * 交给智能取景；主路字节经 tee 原样透传给 mpegts.js，不受解析影响。
 */

export interface SeiLayout {
  /** 2=双人(DOUBLE) 6=多人(MULTI)，0=未知 */
  ver: number
  /** SEI 合成画布尺寸；视频帧纵横比应与其一致，否则布局不可信 */
  canvasW: number
  canvasH: number
  /** 全体参与者矩形的包围盒（归一化 0..1）；无有效网格时为全幅 */
  bounds: { x: number; y: number; w: number; h: number }
}

export interface FlvSeiTap {
  dispose(): void
}

/** 增量解析器最小接口（独立导出，便于无 DOM 环境测试） */
export interface FlvSeiParserLike {
  feed(chunk: Uint8Array): void
}

/** 抖音业务 SEI 的 payload_type（网页端 PKSEIPlugin 同样只认 code=100） */
const SEI_PAYLOAD_TYPE = 100
/** 单个 FLV tag 的合理上限，超过视为流损坏并复位解析 */
const MAX_TAG_SIZE = 4_000_000

class FlvSeiParser {
  private buf = new Uint8Array(64 * 1024)
  private len = 0
  private pos = 0
  private started = false
  private onLayout: (l: SeiLayout) => void

  constructor(onLayout: (l: SeiLayout) => void) {
    this.onLayout = onLayout
  }

  feed(chunk: Uint8Array): void {    const avail = this.len - this.pos
    if (avail + chunk.length > this.buf.length) {
      const nb = new Uint8Array(Math.max(avail + chunk.length, this.buf.length * 2))
      nb.set(this.buf.subarray(this.pos, this.len))
      this.buf = nb
    } else if (this.pos > 0) {
      this.buf.copyWithin(0, this.pos, this.len)
    }
    this.buf.set(chunk, avail)
    this.len = avail + chunk.length
    this.pos = 0
    this.process()
  }

  private process(): void {
    if (!this.started) {
      if (this.len - this.pos < 13) return
      // 'FLV' 头 9 字节 + 首个 PreviousTagSize0 4 字节
      this.pos += 13
      this.started = true
    }
    for (;;) {
      const rem = this.len - this.pos
      if (rem < 11) break
      const type = this.buf[this.pos]
      const size =
        (this.buf[this.pos + 1] << 16) | (this.buf[this.pos + 2] << 8) | this.buf[this.pos + 3]
      if (size > MAX_TAG_SIZE) {
        // 流损坏：丢弃已缓冲数据重新同步（等下一个 FLV 头不现实，直接放弃本轮）
        this.pos = this.len
        break
      }
      const total = 11 + size + 4 // tag 头 + 数据 + PreviousTagSize
      if (rem < total) break
      if (type === 9 && size > 5) {
        this.handleVideo(this.buf.subarray(this.pos + 11, this.pos + 11 + size))
      }
      this.pos += total
    }
    if (this.pos > 0) {
      this.buf.copyWithin(0, this.pos, this.len)
      this.len -= this.pos
      this.pos = 0
    }
  }

  /** VideoTagBody：1B(FrameType|CodecID) 1B(AVCPacketType) 3B(CTS) + 4B 长度前缀 NALU 串 */
  private handleVideo(data: Uint8Array): void {
    if ((data[0] & 0x0f) !== 7) return // CodecID 非 AVC（H.265 的 SEI 结构不同，交给像素兜底）
    if (data[1] !== 1) return // 只处理 NALU 包（0=sequence header 2=EOF）
    let p = 5
    while (p + 4 <= data.length) {
      const nlen =
        ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0
      p += 4
      if (nlen <= 0 || p + nlen > data.length) break
      const nal = data.subarray(p, p + nlen)
      p += nlen
      if (nal.length > 2 && (nal[0] & 0x1f) === 6) this.handleSei(nal)
    }
  }

  /** SEI RBSP：payload_type 与 payload_size 均为 0xFF 终止的扩展编码 */
  private handleSei(nal: Uint8Array): void {
    let i = 1
    let type = 0
    while (i < nal.length && nal[i] === 0xff) {
      type += 255
      i++
    }
    if (i >= nal.length) return
    type += nal[i++]
    let size = 0
    while (i < nal.length && nal[i] === 0xff) {
      size += 255
      i++
    }
    if (i >= nal.length) return
    size += nal[i++]
    if (type !== SEI_PAYLOAD_TYPE || size < 8 || i + size > nal.length) return
    let text: string
    try {
      text = new TextDecoder('utf-8').decode(nal.subarray(i, i + size))
    } catch {
      return
    }
    this.handleSeiText(text)
  }

  private handleSeiText(text: string): void {
    // 外层文本可能带包裹，取首个 '{' 到最后一个 '}'（网页 KR 解析同款容错）
    const a = text.indexOf('{')
    if (a < 0) return
    const b = text.lastIndexOf('}') + 1
    if (b <= a) return
    let outer: { app_data?: unknown }
    try {
      outer = JSON.parse(text.slice(a, b))
    } catch {
      return
    }
    const raw = typeof outer?.app_data === 'string' ? outer.app_data : null
    if (!raw) return
    let app: {
      ver?: number
      canvas?: { width?: number; height?: number }
      mix_grids?: unknown[]
      grids?: unknown[]
    }
    try {
      app = JSON.parse(raw)
    } catch {
      return
    }
    const grids = Array.isArray(app.mix_grids) && app.mix_grids.length ? app.mix_grids : app.grids
    let x0 = Infinity
    let y0 = Infinity
    let x1 = 0
    let y1 = 0
    let n = 0
    if (Array.isArray(grids)) {
      for (const g of grids as Record<string, unknown>[]) {
        if (!g || g.linkmicUid === 'mock_game_uid') continue
        const gw = Number(g.w)
        const gh = Number(g.h)
        if (!(gw > 0) || !(gh > 0)) continue
        const gx = Number(g.x) || 0
        const gy = Number(g.y) || 0
        x0 = Math.min(x0, gx)
        y0 = Math.min(y0, gy)
        x1 = Math.max(x1, gx + gw)
        y1 = Math.max(y1, gy + gh)
        n++
      }
    }
    const bounds =
      n > 0
        ? {
            x: Math.max(0, x0),
            y: Math.max(0, y0),
            w: Math.min(1, x1 - x0),
            h: Math.min(1, y1 - y0)
          }
        : { x: 0, y: 0, w: 1, h: 1 }
    this.onLayout({
      ver: Number(app.ver) || 0,
      canvasW: Number(app.canvas?.width) || 0,
      canvasH: Number(app.canvas?.height) || 0,
      bounds
    })
  }
}

/** FLV 字节旁路消费者：连接为一次 HTTP 响应（重连 = 新连接新 id） */
export interface FlvTapConsumer {
  onConnStart?(id: number): void
  onChunk?(id: number, chunk: Uint8Array): void
  onConnEnd?(id: number): void
}

interface TapEntry {
  consumers: Set<FlvTapConsumer>
  /** 尚未送达 end 的连接 id：消费者提前退订时需向其补发（见 subscribeFlvBytes） */
  open: Set<number>
}

let installed: { original: typeof fetch } | null = null
let connSeq = 0
/** key: 去查询串的 URL；多个窗口/房间可同时各 tap 各的流 */
const taps = new Map<string, TapEntry>()

function installPatch(): void {
  if (installed) return
  const original = window.fetch
  const wrapped: typeof fetch = async (input, init) => {
    const res = await original.call(window, input, init)
    try {
      const req = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const entry = taps.get(req.split('?')[0])
      if (!entry || !res.body || entry.consumers.size === 0) return res
      const [main, side] = res.body.tee()
      const id = ++connSeq
      entry.open.add(id)
      for (const c of [...entry.consumers]) {
        try {
          c.onConnStart?.(id)
        } catch {}
      }
      void pump(side, id, entry)
      return new Response(main, { status: res.status, statusText: res.statusText, headers: res.headers })
    } catch {
      return res
    }
  }
  window.fetch = wrapped
  installed = { original }
}

function uninstallIfIdle(): void {
  if (installed && taps.size === 0) {
    window.fetch = installed.original
    installed = null
  }
}

async function pump(stream: ReadableStream<Uint8Array>, id: number, entry: TapEntry): Promise<void> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !value) break
      for (const c of [...entry.consumers]) {
        try {
          c.onChunk?.(id, value)
        } catch {}
      }
    }
  } catch {
    // 播放器取消/中断属正常，旁路随流结束
  }
  entry.open.delete(id)
  for (const c of [...entry.consumers]) {
    try {
      c.onConnEnd?.(id)
    } catch {}
  }
}

/**
 * 订阅指定 URL 拉流连接的原始字节（同 URL 可多次重连，以连接 id 区分）。
 * 退订时若仍有存活的连接（播放器销毁/切源会先同步退订，连接的异步结束
 * 事件随后才到），会先向退订者补发这些连接的 onConnEnd——录制侧依赖该
 * 事件触发分段收尾，不能丢。
 * 返回退订函数；最后一个订阅退订后自动还原 fetch。
 */
export function subscribeFlvBytes(url: string, consumer: FlvTapConsumer): () => void {
  const plain = url.split('?')[0]
  let entry = taps.get(plain)
  if (!entry) {
    entry = { consumers: new Set(), open: new Set() }
    taps.set(plain, entry)
  }
  entry.consumers.add(consumer)
  installPatch()
  return () => {
    const e = taps.get(plain)
    if (!e || !e.consumers.delete(consumer)) return
    for (const id of [...e.open]) {
      try {
        consumer.onConnEnd?.(id)
      } catch {}
    }
    if (e.consumers.size === 0) taps.delete(plain)
    uninstallIfIdle()
  }
}

/** 创建增量解析器（独立导出，便于无 DOM 环境测试） */
export function createFlvSeiParser(onLayout: (l: SeiLayout) => void): FlvSeiParserLike {
  return new FlvSeiParser(onLayout)
}

/**
 * 安装 FLV 拉流的 fetch 旁路（SEI 解析专用；录制走 subscribeFlvBytes）。
 * 主路字节经 tee 原样交给调用方（mpegts.js），旁路增量解析 SEI 布局。
 */
export function tapFlvSei(url: string, onLayout: (l: SeiLayout) => void): FlvSeiTap {
  const parser = createFlvSeiParser(onLayout)
  const off = subscribeFlvBytes(url, { onChunk: (_id, chunk) => parser.feed(chunk) })
  return { dispose: off }
}
