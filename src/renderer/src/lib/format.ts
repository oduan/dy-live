/** 展示格式化 */

export function formatCount(n?: number): string {
  if (typeof n !== 'number' || Number.isNaN(n)) return ''
  if (n < 10000) return String(n)
  const w = n / 10000
  return `${w >= 100 ? w.toFixed(0) : w.toFixed(1).replace(/\.0$/, '')}万`
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return '即将刷新'
  const s = Math.ceil(ms / 1000)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
