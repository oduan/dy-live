/** 主进程通用小工具 */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = 'timeout'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function debounce<F extends (...args: any[]) => void>(fn: F, ms: number): F {
  let t: ReturnType<typeof setTimeout> | undefined
  const wrapped = (...args: Parameters<F>) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
  return wrapped as F
}

export function log(tag: string, ...args: any[]): void {
  console.log(`[${tag}]`, ...args)
}

/** 从各种可能的字段形态里取出第一个 http(s) 图片地址 */
export function firstUrl(...cands: any[]): string {
  for (const c of cands) {
    if (!c) continue
    if (typeof c === 'string' && c.startsWith('http')) return c
    const list = c?.url_list ?? c?.uri_list
    if (Array.isArray(list)) {
      const hit = list.find((x: any) => typeof x === 'string' && x.startsWith('http'))
      if (hit) return hit
    }
  }
  return ''
}

/** 12345 -> "1.2万" */
export function formatCount(n?: number): string {
  if (typeof n !== 'number' || Number.isNaN(n)) return ''
  if (n < 10000) return String(n)
  const w = n / 10000
  const s = w >= 100 ? w.toFixed(0) : w >= 10 ? w.toFixed(1) : w.toFixed(1)
  return `${s.replace(/\.0$/, '')}万`
}
