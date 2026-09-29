import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { CachedList, LiveItem, ProfileInfo, Settings } from '@shared/types'
import { debounce } from './util'

export interface WindowBounds {
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface StoreShape {
  v: 1
  settings: Settings
  cache: {
    list?: CachedList | null
    profile?: ProfileInfo | null
  }
  window?: WindowBounds
}

const DEFAULTS: StoreShape = {
  v: 1,
  settings: { refreshIntervalSec: 300, volume: 0.8, muted: false },
  cache: {},
  window: { width: 1280, height: 820 }
}

/** 轻量 JSON 持久化（原子写 + 防抖保存），存于 userData/store.json */
class AppStore {
  private data: StoreShape = structuredClone(DEFAULTS)
  private file = ''
  private saveNow = false

  load(): void {
    try {
      this.file = path.join(app.getPath('userData'), 'store.json')
    } catch {
      return // app 未 ready 时 getPath 可能失败，此时保持默认
    }
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<StoreShape>
        this.data = {
          ...structuredClone(DEFAULTS),
          ...raw,
          settings: { ...DEFAULTS.settings, ...(raw.settings ?? {}) },
          cache: { ...(raw.cache ?? {}) },
          window: { ...DEFAULTS.window, ...(raw.window ?? {}) }
        }
      }
    } catch (e) {
      // 文件损坏时备份并重置
      try {
        fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now())
      } catch {}
      this.data = structuredClone(DEFAULTS)
      console.warn('[store] 读取失败，已重置:', e)
    }
  }

  get(): StoreShape {
    return this.data
  }

  patch(p: Partial<Pick<StoreShape, 'settings' | 'window'>> & { cache?: StoreShape['cache'] }): void {
    if (p.settings) this.data.settings = { ...this.data.settings, ...p.settings }
    if (p.window) this.data.window = { ...this.data.window, ...p.window }
    if (p.cache) this.data.cache = { ...this.data.cache, ...p.cache }
    this.scheduleSave()
  }

  private scheduleSave = debounce(() => this.flush(), 500)

  flush(): void {
    if (!this.file || this.saveNow) return
    this.saveNow = true
    try {
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      fs.renameSync(tmp, this.file)
    } catch (e) {
      console.warn('[store] 保存失败:', e)
    } finally {
      this.saveNow = false
    }
  }
}

export const store = new AppStore()
