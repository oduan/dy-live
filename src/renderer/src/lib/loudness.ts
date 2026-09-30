/**
 * 响度自动平衡（直播间响度归一化）
 *
 * 问题：不同直播间推流响度差距可达 10dB 以上，切房需要反复调系统音量。
 * 方案：ITU-R BS.1770 / EBU R128 的 K 加权响度测量 + 纯增益拉齐 ——
 * - 测量支路：两级 IIR（high-shelf +4dB@1.68kHz、高通 38Hz）逼近 BS.1770 K 加权，
 *   每 100ms 算一帧均方能量得到瞬时响度（LUFS）；经绝对门（-70 LUFS）与相对门
 *   （低于长期积分响度 10LU 的帧不计入，静音/底噪不参与）后平滑为短期响度
 * - 控制支路：增益 = 目标响度(-16 LUFS) − 短期响度，限制在 [-30, +15]dB；
 *   压低快（30dB/s，房间突然变响时快速保护耳朵）、抬升慢（6dB/s，不把底噪泵起来），
 *   再经 setTargetAtTime 平滑
 * - 输出串一级 DynamicsCompressor 仅作峰值保护（threshold -2dB，平时不介入），
 *   防止提升安静房间时偶发峰值削波
 *
 * 全程只动增益，不压缩动态、不改频响 → 音质无损；用户音量（video.volume）
 * 作用在测量之前，通过补偿还原源响度，因此应用内音量条仍然独立有效。
 */

const TARGET_LUFS = -16
const MAX_BOOST_DB = 15
const MAX_CUT_DB = -30
const ABSOLUTE_GATE_LUFS = -70
const RELATIVE_GATE_LU = 10
/** 增益压低/抬升速率（dB/s）：不对称，快切慢抬 */
const SLEW_DOWN_DB_PER_S = 30
const SLEW_UP_DB_PER_S = 6
const SHORT_TERM_TAU_S = 1.0
const INTEGRATED_TAU_S = 10
const TICK_MS = 100
const GAIN_UPDATE_EVERY_S = 0.25
/** 至少累计这么多有效帧，才把响度写入跨房间记忆（避免刚进房误存） */
const STABLE_TICKS = 15

/** roomId -> 最近稳定短期响度（LUFS）。模块级：PlayerPane 按房间重建，切房记忆在这里续存 */
const roomLoudness = new Map<string, number>()
const ROOM_MEMORY_MAX = 200

const dbToLin = (db: number): number => Math.pow(10, db / 20)

/** ITU-R BS.1770-4 K 加权两级 biquad 系数（与 pyloudnorm 同源公式，支持任意采样率） */
function kWeightingStages(fs: number): { ff: [number, number, number]; fb: [number, number, number] }[] {
  // 第一级：high shelf +4dB @ 1.68kHz（预抬高频，补偿头腔增益）
  const G = 3.999843853973347
  const Q1 = 0.7071752369554196
  const fc1 = 1681.974450955533
  const K1 = Math.tan((Math.PI * fc1) / fs)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  const a01 = 1 + K1 / Q1 + K1 * K1
  const shelf = {
    ff: [
      (Vh + Vb * K1 / Q1 + K1 * K1) / a01,
      (2 * (K1 * K1 - Vh)) / a01,
      (Vh - Vb * K1 / Q1 + K1 * K1) / a01
    ],
    fb: [1, (2 * (K1 * K1 - 1)) / a01, (1 - K1 / Q1 + K1 * K1) / a01]
  } as { ff: [number, number, number]; fb: [number, number, number] }

  // 第二级：38Hz 高通（RLB 加权）
  const Q2 = 0.5003270373238773
  const fc2 = 38.13547087602444
  const K2 = Math.tan((Math.PI * fc2) / fs)
  const a02 = 1 + K2 / Q2 + K2 * K2
  const hp = {
    ff: [1 / a02, -2 / a02, 1 / a02],
    fb: [1, (2 * (K2 * K2 - 1)) / a02, (1 - K2 / Q2 + K2 * K2) / a02]
  } as { ff: [number, number, number]; fb: [number, number, number] }

  return [shelf, hp]
}

export interface LoudnessNormalizerOptions {
  /** 房间 ID：提供后启用跨房间响度记忆（再次进入秒级到位） */
  roomId?: string
  enabled?: boolean
  targetLufs?: number
}

export class LoudnessNormalizer {
  /** 播放源接入点（MediaElementAudioSourceNode 连这里） */
  readonly input: GainNode
  /** 输出（已含归一化增益 + 峰值保护），接可视化/扬声器链路 */
  readonly output: GainNode

  private ctx: AudioContext
  private normGain: GainNode
  /** 应用级增益（设置里的"应用音量"），独立于响度归一化，关掉归一化也生效 */
  private trimGain: GainNode
  private measureAn: AnalyserNode
  /** 与 measureAn.fftSize（固定 8192）一致 */
  private buf = new Float32Array(8192)
  private sink: GainNode
  private tickTimer: number | null = null
  private lastTickAt = 0
  private lastGainAt = 0

  private roomId: string | undefined
  private enabled: boolean
  private targetLufs: number
  /** 测量点之前的元素增益（dB）；null 表示静音/零音量（无信号，保持现状） */
  private srcGainDb: number | null = 0

  private shortTerm: number | null = null
  private integrated: number | null = null
  private appliedDb = 0
  private stableTicks = 0

