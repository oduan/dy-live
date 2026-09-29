/**
 * 串行请求队列：节流（最小间隔 + 随机抖动）+ 失败指数退避。
 * 所有对抖音的请求都经过队列，避免触发风控。
 */

export class QueueBlockedError extends Error {
  readonly code = 'QUEUE_BLOCKED'
  constructor(public until: number) {
    super(`接口冷却中，${new Date(until).toLocaleTimeString()} 后自动重试`)
    this.name = 'QueueBlockedError'
  }
}

export class RequestQueue {
  private chain: Promise<unknown> = Promise.resolve()
  private lastAt = 0
  private failures = 0
  blockedUntil = 0

  constructor(
    public readonly name: string,
    private minGapMs: number,
    private jitterMs: number,
    private onBlockedChange?: (q: RequestQueue) => void
  ) {}

  setBlockedListener(fn: (q: RequestQueue) => void): void {
    this.onBlockedChange = fn
  }

  get blocked(): boolean {
    return Date.now() < this.blockedUntil
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(async () => {
      if (Date.now() < this.blockedUntil) throw new QueueBlockedError(this.blockedUntil)
      const wait = this.lastAt + this.minGapMs + Math.random() * this.jitterMs - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      this.lastAt = Date.now()
      try {
        const r = await job()
        this.noteSuccess()
        return r
      } catch (e) {
        if (!(e instanceof QueueBlockedError)) this.noteFailure()
        throw e
      }
    })
    this.chain = next
    return next as Promise<T>
  }

  private noteSuccess(): void {
    if (this.failures > 0 || this.blockedUntil > 0) {
      this.failures = 0
      this.blockedUntil = 0
      this.onBlockedChange?.(this)
    }
  }

  private noteFailure(): void {
    this.failures++
    const backoff = Math.min(60_000 * 2 ** (this.failures - 1), 300_000)
    this.blockedUntil = Date.now() + backoff
    console.warn(`[queue:${this.name}] 第 ${this.failures} 次失败，冷却 ${Math.round(backoff / 1000)}s`)
    this.onBlockedChange?.(this)
  }
}
