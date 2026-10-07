/**
 * FLV 字节收集器：消费播放器拉流连接的原始字节（经 flvSei.ts 的 fetch tee 旁路），
 * 为「源流直录」提供任意时刻可立即起录的数据。快照由两部分组成，拼接后即一段
 * 完整可解码的 FLV 字节流：
 *   header —— FLV 文件头起、至首个视频关键帧 tag 之前的全部字节
 *             （含 onMetaData 与 AVC/AAC sequence header；纯音频流为首个音频帧前）
 *   tail   —— 最近一个关键帧 tag 起、至当前流位置的全部字节
 *             （纯音频流为 header 之后的全部字节；AAC 无帧间依赖，任意 tag 边界可起）
 * 起录后实时字节紧接快照尾部转发，与流位置无缝无重。快照与转发都发生在
 * onChunk 同步调用之间，天然无竞态。
 */

export interface FlvSnapshot {
  /** 快照所属连接 id；实时转发必须来自同一连接 */
  connId: number
  header: Uint8Array
  tail: Uint8Array
  /** 当前连接存活、FLV 头已到达且未失步（起录前提） */
  ready: boolean
}

/** 尾部窗口上限：超出后丢弃到下个关键帧（起录处解码器需跳帧数秒，正常 GOP 远小于此） */
const RING_MAX = 12 * 1024 * 1024
/** 纯音频流尾部窗口上限（任意 tag 边界都可干净起录，无需等关键帧） */
const RING_SOFT = 2 * 1024 * 1024
/** 首个关键帧迟迟不到的保护上限（异常流；超过即放弃本连接的直录资格） */
const PHASE1_MAX = 16 * 1024 * 1024
/** 单个 tag 的合理上限，超过视为失步（字节连续性无法保证） */
const MAX_TAG_SIZE = 4_000_000

interface Chunk {
  off: number
  data: Uint8Array
}

interface TagInfo {
  keyframe: boolean
  audioSeq: boolean
  audioData: boolean
}

export class FlvByteCollector {
  /** 字节流失步（连续性被破坏）时回调，录制侧应收尾当前段 */
  onCorrupt: (() => void) | null = null

  private connId = 0
  private connOpen = false
  private flvHeader = false
  private dead = false

  /** true = 尚在收集 header（未遇到首个关键帧/音频帧） */
  private phase1 = true
  private audioOnly = false
  private seenVideo = false
  private audioSeqSeen = false
  /** 封口后的 header 字节（一次性拷贝，起录时直接用） */
  private headerBytes: Uint8Array | null = null

  /** 保留窗口 [windowStart..connLen)：phase1 为整条连接，之后为最近关键帧起 */
  private chunks: Chunk[] = []
  private windowStart = 0
  private connLen = 0
  /** 窗口是否起自解码干净边界（关键帧 tag / 音频任意 tag） */
  private ringValid = true

  // —— tag 边界扫描缓冲（只做分析，与字节保留窗口分离）——
  private buf = new Uint8Array(256 * 1024)
  private blen = 0
  private bpos = 0
  /** buf[0] 对应的连接内绝对偏移 */
  private scanned = 0

  reset(): void {
    this.connStart(0)
    this.connOpen = false
  }

  connStart(id: number): void {
    this.connId = id
    this.connOpen = true
    this.flvHeader = false
    this.dead = false
    this.phase1 = true
    this.audioOnly = false
    this.seenVideo = false
    this.audioSeqSeen = false
    this.headerBytes = null
    this.chunks = []
    this.windowStart = 0
    this.connLen = 0
    this.blen = 0
    this.bpos = 0
    this.scanned = 0
  }

  connEnd(id: number): void {
    if (id === this.connId) this.connOpen = false
  }

  isOpen(id: number): boolean {
    return id === this.connId && this.connOpen && !this.dead
  }

  ready(): boolean {
    return this.connOpen && this.flvHeader && !this.dead && this.connLen > 0
  }

  /** 同步喂入：先记账后扫描，保证窗口与流位置一致 */
  feed(id: number, chunk: Uint8Array): void {
    if (id !== this.connId || this.dead || !chunk.length) return
    this.chunks.push({ off: this.connLen, data: chunk })
    this.connLen += chunk.length
    this.scanChunk(chunk)
    if (!this.dead && this.phase1 && this.connLen > PHASE1_MAX) this.kill()
  }

  snapshot(): FlvSnapshot {
    return {
      connId: this.connId,
      header: this.headerBytes ?? this.concat(0),
      tail: this.phase1 ? new Uint8Array(0) : this.concat(this.windowStart),
      ready: this.ready()
    }
  }

  private kill(): void {
    this.dead = true
    this.chunks = []
    this.blen = 0
    this.bpos = 0
    if (this.onCorrupt) this.onCorrupt()
  }

