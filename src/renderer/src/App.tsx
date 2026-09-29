import { useCallback, useEffect, useRef, useState } from 'react'
import type { LiveItem, ListResult, ProfileInfo, Settings } from '@shared/types'
import { api } from './lib/dy'
import { formatClock } from './lib/format'
import { LoginGate } from './components/LoginGate'
import { Sidebar } from './components/Sidebar'
import { PlayerPane } from './components/PlayerPane'
import { IconLogo } from './components/Icons'

const DEFAULT_SETTINGS: Settings = { refreshIntervalSec: 300, volume: 0.8, muted: false }

export default function App() {
  const [auth, setAuth] = useState<{ status: 'checking' | 'out' | 'in'; profile: ProfileInfo | null }>({
    status: 'checking',
    profile: null
  })

  useEffect(() => {
    void api.authGetState().then((s) => setAuth({ status: s.loggedIn ? 'in' : 'out', profile: s.profile }))
    const off = api.onAuthChanged((e) =>
      setAuth(e.loggedIn ? { status: 'in', profile: e.profile } : { status: 'out', profile: null })
    )
    return off
  }, [])

  if (auth.status === 'checking') {
    return (
      <div className="splash">
        <IconLogo size={40} />
        <div className="spinner" />
      </div>
    )
  }
  if (auth.status === 'out') return <LoginGate />
  return <MainLayout profile={auth.profile} />
}

function MainLayout(props: { profile: ProfileInfo | null }) {
  const [items, setItems] = useState<LiveItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [blocked, setBlocked] = useState<{ until: number; reason: string } | null>(null)
  const [selected, setSelected] = useState<LiveItem | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  // 首次列表加载未完成前不进入"空态"（显示骨架而非"暂无正在直播"）
  const [booted, setBooted] = useState(false)
  const manualAt = useRef(0)
  const settingsTimer = useRef<number | undefined>(undefined)

  const applyList = useCallback((d: ListResult): void => {
    setItems(d.items)
    setHasMore(d.hasMore)
    setTotal(d.total)
    setUpdatedAt(d.updatedAt)
    setPhase('ready')
    setErrorMsg('')
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    const r = await api.listLoad()
    setRefreshing(false)
    setBooted(true)
    if (!r.ok) {
      setErrorMsg(r.message)
      setPhase((prev) => (prev === 'ready' ? 'ready' : 'error'))
      return
    }
    applyList(r.data)
  }, [applyList])

  useEffect(() => {
    void api.settingsGet().then(setSettings)
    // 先用本地缓存即时渲染，再拉最新
    void api.listGetCached().then((r) => {
      if (r.ok && r.data?.items?.length) {
        setItems(r.data.items)
        setUpdatedAt(r.data.at)
        setPhase('ready')
      }
    })
    void reload()
    const offs = [
      api.onListAutoUpdated(applyList),
      api.onNetBlocked((e) => setBlocked(e)),
      api.onNetRecovered(() => setBlocked(null))
    ]
    return () => offs.forEach((f) => f())
  }, [reload, applyList])

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    const r = await api.listLoadMore()
    setLoadingMore(false)
    if (r.ok) applyList(r.data)
  }, [loadingMore, hasMore, applyList])

  const manualRefresh = useCallback((): void => {
    const now = Date.now()
    if (now - manualAt.current < 30_000 || refreshing) return
    manualAt.current = now
    setRefreshing(true)
    void api.listRefresh().then((r) => {
      setRefreshing(false)
      if (r.ok) applyList(r.data)
    })
  }, [refreshing, applyList])

  const persistSettings = useCallback((patch: Partial<Settings>): void => {
    setSettings((s) => {
      const next = { ...s, ...patch }
      clearTimeout(settingsTimer.current)
      settingsTimer.current = window.setTimeout(() => void api.settingsSet(patch), 600)
      return next
    })
  }, [])

  const onLogout = useCallback((): void => {
    setSelected(null)
    void api.logout()
  }, [])

  return (
    <div className="app-shell">
      <Sidebar
        profile={props.profile}
        items={items}
        hasMore={hasMore}
        total={total}
        updatedAt={updatedAt}
        phase={!booted && phase === 'ready' && items.length === 0 ? 'loading' : phase}
        errorMsg={errorMsg}
        loadingMore={loadingMore}
        refreshing={refreshing}
        blockedUntil={blocked?.until ?? 0}
        blockedReason={blocked?.reason ?? ''}
        selectedSecUid={selected?.secUid}
        settings={settings}
        onSelect={setSelected}
        onReachBottom={() => void loadMore()}
        onRefresh={() => (phase === 'error' ? void reload() : manualRefresh())}
        onIntervalChange={(sec) => persistSettings({ refreshIntervalSec: sec })}
        onLogout={onLogout}
      />
      <main className="main-pane">
        {selected ? (
          <PlayerPane
            key={`${selected.roomId}:${selected.secUid}`}
            item={selected}
            volume={settings.volume}
            muted={settings.muted}
            onVolume={(v) => persistSettings({ volume: v })}
            onMuted={(m) => persistSettings({ muted: m })}
          />
        ) : (
          <div className="pane-empty">
            <IconLogo size={56} />
            <h2>选择一个正在直播的主播</h2>
            <p>左侧为「关注」中正在直播的列表 · 点击即可在右侧观看</p>
            {updatedAt > 0 && <p className="dim">列表更新于 {formatClock(updatedAt)} · 定时自动刷新</p>}
          </div>
        )}
      </main>
    </div>
  )
}
