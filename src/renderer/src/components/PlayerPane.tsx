import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatItem, LiveItem, RoomEnterResult, RoomInfo, StreamChoice } from '@shared/types'
import { api } from '../lib/dy'
import { ContentCropper } from '../lib/contentCrop'
import { LiveStreamPlayer } from '../lib/player'
import { LoudnessNormalizer } from '../lib/loudness'
import { LiveRecorder } from '../lib/recorder'
import { AudioRing } from './AudioRing'
import {
  IconAlert,
  IconBack,
  IconChat,
  IconExternal,
  IconFullscreen,
  IconHeadphones,
  IconLogo,
  IconMaximize,
  IconMute,
  IconPause,
  IconPlay,
  IconRecord,
  IconRefresh,
  IconTimer,
  IconUsers,
  IconVideo,
  IconVolume
} from './Icons'

type Phase = 'entering' | 'live' | 'ended' | 'error' | 'unsupported'

/** 定时暂停的可选时长（分钟） */
const TIMER_OPTIONS = [15, 30, 60, 90]

interface PaneState {
  phase: Phase
  paused: boolean
  audioOnly: boolean
  info?: RoomInfo
  message?: string
  detail?: string
  code?: string
  recovering: boolean
  toast?: string
}

export interface PlayerPaneProps {
  item: LiveItem
  volume: number
  muted: boolean
  /** 响度自动平衡（各直播间响度拉齐到统一目标） */
  loudnessNorm: boolean
  /** 应用级增益（dB），叠加在归一化之上，系统音量不变时调节应用声音大小 */
  appGainDb: number
  onVolume: (v: number) => void
  onMuted: (m: boolean) => void
  /** 退出直播间（返回列表）；全屏时会先退出全屏 */
  onClose: () => void
}

