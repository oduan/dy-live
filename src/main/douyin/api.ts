import type { LiveItem, ProfileInfo, RoomEnterResult, RoomInfo, StreamChoice } from '@shared/types'
import { firstUrl, formatCount } from '../util'
import type { DouyinSessions, PageFetchResult } from './sessions'
import type { RequestQueue } from './queue'
import { QueueBlockedError } from './queue'

/**
 * 抖音接口适配层。
 * 注意：抖音 web 接口字段可能随版本调整，解析处均做了多路径兜底；
 * 若某天列表/进房失败，优先检查本文件的端点与 normalize/extract 函数。
 */

const WWW_ORIGIN = 'https://www.douyin.com'
const LIVE_ORIGIN = 'https://live.douyin.com'
export const LIST_PAGE_SIZE = 15

export class DouyinApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: string
  ) {
    super(message)
    this.name = 'DouyinApiError'
  }
}

function fail(code: RoomEnterResult['code'], message: string, detail?: string, info?: RoomInfo): RoomEnterResult {
  return { ok: false, code, message, detail, info }
}

export class DouyinApi {
  constructor(
    private sessions: DouyinSessions,
    private wwwQueue: RequestQueue,
    private guestQueue: RequestQueue
  ) {}

  /** 登录态 www 接口（默认带 a_bogus 签名；sign=false 用于免签名接口） */
  private async wwwGet(
    path: string,
    params: Record<string, string | number | undefined>,
    sign = true
  ): Promise<any> {
    const qs = new URLSearchParams({ device_platform: 'webapp', aid: '6383' })
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && String(v).length) qs.set(k, String(v))
    }
    const url = `${WWW_ORIGIN}${path}?${qs.toString()}`
    const res = await this.wwwQueue.run(async () => {
      const wc = await this.sessions.ensureWww()
      return this.sessions.pageFetch(wc, url, sign)
    })
    if (!res.ok || !res.body) {
      throw new DouyinApiError('NETWORK', `网络请求失败（${res.status || 'ERR'}）`, res.err)
    }
    const text = res.body.trim()
    if (text.startsWith('<')) {
      await this.sessions.reloadWww().catch(() => undefined)
      throw new DouyinApiError('VERIFY', '触发验证或风控（返回 HTML）', text.slice(0, 160))
    }
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      throw new DouyinApiError('BAD_JSON', '响应解析失败', text.slice(0, 160))
    }
    const sc = json?.status_code
    if (typeof sc === 'number' && sc !== 0) {
      if (sc === 8) await this.sessions.reloadWww().catch(() => undefined)
      throw new DouyinApiError(`STATUS_${sc}`, json?.status_msg || `接口返回 status_code=${sc}`)
    }
    return json
  }

  /** 当前登录用户信息 */
  async fetchProfile(): Promise<ProfileInfo> {
    const j = await this.wwwGet('/aweme/v1/web/user/profile/self/', {})
    const u = j?.user ?? j?.data?.user
    if (!u?.sec_uid) throw new DouyinApiError('PROFILE_PARSE', '用户信息解析失败', Object.keys(j ?? {}).join(','))
    return {
      secUid: String(u.sec_uid),
      uid: String(u.uid ?? u.user_id ?? ''),
      nickname: u.nickname || '我',
      avatarUrl: firstUrl(u.avatar_url, u.avatar_thumb)
    }
  }

  /**
   * 关注的正在直播列表。
   * 旧接口 /aweme/v1/web/follow/live/list/ 已下线（网关返回 404 Unsupported path），
   * 改用 web 端「关注」页在用的 /webcast/web/feed/follow/：无需签名，登录 Cookie 即可，
   * 一次返回全部正在直播的关注（无分页，hasMore 恒为 false）。
   */
  async fetchFollowLivePage(
    offset: number
  ): Promise<{ items: LiveItem[]; hasMore: boolean; nextOffset: number; total: number }> {
    const j = await this.wwwGet(
      '/webcast/web/feed/follow/',
      { channel: 'channel_pc_web', scene: 'aweme_pc_follow_top' },
      false
    )
    const raw = j?.data?.data ?? []
    const items: LiveItem[] = []
    for (const e of raw) {
      const it = normalizeLiveEntry(e)
      if (it) items.push(it)
    }
    return { items, hasMore: false, nextOffset: offset, total: items.length }
  }

  /**
   * 语音/电台直播间兜底：web 端 enter 接口对此类房间不下发房间数据（data.data 为空，
   * 登录与否均如此），但关注 feed 里携带完整 stream_url（/radio/ 纯音频流）。
   * 用 web_rid / room_id 在 feed 中定位条目并提取流。
   */
  private async voiceRoomFromFeed(ref: { roomId?: string; webRid?: string }): Promise<RoomInfo | null> {
    try {
      const j = await this.wwwGet('/webcast/web/feed/follow/', { channel: 'channel_pc_web', scene: 'aweme_pc_follow_top' }, false)
      const raw: any[] = j?.data?.data ?? []
      const hit = raw.find(
        (e) =>
          (ref.webRid && String(e?.web_rid ?? '') === String(ref.webRid)) ||
          (ref.roomId && String(e?.room?.id_str ?? e?.room?.room_id ?? '') === String(ref.roomId))
      )
      const room = hit?.room
      if (!room) return null
      const streams = extractStreams(room.stream_url)
      if (!streams.length) return null
      const avatar = firstUrl(room.owner?.avatar_thumb)
      const viewers = parseCountText(room.user_count_str)
      return {
        roomId: String(room.id_str ?? ref.roomId ?? ''),
        webRid: ref.webRid ?? (hit.web_rid ? String(hit.web_rid) : undefined),
        title: room.title || '直播中',
        nickname: room.owner?.nickname ?? '',
        avatarUrl: avatar,
        coverUrl: firstUrl(room.cover) || avatar,
        backgroundUrl: extractBackground(room, hit),
        status: 2,
        viewerCountText: viewers === undefined ? '' : String(viewers),
        streams,
        typeHint: /\/radio\//.test(streams[0].url) ? 'voice' : 'audio'
      }
    } catch {
      return null
    }
  }

  /** 游客态进入直播间（获取流地址与状态；不携带登录 Cookie） */
  async guestRoomEnter(ref: { roomId?: string; webRid?: string }): Promise<RoomEnterResult> {
    const params = new URLSearchParams({
      aid: '6383',
      app_name: 'douyin_web',
      device_platform: 'web',
      live_reason: 'live_web',
      enter_from_merge: 'live_web',
      is_need_double_stream: 'false',
      insert_task_id: '1'
    })
    if (ref.roomId) params.set('room_id_str', ref.roomId)
    if (ref.webRid) params.set('web_rid', ref.webRid)
    if (!ref.roomId && !ref.webRid) return fail('NOT_FOUND', '缺少房间号')
    const url = `${LIVE_ORIGIN}/webcast/room/web/enter/?${params.toString()}`

    let res: PageFetchResult
    try {
      res = await this.guestQueue.run(async () => {
        const wc = await this.sessions.ensureGuest()
        return this.sessions.pageFetch(wc, url, false)
      })
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      if (e instanceof QueueBlockedError) return fail('RATE_LIMITED', '请求过于频繁，稍后自动重试', msg)
      if (/GUEST_INIT/i.test(msg)) return fail('GUEST_INIT_FAILED', '直播页初始化失败，请检查网络后重试', msg)
      return fail('NETWORK', '网络请求失败', msg)
    }

    if (!res.ok || !res.body) return fail('NETWORK', '直播间数据请求失败', res.err)
    const text = res.body.trim()
    if (text.startsWith('<')) return fail('VERIFY_REQUIRED', '触发风控验证，请稍后重试或稍后在浏览器打开', text.slice(0, 160))
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      return fail('NETWORK', '直播间数据解析失败', text.slice(0, 160))
    }
    if (typeof json?.status_code === 'number' && json.status_code !== 0) {
      return fail('UNKNOWN', `直播间加载失败（${json.status_code}）`, String(json?.status_msg ?? ''))
    }
    const d = json?.data ?? {}
    // 新结构：房间信息在 data.data[]（与关注列表同构，web_rid 请求时首元素即目标房间）；
    // 旧结构：data.room_info。做双路径兼容
    const arr = Array.isArray(d?.data) ? d.data : []
    const roomEl =
      (ref.roomId ? arr.find((x: any) => String(x?.id_str ?? x?.room_id ?? '') === String(ref.roomId)) : undefined) ??
      arr[0]
    const ri = d?.room_info ?? roomEl ?? {}
    if (!ri.room_id && !ri.id_str && !ri.web_rid) {
      // 语音/电台直播间：enter 不下发数据，走关注 feed 兜底
      const fb = await this.voiceRoomFromFeed(ref)
      if (fb) return { ok: true, code: 'OK', message: '', info: fb }
      return fail('NOT_FOUND', '直播间不存在或已关闭')
    }

    const streams = extractStreams(ri.stream_url)
    const views = ri.room_view_stats?.display_value ?? (typeof ri.user_count === 'number' ? formatCount(ri.user_count) : parseCountText(ri.user_count_str))
    const info: RoomInfo = {
      roomId: String(ri.room_id ?? ri.id_str ?? ref.roomId ?? ''),
      webRid: ri.web_rid ? String(ri.web_rid) : ref.webRid,
      title: ri.title || '直播中',
      nickname: ri.owner?.nickname ?? d?.user?.nickname ?? '',
      avatarUrl: firstUrl(ri.owner?.avatar_thumb, d?.user?.avatar_thumb),
      coverUrl: firstUrl(ri.cover, ri.cover_url, d?.user?.avatar_thumb),
      backgroundUrl: extractBackground(ri, roomEl, d),
      status: typeof ri.status === 'number' ? ri.status : typeof ri.live_status === 'number' ? ri.live_status : 0,
      viewerCountText: views === undefined || views === null ? '' : String(views),
      streams,
      // 电台/语音房的流走 /radio/ 通道，据此识别（新结构里旧的类型字段已不存在）
      typeHint: streams.some((s) => /\/radio\//.test(s.url)) ? 'voice' : guessTypeHint(d, ri),
      startedAt: typeof ri.start_time === 'number' ? ri.start_time * 1000 : undefined
    }

    if (info.status === 4) return fail('ROOM_CLOSED', '直播已结束', undefined, info)
    if (info.status === 2 || streams.length > 0) {
      if (streams.length === 0) {
        return fail(
          'UNSUPPORTED',
          `「${info.title}」为暂不支持的直播类型，未找到可播放的音视频流`,
          `type=${info.typeHint}; streamKeys=${Object.keys(ri.stream_url ?? {}).join('/')}; status=${info.status}`,
          info
        )
      }
      return { ok: true, code: 'OK', message: '', info }
    }
    return fail('UNSUPPORTED', '未知的直播间状态，暂不支持播放', `status=${info.status}`, info)
  }
}

