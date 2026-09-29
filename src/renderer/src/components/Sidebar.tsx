import { useEffect, useRef, useState } from 'react'
import type { LiveItem, ProfileInfo, Settings } from '@shared/types'
import { formatCount, formatRemaining } from '../lib/format'
import { IconAlert, IconLive, IconLogo, IconLogout, IconRefresh, IconSettings, IconUsers } from './Icons'

export interface SidebarProps {
  profile: ProfileInfo | null
  items: LiveItem[]
  hasMore: boolean
  total: number
  updatedAt: number
  nextAutoAt: number
  phase: 'loading' | 'ready' | 'error'
  errorMsg: string
  loadingMore: boolean
  refreshing: boolean
  blockedUntil: number
  blockedReason: string
  selectedSecUid?: string
  settings: Settings
  onSelect: (item: LiveItem) => void
  onReachBottom: () => void
  onRefresh: () => void
  onIntervalChange: (sec: number) => void
  onLogout: () => void
}

const INTERVAL_OPTIONS = [
  { label: '3 分钟', value: 180 },
  { label: '5 分钟', value: 300 },
  { label: '10 分钟', value: 600 },
  { label: '15 分钟', value: 900 }
]

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function Sidebar(p: SidebarProps) {
  const now = useNow(1000)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const lastHitRef = useRef(0)

  // 滚动到底部时触发加载更多（带节流）
  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 140) {
      const now = Date.now()
      if (now - lastHitRef.current > 1200) {
        lastHitRef.current = now
        p.onReachBottom()
      }
    }
  }

  const intervalLabel = INTERVAL_OPTIONS.find((o) => o.value === p.settings.refreshIntervalSec)?.label ?? `${Math.round(p.settings.refreshIntervalSec / 60)} 分钟`

  return (
    <aside className="sidebar">
      <header className="side-head">
        <div className="me">
          <div className="me-avatar">
            {p.profile?.avatarUrl ? (
              <img src={p.profile.avatarUrl} alt="" referrerPolicy="no-referrer" />
            ) : (
              <IconLogo size={22} />
            )}
          </div>
          <div className="me-name" title={p.profile?.nickname}>
            {p.profile?.nickname || '已登录'}
          </div>
        </div>
        <div className="head-actions">
          <button
            className={`icon-btn ${p.refreshing ? 'spin' : ''}`}
            title={p.refreshing ? '刷新中…' : '立即刷新（有间隔限制）'}
            onClick={p.onRefresh}
            disabled={p.refreshing}
          >
            <IconRefresh />
          </button>
          <div className="menu-anchor">
            <button className="icon-btn" title="设置" onClick={() => setMenuOpen((v) => !v)}>
              <IconSettings />
            </button>
            {menuOpen && (
              <>
                <div className="menu-mask" onClick={() => setMenuOpen(false)} />
                <div className="menu">
                  <div className="menu-title">自动刷新间隔</div>
                  <div className="interval-row">
                    {INTERVAL_OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        className={`interval-opt ${p.settings.refreshIntervalSec === o.value ? 'active' : ''}`}
                        onClick={() => p.onIntervalChange(o.value)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <div className="menu-divider" />
                  {confirmLogout ? (
                    <div className="logout-confirm">
                      <span>退出登录？</span>
                      <button className="btn-danger" onClick={p.onLogout}>
                        退出
                      </button>
                      <button onClick={() => setConfirmLogout(false)}>取消</button>
                    </div>
                  ) : (
                    <button className="menu-logout" onClick={() => setConfirmLogout(true)}>
                      <IconLogout /> 退出登录
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="side-status">
        <span className="live-count">
          <IconLive size={7} /> 正在直播 {p.total > 0 ? p.total : p.items.length}
        </span>
        {p.blockedUntil > now ? (
          <span className="auto-next warn" title={p.blockedReason}>
            请求受限 {formatRemaining(p.blockedUntil - now)}
          </span>
        ) : (
          p.phase === 'ready' && (
            <span className="auto-next">
              自动刷新 {intervalLabel} · {formatRemaining((p.nextAutoAt || 0) - now)}
            </span>
          )
        )}
      </div>

      <div className="side-list" ref={listRef} onScroll={onScroll}>
        {p.phase === 'loading' && p.items.length === 0 && (
          <>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="card skeleton" />
            ))}
          </>
        )}
        {p.phase === 'error' && p.items.length === 0 && (
          <div className="list-error">
            <IconAlert size={22} />
            <p>{p.errorMsg || '列表加载失败'}</p>
            <button className="btn-ghost" onClick={p.onRefresh}>
              重试
            </button>
          </div>
        )}
        {p.phase === 'ready' && p.items.length === 0 && (
          <div className="list-empty">
            <p>暂无正在直播的主播</p>
            <p className="dim">下播的主播开播后会自动出现</p>
          </div>
        )}
        {p.items.map((it) => (
          <button
            key={it.secUid}
            className={`card ${p.selectedSecUid === it.secUid ? 'active' : ''}`}
            onClick={() => p.onSelect(it)}
          >
            <div className="card-cover">
              {it.coverUrl ? (
                <img src={it.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                <div className="cover-fallback" />
              )}
              <span className="card-badge">
                <IconLive size={6} /> LIVE
              </span>
              {typeof it.viewerCount === 'number' && (
                <span className="card-viewers">
                  <IconUsers /> {formatCount(it.viewerCount)}
                </span>
              )}
            </div>
            <div className="card-meta">
              <img className="card-avatar" src={it.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
              <div className="card-text">
                <div className="card-name" title={it.nickname}>
                  {it.nickname}
                </div>
                <div className="card-title" title={it.title}>
                  {it.title || '直播中'}
                </div>
              </div>
            </div>
          </button>
        ))}
        {(p.items.length > 0 || p.phase === 'ready') && (
          <div className="list-foot">
            {p.loadingMore ? (
              <span className="foot-loading">加载中…</span>
            ) : p.hasMore ? (
              <span className="dim">下滑加载更多</span>
            ) : (
              p.phase === 'ready' && <span className="dim">已全部加载</span>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