export function PlayerPane(p: PlayerPaneProps) {
  const { item } = p
  const [st, setSt] = useState<PaneState>({ phase: 'entering', paused: false, audioOnly: false, recovering: false })
  const [viewer, setViewer] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const [uiVisible, setUiVisible] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [sleepAt, setSleepAt] = useState(0)
  const [sleepLeft, setSleepLeft] = useState(0)
  const [timerOpen, setTimerOpen] = useState(false)
  const [chat, setChat] = useState<ChatItem[]>([])
  /** 弹幕面板显隐（随切房重置为关） */
  const [chatOpen, setChatOpen] = useState(false)
  /** 本房间内是否已开过弹幕（开过之后连接一直保持到切房） */
  const [chatActive, setChatActive] = useState(false)
  /** 直播录制进行中 */
  const [recording, setRecording] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const chatListRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<LiveStreamPlayer | null>(null)
  /** PK/连麦智能取景（检测流内留边并放大内容区） */
  const cropRef = useRef<ContentCropper | null>(null)
  const audioGraphRef = useRef<AudioContext | null>(null)
  /** 响度自动平衡（挂在音频图上，随图一起创建/销毁） */
  const normRef = useRef<LoudnessNormalizer | null>(null)
  /** 录制音频旁路：源节点直连，取原始音频（不随音量/静音/归一化变化） */
  const recDestRef = useRef<MediaStreamAudioDestinationNode | null>(null)
  /** 直播录制器（随房间挂载，切房时自动收尾） */
  const recorderRef = useRef<LiveRecorder | null>(null)
  if (!recorderRef.current) recorderRef.current = new LiveRecorder()
  /** 断流自动分段续录的次数（长段成功后重置） */
  const recRestartsRef = useRef(0)
  const candsRef = useRef<StreamChoice[]>([])
  const candIdx = useRef(0)
  const seqRef = useRef(0)
  const phaseRef = useRef<Phase>('entering')
  const fatalCount = useRef(0)
  const uiTimer = useRef<number | undefined>(undefined)
  const toastTimer = useRef<number | undefined>(undefined)

  const setPhase = (phase: Phase): void => {
    phaseRef.current = phase
    setSt((s) => ({ ...s, phase }))
  }

  const toast = useCallback((msg: string): void => {
    setSt((s) => ({ ...s, toast: msg }))
    clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setSt((s) => ({ ...s, toast: undefined })), 4000)
  }, [])

  const freezeEnd = useCallback((): void => {
    const v = videoRef.current
    if (v) {
      try {
        v.pause()
      } catch {}
    }
    phaseRef.current = 'ended'
    setSt((s) => ({ ...s, phase: 'ended', paused: true }))
  }, [])

  // ---------- 定时暂停：倒计时结束即暂停播放（等同按下暂停键） ----------
  useEffect(() => {
    if (!sleepAt) {
      setSleepLeft(0)
      return
    }
    const tick = (): void => {
      const left = sleepAt - Date.now()
      if (left > 0) {
        setSleepLeft(left)
        return
      }
      setSleepAt(0)
      if (phaseRef.current === 'live') {
        const v = videoRef.current
        if (v) {
          try {
            v.pause()
          } catch {}
        }
        setSt((s) => ({ ...s, paused: true }))
        toast('定时时间到，已暂停播放')
      }
    }
    tick()
    const t = window.setInterval(tick, 500)
    return () => window.clearInterval(t)
  }, [sleepAt, toast])

  // ---------- 进入直播间 ----------
  useEffect(() => {
    const seq = ++seqRef.current
    let dead = false
    phaseRef.current = 'entering'
    setSt({ phase: 'entering', paused: false, audioOnly: false, recovering: false })
    setViewer('')
    fatalCount.current = 0
    candIdx.current = 0

    void api.roomEnter({ roomId: item.roomId, webRid: item.webRid, secUid: item.secUid }).then((res: RoomEnterResult) => {
      if (dead || seq !== seqRef.current) return
      const info = res.info
      if (res.ok && info) {
        candsRef.current = info.streams
        setViewer(info.viewerCountText || '')
        setSt({ phase: 'live', paused: false, audioOnly: false, recovering: false, info })
        phaseRef.current = 'live'
        return
      }
      if (res.code === 'ROOM_CLOSED') {
        setSt({ phase: 'ended', paused: true, audioOnly: false, recovering: false, info })
        phaseRef.current = 'ended'
        return
      }
      if (res.code === 'UNSUPPORTED') {
        setSt({ phase: 'unsupported', paused: true, audioOnly: false, recovering: false, info, message: res.message, detail: res.detail })
        phaseRef.current = 'unsupported'
        return
      }
      setSt({ phase: 'error', paused: true, audioOnly: false, recovering: false, info, message: res.message, code: res.code, detail: res.detail })
      phaseRef.current = 'error'
    })
    return () => {
      dead = true
      void api.roomStop()
    }
  }, [item.secUid, item.roomId, reloadKey])

  // ---------- 播放与恢复 ----------
  const handleFatal = useCallback(
    (reason: string): void => {
      if (phaseRef.current !== 'live') return
      fatalCount.current++
      const next = candIdx.current + 1
      if (fatalCount.current <= 4 && next < candsRef.current.length) {
        setSt((s) => ({ ...s, recovering: true }))
        window.setTimeout(() => {
          if (phaseRef.current === 'live') startPlaybackRef.current(next)
        }, 900)
        return
      }
      void api.roomCheckStatus().then((r) => {
        if (phaseRef.current !== 'live') return
        setSt((s) => ({ ...s, recovering: false }))
        const ev = r.ok ? r.data : null
        if (ev && ev.status === 4) {
          freezeEnd()
          return
        }
        phaseRef.current = 'error'
        setSt((s) => ({ ...s, phase: 'error', message: `直播流中断（${reason}），请点击刷新重试`, code: 'STREAM_ERROR' }))
      })
    },
    [freezeEnd]
  )

  const handleStreamEnd = useCallback((): void => {
    // 流 EOF：先校验房间状态，再决定“下播”还是重连
    if (phaseRef.current !== 'live') return
    void api.roomCheckStatus().then((r) => {
      if (phaseRef.current !== 'live') return
      const ev = r.ok ? r.data : null
      if (ev && ev.status === 4) {
        freezeEnd()
      } else if (fatalCount.current < 2) {
        fatalCount.current++
        startPlaybackRef.current(0)
      } else {
        phaseRef.current = 'error'
        setSt((s) => ({ ...s, phase: 'error', message: '直播流已断开', code: 'STREAM_ENDED' }))
      }
    })
  }, [freezeEnd])

  const startPlayback = useCallback(
    (idx: number): void => {
      const v = videoRef.current
      const cands = candsRef.current
      if (!v || !cands.length) return
      candIdx.current = idx
      const c = cands[idx]
      playerRef.current?.destroy()
      const player = new LiveStreamPlayer()
      player.onFatal = handleFatal
      player.onEnded = handleStreamEnd
      playerRef.current = player
      player.attach(v)
      v.volume = p.volume
      v.muted = p.muted
      // FLV 源旁路解析 SEI 布局（PK/连麦精确取景）；HLS 等无旁路时走像素兜底
      if (c.kind === 'flv') cropRef.current?.tapStream(c.url)
      player.load(c.url, c.kind)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handleFatal, handleStreamEnd, p.volume, p.muted]
  )
  const startPlaybackRef = useRef(startPlayback)
  startPlaybackRef.current = startPlayback

  // phase -> live 时挂载播放器
  useEffect(() => {
    if (st.phase !== 'live') return
    // 音频链路：media element → [响度归一化] → AnalyserNode → 输出（MSE 源为同源 blob，
    // 无跨域污染；createMediaElementSource 对同一元素仅可调用一次，成功后随元素存活）
    if (!audioGraphRef.current) {
      const v = videoRef.current
      try {
        const ctx = new AudioContext()
        if (v) {
          const src = ctx.createMediaElementSource(v)
          const an = ctx.createAnalyser()
          an.fftSize = 512
          an.smoothingTimeConstant = 0.8
          // 响度自动平衡；失败（如内核不支持 IIRFilter）时退回直连，仅损失归一化
          try {
            const norm = new LoudnessNormalizer(ctx, { roomId: item.roomId, enabled: p.loudnessNorm })
            norm.setSourceGainDb(p.muted || p.volume <= 0 ? null : 20 * Math.log10(p.volume))
            norm.setTrimDb(p.appGainDb)
            src.connect(norm.input)
            norm.output.connect(an)
            normRef.current = norm
          } catch {
            src.connect(an)
          }
          // 录制音频旁路：源节点直连取原始音频，录制不随音量/静音变化
          try {
            const recDest = ctx.createMediaStreamDestination()
            src.connect(recDest)
            recDestRef.current = recDest
          } catch {}
          an.connect(ctx.destination)
          audioGraphRef.current = ctx
          setAnalyser(an)
        } else {
          void ctx.close()
        }
      } catch {
        // 失败（重复创建/内核限制）时光圈自动退化为待机动效，不影响播放
      }
    }
    void audioGraphRef.current?.resume().catch(() => {})
    // PK/连麦智能取景：跟随本轮直播会话创建，切房/重连时销毁重建。
    // 需先于 startPlayback 创建——startPlayback 会对 FLV 源安装 SEI 旁路
    cropRef.current?.destroy()
    cropRef.current = new ContentCropper()
    if (videoRef.current) cropRef.current.attach(videoRef.current)
    startPlaybackRef.current(0)
    return () => {
      cropRef.current?.destroy()
      cropRef.current = null
      playerRef.current?.destroy()
      playerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.phase, reloadKey])

  // 运行时识别纯音频（视频宽为 0；或视频轨解码失败但音频在播——语音厅常见）
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const check = (): void => {
      if (phaseRef.current === 'live' && v.videoWidth === 0 && v.readyState >= 2) {
        setSt((s) => (s.audioOnly ? s : { ...s, audioOnly: true }))
      }
    }
    const onErr = (): void => {
      if (phaseRef.current === 'live' && v.videoWidth === 0) {
        setSt((s) => (s.audioOnly ? s : { ...s, audioOnly: true }))
      }
    }
    const resume = (): void => void audioGraphRef.current?.resume().catch(() => {})
    v.addEventListener('playing', check)
    v.addEventListener('loadedmetadata', check)
    v.addEventListener('error', onErr)
    v.addEventListener('playing', resume)
    return () => {
      v.removeEventListener('playing', check)
      v.removeEventListener('loadedmetadata', check)
      v.removeEventListener('error', onErr)
      v.removeEventListener('playing', resume)
    }
  }, [st.phase])

  // 卸载时释放音频图：AudioContext 每房间创建一个，不关闭会随切房累积泄漏；
  // 归一化器先析构，把本房间响度写入跨房间记忆；录制器同步收尾落盘
  useEffect(() => {
    return () => {
      normRef.current?.destroy()
      normRef.current = null
      recDestRef.current = null
      void recorderRef.current?.stop()
      void audioGraphRef.current?.close().catch(() => {})
      audioGraphRef.current = null
    }
  }, [])

  // 音量 / 静音（元素音量作用于测量之前，同步补偿给归一化器）
  useEffect(() => {
    const v = videoRef.current
    if (v) {
      v.volume = p.volume
      v.muted = p.muted
    }
    normRef.current?.setSourceGainDb(p.muted || p.volume <= 0 ? null : 20 * Math.log10(p.volume))
  }, [p.volume, p.muted, st.phase])

  // 响度自动平衡开关
  useEffect(() => {
    normRef.current?.setEnabled(p.loudnessNorm)
  }, [p.loudnessNorm])

  // 应用级增益
  useEffect(() => {
    normRef.current?.setTrimDb(p.appGainDb)
  }, [p.appGainDb])

  // ---------- 房间状态事件 ----------
  useEffect(() => {
    const off = api.onRoomStatus((ev) => {
      if (!ev || (ev.roomId && item.roomId && ev.roomId !== item.roomId)) return
      if (ev.viewerCountText) setViewer(ev.viewerCountText)
      if (ev.streams?.length && candsRef.current.length === 0) candsRef.current = ev.streams
      if (ev.status === 4) {
        if (phaseRef.current === 'live' || phaseRef.current === 'entering') freezeEnd()
      } else if (ev.status === 2 && phaseRef.current === 'ended') {
        toast('检测到重新开播，正在重连…')
        window.setTimeout(() => setReloadKey((k) => k + 1), 600)
      }
    })
    return off
  }, [item.roomId, freezeEnd, toast])

  // ---------- 公屏弹幕 ----------
  useEffect(() => {
    const off = api.onChatMessage((e) => {
      if (!e || e.roomId !== item.roomId) return
      setChat((list) => [...list, ...e.items].slice(-150))
    })
    return off
  }, [item.roomId])

  // 新消息自动吸底（用户上翻时暂停跟随）
  useEffect(() => {
    const el = chatListRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight
  }, [chat])

  // ---------- 全屏 / UI 显隐 / 快捷键 ----------
  const toggleFullscreen = useCallback(async (): Promise<void> => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await paneRef.current?.requestFullscreen()
    } catch {}
  }, [])

  useEffect(() => {
    const h = (): void => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', h)
    return () => document.removeEventListener('fullscreenchange', h)
  }, [])

  const bumpUi = useCallback((): void => {
    setUiVisible(true)
    clearTimeout(uiTimer.current)
    // 播放中鼠标静止 3.2s 后隐藏 UI；暂停等状态保持常显
    if (phaseRef.current === 'live') {
      uiTimer.current = window.setTimeout(() => setUiVisible(false), 3200)
    }
  }, [])

  useEffect(() => {
    bumpUi()
    return () => clearTimeout(uiTimer.current)
  }, [bumpUi])

  const togglePlay = useCallback((): void => {
    const v = videoRef.current
    if (!v || phaseRef.current !== 'live') return
    if (v.paused) {
      void v.play().catch(() => {})
      playerRef.current?.jumpToLive()
      setSt((s) => ({ ...s, paused: false }))
    } else {
      v.pause()
      setSt((s) => ({ ...s, paused: true }))
    }
  }, [])

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault()
      togglePlay()
    } else if (e.key === 'f') {
      void toggleFullscreen()
    } else if (e.key === 'm') {
      p.onMuted(!p.muted)
    }
  }

  /** 退出直播间：先脱离全屏（元素卸载时浏览器也会自动退出，双保险），再关闭房间回列表 */
  const exitRoom = useCallback((): void => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    p.onClose()
  }, [p.onClose])

  const info = st.info
  const webRid = info?.webRid || item.webRid
  const browserUrl = `https://live.douyin.com/${webRid || item.roomId}`
  /** 弹幕开关：首次打开对本房间建连（连接保持到切房），之后只切换面板显隐 */
  const toggleChat = useCallback((): void => {
    if (!chatActive) {
      setChatActive(true)
      setChatOpen(true)
      void api.chatStart()
      return
    }
    setChatOpen((v) => !v)
  }, [chatActive])

  // ---------- 直播录制 ----------
  /** 展示「所属文件夹/文件名」，toast 里放不下完整路径 */
  const tailPath = (f: string): string => {
    const parts = f.split(/[\\/]/).filter(Boolean)
    return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : f
  }

  const startRec = useCallback(async (): Promise<void> => {
    const rec = recorderRef.current
    const v = videoRef.current
    if (!rec || !v || rec.active || phaseRef.current !== 'live') return
    try {
      const file = await rec.start(v, recDestRef.current?.stream.getAudioTracks()[0] ?? null, {
        roomId: item.roomId,
        webRid: webRid || undefined,
        secUid: item.secUid,
        nickname: info?.nickname || item.nickname
      })
      recRestartsRef.current = 0
      setRecording(true)
      toast(`开始录制：${tailPath(file)}`)
    } catch (e) {
      setRecording(false)
      toast(`录制失败：${String((e as Error)?.message ?? e)}`)
    }
  }, [item.roomId, item.secUid, item.nickname, webRid, info?.nickname, toast])

  const stopRec = useCallback(
    (announce = true): void => {
      const rec = recorderRef.current
      if (!rec || !rec.active) return
      setRecording(false)
      void rec.stop().then((file) => {
        if (!announce) return
        if (file) toast(`录制已保存：${tailPath(file)}`)
        else toast('录制内容太短，未保存')
      })
    },
    [toast]
  )

  const toggleRec = useCallback((): void => {
    const rec = recorderRef.current
    if (!rec) return
    if (rec.active) stopRec()
    else void startRec()
  }, [startRec, stopRec])

  // 断流/切流导致轨道结束：自动分段保存，直播仍在则续录新段（限制次数防反复刷文件）
  useEffect(() => {
    const rec = recorderRef.current
    if (!rec) return
    rec.onInterrupted = (file) => {
      setRecording(false)
      if (Date.now() - rec.lastStartedAt >= 60_000) recRestartsRef.current = 0
      if (++recRestartsRef.current <= 10) {
        if (file) toast('直播流中断，本段已保存，正在续录…')
        window.setTimeout(() => {
          if (phaseRef.current === 'live' && !rec.active) void startRec()
        }, 1_500)
      } else if (file) {
        toast(`直播流中断，本段已保存：${tailPath(file)}`)
      }
    }
    return () => {
      rec.onInterrupted = () => {}
    }
  }, [startRec, toast])

  // 下播/出错：自动结束录制并保存
  useEffect(() => {
    if (st.phase !== 'live' && recorderRef.current?.active) stopRec()
  }, [st.phase, stopRec])

  // 主进程关窗前的收尾请求：停止录制落盘后放行关闭
  useEffect(() => {
    const off = api.onRecFinalize(() => {
      const rec = recorderRef.current
      const done = (): void => {
        void api.recFinalizeDone()
      }
      if (rec && rec.active) void rec.stop().then(done, done)
      else done()
    })
    return off
  }, [])

  // 语音/电台房强制走音频界面：这类流的视频轨常为不可解码编码（如 H.265）或纯黑占位，
  // 仅靠 videoWidth===0 的运行时判定会漏（有轨但解不出画面 → 黑屏）
  const audioMode = st.audioOnly || info?.typeHint === 'voice' || info?.typeHint === 'audio'
  const avatarUrl = info?.avatarUrl || item.avatarUrl
  const kindBadge = st.audioOnly
    ? { label: '音频直播', Icon: IconHeadphones }
      : info?.typeHint === 'voice'
        ? { label: '电台', Icon: IconHeadphones }
      : info?.typeHint === 'audio'
        ? { label: '音频直播', Icon: IconHeadphones }
        : info?.typeHint === 'video'
          ? { label: '视频直播', Icon: IconVideo }
          : null

  const cx = (...cls: (string | false | undefined)[]): string => cls.filter(Boolean).join(' ')

  return (
    <div
      ref={paneRef}
      className={cx('player-pane', fullscreen && 'is-full', st.phase === 'live' && !uiVisible && 'hide-ui')}
      tabIndex={0}
      onKeyDown={onKey}
      onMouseMove={bumpUi}
    >
      {/* 视频 / 音频画面层 */}
      {/* 视频区（弹幕停靠栏占据右侧时整体左移） */}
      <div className="video-wrap">
      <div className="video-layer">
        <video
          ref={videoRef}
          className={cx(st.phase === 'ended' && 'ended', audioMode && 'ghost')}
          playsInline
          preload="auto"
        />
        {audioMode && (st.phase === 'live' || st.phase === 'ended') && (
          <AudioBackdrop
            bg={info?.backgroundUrl || info?.coverUrl || item.coverUrl}
            avatar={info?.avatarUrl || item.avatarUrl}
            title={info?.title || item.title}
            nickname={info?.nickname || item.nickname}
            dimmed={st.phase === 'ended'}
            analyser={analyser}
          />
        )}
      </div>

      {/* 顶部信息条 */}
      {(st.phase === 'live' || st.phase === 'ended') && (
        <header className="pane-top">
          {fullscreen && (
            <button className="pane-back" onClick={exitRoom} title="退出直播间">
              <IconBack size={17} />
            </button>
          )}
          <div className="pane-avatar" title={info?.nickname || item.nickname}>
            {avatarUrl ? <img src={avatarUrl} alt="" referrerPolicy="no-referrer" /> : <IconLogo size={14} />}
          </div>
          <span className="pane-nick">{info?.nickname || item.nickname}</span>
          <span className="pane-title">{info?.title || item.title}</span>
          {kindBadge && (
            <span className="kind-tag">
              <kindBadge.Icon /> {kindBadge.label}
            </span>
          )}
          {viewer && (
            <span className="pane-viewers">
              <IconUsers /> {viewer}
            </span>
          )}
        </header>
      )}

      {st.toast && <div className="pane-toast">{st.toast}</div>}
      {st.recovering && st.phase === 'live' && <div className="pane-recovering">信号不稳定，重连中…</div>}

      {/* 进入中 */}
      {st.phase === 'entering' && (
        <div className="pane-center">
          <div className="spinner" />
          <p>正在进入直播间…</p>
        </div>
      )}

      {/* 下播：定格最后一帧 + 模糊 */}
      {st.phase === 'ended' && (
        <div className="pane-ended">
          <div className="ended-title">直播已结束</div>
          <div className="ended-actions">
            <button className="btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
              <IconRefresh size={15} /> 刷新重试
            </button>
            <button
              className="btn-ghost-light"
              onClick={() => void api.openExternal(browserUrl)}
              title="在浏览器中打开该直播间"
            >
              <IconExternal /> 浏览器打开
            </button>
          </div>
        </div>
      )}

      {/* 加载错误 */}
      {st.phase === 'error' && (
        <div className="pane-center error">
          <IconAlert size={26} />
          <p>{st.message || '直播间加载失败'}</p>
          {st.detail && (
            <details className="diag">
              <summary>诊断信息</summary>
              <pre>{st.detail}</pre>
            </details>
          )}
          <div className="ended-actions">
            <button className="btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
              <IconRefresh size={15} /> 重试
            </button>
            <button className="btn-ghost-light" onClick={() => void api.openExternal(browserUrl)}>
              <IconExternal /> 浏览器打开
            </button>
          </div>
        </div>
      )}

      {/* 不支持的直播类型（兜底） */}
      {st.phase === 'unsupported' && (
        <div className="pane-center error">
          <IconAlert size={26} />
          <p>{st.message || '该直播间类型暂不支持播放'}</p>
          <p className="dim">请在浏览器中打开，或稍后重试（应用将持续支持更多类型）</p>
          {st.detail && (
            <details className="diag">
              <summary>诊断信息</summary>
              <pre>{st.detail}</pre>
            </details>
          )}
          <div className="ended-actions">
            <button className="btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
              <IconRefresh size={15} /> 重试
            </button>
            <button className="btn-ghost-light" onClick={() => void api.openExternal(browserUrl)}>
              <IconExternal /> 浏览器打开
            </button>
          </div>
        </div>
      )}

      {/* 底部控制条：暂停/播放、刷新、音量、浏览器、窗口最大化、全屏 */}
      {st.phase === 'live' && (
        <footer className="pane-controls">
          <button className="ctl" onClick={togglePlay} title={st.paused ? '播放（空格）' : '暂停（空格）'}>
            {st.paused ? <IconPlay /> : <IconPause />}
          </button>
          <button className="ctl" onClick={() => setReloadKey((k) => k + 1)} title="刷新直播流">
            <IconRefresh />
          </button>
          <div className="volume-box" title="音量">
            <button className="ctl" onClick={() => p.onMuted(!p.muted)}>
              {p.muted || p.volume === 0 ? <IconMute /> : <IconVolume />}
            </button>
            <input
              className="volume-range"
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={p.muted ? 0 : p.volume}
              onChange={(e) => {
                const v = Number(e.target.value)
                p.onVolume(v)
                if (v > 0 && p.muted) p.onMuted(false)
              }}
            />
          </div>
          <div className="ctl-spacer" />
          <button
            className={cx('ctl', chatActive && 'ctl-on')}
            onClick={toggleChat}
            title={chatActive ? '弹幕（已连接，点击显示/隐藏面板）' : '开启弹幕'}
          >
            <IconChat />
          </button>
          <button
            className={cx('ctl', recording && 'ctl-rec')}
            onClick={toggleRec}
            title={recording ? '停止录制' : '录制直播'}
          >
            {recording ? <span className="rec-dot" /> : <IconRecord />}
          </button>
          <div className="timer-anchor">
            <button
              className={cx('ctl', sleepAt > 0 && 'ctl-timer-on')}
              onClick={() => setTimerOpen((v) => !v)}
              title={sleepAt > 0 ? `定时暂停：剩余 ${Math.ceil(sleepLeft / 60000)} 分钟` : '定时暂停'}
            >
              {sleepAt > 0 ? (
                <span className="timer-count">
                  {Math.floor(sleepLeft / 60000)}:{String(Math.floor((sleepLeft % 60000) / 1000)).padStart(2, '0')}
                </span>
              ) : (
                <IconTimer />
              )}
            </button>
            {timerOpen && (
              <>
                <div className="menu-mask" onClick={() => setTimerOpen(false)} />
                <div className="timer-menu">
                  <div className="menu-title">定时暂停 · 时间到自动暂停播放</div>
                  <div className="interval-row">
                    {TIMER_OPTIONS.map((m) => (
                      <button
                        key={m}
                        className={`interval-opt ${sleepAt > 0 && Math.ceil(sleepLeft / 60000) === m ? 'active' : ''}`}
                        onClick={() => {
                          setSleepAt(Date.now() + m * 60_000)
                          setSleepLeft(m * 60_000)
                          setTimerOpen(false)
                        }}
                      >
                        {m} 分钟
                      </button>
                    ))}
                  </div>
                  {sleepAt > 0 && (
                    <button
                      className="timer-cancel"
                      onClick={() => {
                        setSleepAt(0)
                        setTimerOpen(false)
                      }}
                    >
                      取消定时
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          <button className="ctl" onClick={() => void api.openExternal(browserUrl)} title="在浏览器中打开">
            <IconExternal />
          </button>
          <button className="ctl" onClick={() => void api.winMaximize()} title="窗口最大化">
            <IconMaximize />
          </button>
          <button className="ctl" onClick={() => void toggleFullscreen()} title="全屏（f）">
            <IconFullscreen />
          </button>
        </footer>
      )}
      </div>

      {/* 公屏弹幕停靠栏：占据右侧，视频区随之左移 */}
      {chatOpen && (
        <aside className="chat-dock">
          <div className="chat-head">
            <span>弹幕</span>
            <button className="chat-close" onClick={() => setChatOpen(false)} title="关闭">
              ×
            </button>
          </div>
          <div className="chat-list" ref={chatListRef}>
            {chat.length === 0 ? (
              <div className="chat-empty">{st.phase === 'live' ? '暂无弹幕' : '未在直播中'}</div>
            ) : (
              chat.map((m, i) =>
                m.kind === 'sys' ? (
                  <div className="chat-sys" key={i}>
                    {m.content}
                  </div>
                ) : m.kind === 'gift' ? (
                  <div className="chat-gift" key={i}>
                    <span className="chat-nick">{m.nick}</span> {m.content}
                  </div>
                ) : (
                  <div className="chat-item" key={i}>
                    <span className="chat-nick">{m.nick}</span>
                    <span className="chat-text">：{m.content}</span>
                  </div>
                )
              )
            )}
          </div>
        </aside>
      )}
    </div>
  )
}

/** 纯音频直播（电台）画面：背景图 + 头像呼吸 + 律动条 */
function AudioBackdrop(props: {
  bg?: string
  avatar?: string
  title: string
  nickname: string
  dimmed: boolean
  analyser: AnalyserNode | null
}) {
  return (
    <div className={props.dimmed ? 'audio-backdrop dimmed' : 'audio-backdrop'}>
      {props.bg && (
        <>
          {/* 底层模糊铺满填白，上层清晰原图（保持比例） */}
          <img className="audio-bg-blur" src={props.bg} alt="" referrerPolicy="no-referrer" />
          <img className="audio-bg" src={props.bg} alt="" referrerPolicy="no-referrer" />
        </>
      )}
      <div className="audio-card">
        <div className="audio-avatar">
          {props.avatar ? <img src={props.avatar} alt="" referrerPolicy="no-referrer" /> : <IconLogo size={44} />}
          <AudioRing analyser={props.analyser} size={196} dimmed={props.dimmed} />
        </div>
        <div className="audio-name">{props.nickname}</div>
        <div className="audio-title">{props.title}</div>
      </div>
    </div>
  )
}
