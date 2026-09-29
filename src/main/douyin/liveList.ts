import type { ListResult, LiveItem } from '@shared/types'
import { IPC } from '@shared/ipc'
import type { DouyinApi } from './api'
import { LIST_PAGE_SIZE } from './api'
import { clamp, log } from '../util'

/** 自动刷新时最多回拉的页数（限制单轮请求量，防风控） */
const REFRESH_PAGE_CAP = 5

export interface LiveListDeps {
  api: DouyinApi
  store: StoreLike
  isLoggedIn: () => boolean
  broadcast: (channel: string, payload: unknown) => void
}

interface StoreLike {
  get(): { settings: { refreshIntervalSec: number }; cache: { list?: any } }
  patch(p: { cache?: any }): void
}

/** 关注直播列表：分页拉取、懒加载合并、定时自动刷新（带抖动） */
export class LiveListService {
  private items: LiveItem[] = []
  private hasMore = false
  private total = 0
  private nextOffset = 0
  private updatedAt = 0
  private loading = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private nextAutoAt = 0
  private stopped = true

  constructor(private deps: LiveListDeps) {}

  start(): void {
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
  }

  rearm(): void {
    clearTimeout(this.timer)
    if (!this.stopped) this.arm()
  }

  private arm(): void {
    const sec = clamp(this.deps.store.get().settings.refreshIntervalSec, 120, 1800)
    const delay = sec * 1000 + Math.random() * 15_000
    this.nextAutoAt = Date.now() + delay
    this.deps.broadcast(IPC.EvNextRefresh, { at: this.nextAutoAt })
    this.timer = setTimeout(() => {
      void this.autoTick().finally(() => {
        if (!this.stopped) this.arm()
      })
    }, delay)
  }

  private async autoTick(): Promise<void> {
    if (!this.deps.isLoggedIn()) return
    try {
      await this.refresh(false)
    } catch (e) {
      log('liveList', '自动刷新失败:', (e as Error)?.message)
    }
  }

  /** 首次加载：重置后拉取第一页 */
  async initial(): Promise<ListResult> {
    this.reset()
    return this.refresh(true)
  }

  async loadMore(): Promise<ListResult> {
    if (this.loading || !this.hasMore) return this.snapshot()
    this.loading = true
    try {
      const r = await this.deps.api.fetchFollowLivePage(this.nextOffset)
      const known = new Set(this.items.map((i) => i.secUid))
      for (const it of r.items) {
        if (!known.has(it.secUid)) {
          this.items.push(it)
          known.add(it.secUid)
        }
      }
      this.hasMore = r.hasMore && r.items.length > 0
      this.total = r.total || this.total
      this.nextOffset = r.nextOffset
      this.updatedAt = Date.now()
      this.persistCache()
      return this.snapshot()
    } finally {
      this.loading = false
    }
  }

  /** 刷新：覆盖已加载的页数（封顶 REFRESH_PAGE_CAP 页），manual=true 由用户触发 */
  async refresh(manual: boolean): Promise<ListResult> {
    if (this.loading) return this.snapshot()
    this.loading = true
    try {
      const pages = Math.min(REFRESH_PAGE_CAP, Math.max(1, Math.ceil(this.items.length / LIST_PAGE_SIZE) || 1))
      let offset = 0
      const collected: LiveItem[] = []
      let hasMore = false
      let total = 0
      for (let p = 0; p < pages; p++) {
        const r = await this.deps.api.fetchFollowLivePage(offset)
        const known = new Set(collected.map((i) => i.secUid))
        for (const it of r.items) if (!known.has(it.secUid)) collected.push(it)
        hasMore = r.hasMore
        total = r.total
        offset = r.nextOffset
        if (!hasMore) break
      }
      this.items = collected
      this.hasMore = hasMore
      this.total = total
      this.nextOffset = offset
      this.updatedAt = Date.now()
      this.persistCache()
      if (!manual) this.deps.broadcast(IPC.EvListAutoUpdated, this.snapshot())
      return this.snapshot()
    } finally {
      this.loading = false
    }
  }

  snapshot(): ListResult {
    return {
      items: this.items,
      hasMore: this.hasMore,
      total: this.total,
      updatedAt: this.updatedAt,
      nextAutoAt: this.nextAutoAt
    }
  }

  reset(): void {
    this.items = []
    this.hasMore = false
    this.total = 0
    this.nextOffset = 0
    this.updatedAt = 0
  }

  private persistCache(): void {
    this.deps.store.patch({ cache: { list: { items: this.items.slice(0, 75), at: Date.now() } } })
  }
}