  constructor(ctx: AudioContext, opts: LoudnessNormalizerOptions = {}) {
    this.ctx = ctx
    this.roomId = opts.roomId
    this.enabled = opts.enabled ?? true
    this.targetLufs = opts.targetLufs ?? TARGET_LUFS

    this.input = ctx.createGain()
    this.normGain = ctx.createGain()
    this.trimGain = ctx.createGain()
    this.output = ctx.createGain()
    const limiter = ctx.createDynamicsCompressor()
    // 仅峰值防护：常态信号低于阈值完全不介入
    limiter.threshold.value = -2
    limiter.knee.value = 6
    limiter.ratio.value = 20
    limiter.attack.value = 0.002
    limiter.release.value = 0.25
    this.input.connect(this.normGain)
    this.normGain.connect(this.trimGain)
    this.trimGain.connect(limiter)
    limiter.connect(this.output)

    // 测量支路：K 加权滤波后只读数据，经零增益汇保证节点被调度，不影响主链路音色
    this.measureAn = ctx.createAnalyser()
    this.measureAn.fftSize = 8192
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    let node: AudioNode = this.input
    for (const stage of kWeightingStages(ctx.sampleRate)) {
      const f = ctx.createIIRFilter(Float32Array.from(stage.ff), Float32Array.from(stage.fb))
      node.connect(f)
      node = f
    }
    node.connect(this.measureAn)
    this.measureAn.connect(this.sink)
    this.sink.connect(ctx.destination)

    // 跨房间记忆：进房即用上次响度预置增益，省去每次进房的重新收敛
    const remembered = this.roomId ? roomLoudness.get(this.roomId) : undefined
    if (remembered !== undefined) {
      this.shortTerm = remembered
      this.integrated = remembered
      this.stableTicks = STABLE_TICKS
      if (this.enabled) {
        this.appliedDb = Math.min(MAX_BOOST_DB, Math.max(MAX_CUT_DB, this.targetLufs - remembered))
        this.normGain.gain.value = dbToLin(this.appliedDb)
      }
    }

    this.tickTimer = window.setInterval(this.tick, TICK_MS)
  }

  /** 元素音量变化时同步（dB）；静音或 0 音量传 null，测量冻结、增益保持 */
  setSourceGainDb(db: number | null): void {
    this.srcGainDb = db
  }

  /** 应用级增益（dB），叠加在归一化之上；带平滑防点击 */
  setTrimDb(db: number): void {
    this.trimGain.gain.setTargetAtTime(dbToLin(db), this.ctx.currentTime, 0.08)
  }

  /** 开关归一化；关闭时增益平滑回到 0dB（直通），测量继续以便随时无缝开启 */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    this.appliedDb = 0
    if (!on) this.normGain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.15)
  }

  /** 当前短期响度（LUFS），未测到时为 null */
  get measuredLufs(): number | null {
    return this.shortTerm
  }

  destroy(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    if (this.roomId && this.shortTerm !== null && this.stableTicks >= STABLE_TICKS) {
      roomLoudness.set(this.roomId, this.shortTerm)
      if (roomLoudness.size > ROOM_MEMORY_MAX) {
        const oldest = roomLoudness.keys().next().value
        if (oldest !== undefined) roomLoudness.delete(oldest)
      }
    }
    try {
      this.input.disconnect()
      this.output.disconnect()
      this.sink.disconnect()
    } catch {}
  }

  private tick = (): void => {
    const now = performance.now()
    const tdt = Math.min(1, Math.max(0.01, (now - this.lastTickAt) / 1000))
    this.lastTickAt = now
    this.measure(tdt)
    const gdt = Math.min(1, Math.max(0.02, (now - this.lastGainAt) / 1000))
    if (now - this.lastGainAt >= GAIN_UPDATE_EVERY_S * 1000) {
      this.lastGainAt = now
      this.applyGain(gdt)
    }
  }

  private measure(dt: number): void {
    if (this.srcGainDb === null) return
    this.measureAn.getFloatTimeDomainData(this.buf)
    let sum = 0
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i]
    const ms = sum / this.buf.length
    if (!(ms > 0)) return
    // 元素音量在 MediaElementSource 之前生效，这里还原为源响度
    const block = -0.691 + 10 * Math.log10(ms) - this.srcGainDb
    // 绝对门：静音/底噪不参与
    if (block < ABSOLUTE_GATE_LUFS) return
    // 相对门：明显低于长期水平的帧（语句间隙、停顿）不参与，防止增益被间隙拉高
    if (this.integrated === null) this.integrated = block
    else this.integrated += (block - this.integrated) * (dt / INTEGRATED_TAU_S)
    if (block < this.integrated - RELATIVE_GATE_LU) return
    if (this.shortTerm === null) this.shortTerm = block
    else this.shortTerm += (block - this.shortTerm) * (dt / SHORT_TERM_TAU_S)
    this.stableTicks++
  }

  private applyGain(dt: number): void {
    if (!this.enabled || this.shortTerm === null) return
    const desired = Math.min(MAX_BOOST_DB, Math.max(MAX_CUT_DB, this.targetLufs - this.shortTerm))
    const lo = this.appliedDb - SLEW_DOWN_DB_PER_S * dt
    const hi = this.appliedDb + SLEW_UP_DB_PER_S * dt
    this.appliedDb = Math.min(hi, Math.max(lo, desired))
    this.normGain.gain.setTargetAtTime(dbToLin(this.appliedDb), this.ctx.currentTime, 0.3)
  }
}