  private concat(from: number, to = this.connLen): Uint8Array {
    const out = new Uint8Array(Math.max(0, to - from))
    let p = 0
    for (const c of this.chunks) {
      const s = Math.max(c.off, from)
      const e = Math.min(c.off + c.data.length, to)
      if (e > s) {
        out.set(c.data.subarray(s - c.off, e - c.off), p)
        p += e - s
      }
    }
    return out
  }

  /** 重定位保留窗口起点并裁掉之前的数据（straddler 切片） */
  private moveTo(abs: number, clean: boolean): void {
    this.windowStart = abs
    this.ringValid = clean
    this.trim()
  }

  private trim(): void {
    while (this.chunks.length) {
      const c = this.chunks[0]
      const cend = c.off + c.data.length
      if (cend <= this.windowStart) {
        this.chunks.shift()
        continue
      }
      if (c.off < this.windowStart) {
        this.chunks[0] = { off: this.windowStart, data: c.data.subarray(this.windowStart - c.off) }
      }
      break
    }
  }

  // ---------- tag 边界扫描 ----------

  private scanChunk(chunk: Uint8Array): void {
    const avail = this.blen - this.bpos
    if (avail + chunk.length > this.buf.length) {
      const nb = new Uint8Array(Math.max(avail + chunk.length, this.buf.length * 2))
      nb.set(this.buf.subarray(this.bpos, this.blen))
      this.buf = nb
    } else if (this.bpos > 0) {
      this.buf.copyWithin(0, this.bpos, this.blen)
    }
    this.buf.set(chunk, avail)
    this.blen = avail + chunk.length
    this.bpos = 0
    this.process()
  }

  private process(): void {
    if (!this.flvHeader) {
      if (this.blen - this.bpos < 13) return
      if (this.buf[this.bpos] !== 0x46 || this.buf[this.bpos + 1] !== 0x4c || this.buf[this.bpos + 2] !== 0x56) {
        this.kill()
        return
      }
      // 'FLV' 头 9 字节 + 首个 PreviousTagSize0 4 字节
      this.bpos += 13
      this.flvHeader = true
    }
    for (;;) {
      const rem = this.blen - this.bpos
      if (rem < 11) break
      const type = this.buf[this.bpos]
      const size = (this.buf[this.bpos + 1] << 16) | (this.buf[this.bpos + 2] << 8) | this.buf[this.bpos + 3]
      if (size > MAX_TAG_SIZE) {
        this.kill()
        return
      }
      const total = 11 + size + 4
      if (rem < total) break
      const info = this.classify(type, size)
      this.handleTagStart(this.scanned + this.bpos, info)
      if (this.dead) return
      this.bpos += total
    }
    if (this.bpos > 0) {
      this.buf.copyWithin(0, this.bpos, this.blen)
      this.scanned += this.bpos
      this.blen -= this.bpos
      this.bpos = 0
    }
  }

  /** tag 分类只需数据前 2 字节：视频 1B(FrameType|CodecID)+1B(AVCPacketType)，音频 1B(Format|…)+1B(AACPacketType) */
  private classify(type: number, size: number): TagInfo {
    if (size < 2) return { keyframe: false, audioSeq: false, audioData: false }
    const d0 = this.buf[this.bpos + 11]
    const d1 = this.buf[this.bpos + 12]
    if (type === 9) {
      this.seenVideo = true
      return {
        keyframe: (d0 & 0x0f) === 7 && d0 >> 4 === 1 && d1 === 1,
        audioSeq: false,
        audioData: false
      }
    }
    if (type === 8 && d0 >> 4 === 10) {
      return { keyframe: false, audioSeq: d1 === 0, audioData: d1 === 1 }
    }
    return { keyframe: false, audioSeq: false, audioData: false }
  }

  private handleTagStart(abs: number, info: TagInfo): void {
    if (this.phase1) {
      if (info.audioSeq) this.audioSeqSeen = true
      // 头部封口：关键帧起（常规）或音频帧起（纯音频流，无关键帧可等）
      if (info.keyframe || (info.audioData && this.audioSeqSeen && !this.seenVideo)) {
        this.headerBytes = this.concat(0, abs)
        this.audioOnly = !info.keyframe
        this.phase1 = false
        this.moveTo(abs, true)
      }
      return
    }
    if (info.keyframe) {
      this.moveTo(abs, true)
      return
    }
    const win = this.connLen - this.windowStart
    if (win > RING_MAX || (this.audioOnly && win > RING_SOFT)) {
      // 超限丢弃：视频等下个关键帧再恢复干净起点，音频任意 tag 边界仍干净
      this.moveTo(abs, this.audioOnly)
    }
  }
}