// ---------- 解析 ----------

/** "1.2万" / "3,456" / "21" -> 数字；解析失败返回 undefined */
function parseCountText(s: unknown): number | undefined {
  if (typeof s !== 'string') return undefined
  const m = /^([\d,.]+)\s*万?$/.exec(s.trim())
  if (!m) return undefined
  const n = parseFloat(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return undefined
  return m[0].endsWith('万') ? Math.round(n * 10_000) : Math.round(n)
}

/** 列表项归一化（webcast/web/feed/follow 结构，多路径兜底） */
function normalizeLiveEntry(e: any): LiveItem | null {
  if (!e) return null
  const room = e.room ?? e.room_info ?? e.live_room
  const owner = room?.owner
  const roomId = room && (room.id_str ?? room.room_id ?? room.rid ?? room.id)
  const secUid = owner?.sec_uid ?? owner?.secUid ?? e.sec_uid
  if (!roomId || !secUid) return null
  const avatar = firstUrl(owner?.avatar_thumb, owner?.avatar_medium, e.avatar_thumb)
  return {
    secUid: String(secUid),
    nickname: owner?.nickname ?? owner?.nick_name ?? '未知主播',
    avatarUrl: avatar,
    roomId: String(roomId),
    webRid: e.web_rid ? String(e.web_rid) : room?.web_rid ? String(room.web_rid) : undefined,
    title: room?.title ?? '直播中',
    coverUrl: firstUrl(room?.cover, e.cover) || avatar,
    viewerCount:
      parseCountText(room?.user_count_str) ??
      (typeof room?.user_count === 'number' ? room.user_count : parseCountText(room?.room_view_stats?.display_value)),
    status: 2
  }
}

/**
 * 从房间对象里尽量找出直播背景图。字段名随版本漂移：先试已知键名，
 * 再按 /back|bg/i 键名模糊匹配（值为 {url_list:[...]} 形态的图片对象）。
 */
function extractBackground(...objs: any[]): string {
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue
    const hit = firstUrl(o.background, o.bg_img_url, o.background_url, o.dynamic_background, o.wallpaper)
    if (hit) return hit
  }
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue
    for (const [k, v] of Object.entries(o)) {
      if (!/back|bg/i.test(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue
      const u = firstUrl(v)
      if (u) return u
    }
  }
  return ''
}

/**
 * 从 stream_url 的各种形态里提取可播放地址（flv / hls）。
 * 采用“整体序列化后正则扫 URL”的通用做法，兼容语音厅/音频直播等不同结构。
 */
export function extractStreams(streamUrl: unknown): StreamChoice[] {
  if (!streamUrl || typeof streamUrl !== 'object') return []
  let json: string
  try {
    json = JSON.stringify(streamUrl)
  } catch {
    return []
  }
  const seen = new Set<string>()
  const out: StreamChoice[] = []
  const re = /https?:\/\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(json))) {
    const u = m[0].replace(/[\\",]+$/, '')
    if (seen.has(u) || u.length < 20) continue
    const isHls = /\.m3u8([?#]|$)/i.test(u)
    const isFlv = /\.flv([?#]|$)/i.test(u) || /wsSecret=/.test(u)
    if (!isHls && !isFlv) continue
    seen.add(u)
    out.push({ url: u, kind: isHls ? 'hls' : 'flv' })
  }
  // flv 优先（延迟低），同类型里高清描述优先
  const qualityRank = (u: string): number => (/origin|uhd|full|hd|_hd/i.test(u) ? 0 : 1)
  out.sort((a, b) => (a.kind === 'flv' ? 0 : 1) - (b.kind === 'flv' ? 0 : 1) || qualityRank(a.url) - qualityRank(b.url))
  return out.slice(0, 10)
}

/** 直播类型猜测：仅用于展示徽标与兜底提示；真实形态由播放器运行时判定（如纯音频） */
function guessTypeHint(data: any, roomInfo: any): RoomInfo['typeHint'] {
  const head = JSON.stringify({
    a: roomInfo?.live_core_business_type,
    b: roomInfo?.room_type,
    c: roomInfo?.common?.live_type,
    d: data?.voice_room_info ? 'voice' : '',
    e: roomInfo?.audio_only ?? ''
  }).toLowerCase()
  if (head.includes('voice') || head.includes('audio') || head.includes('radio')) {
    const body = JSON.stringify(data).slice(0, 5000)
    if (/"(team|interact|seat|mic_num|connect_mic|连麦)"/i.test(body)) return 'voice'
    return 'audio'
  }
  if (head.includes('video') || head.includes('live')) return 'video'
  return 'unknown'
}
