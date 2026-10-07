/**
 * 礼物消息（WebcastGiftMessage）解析与连击聚合。
 *
 * 字段号标定来源：公开 proto 双源交叉验证（zboyco/douyin-live 与
 * saermart/DouyinLiveWebFetcher 的 douyin.proto 完全一致）+ 实测抓包
 * （research/douyin-live-protocol.md §5.2 / research/gift_samples）。
 *
 * GiftMessage{
 *   common=1{method=1, msg_id=2, room_id=3}, gift_id=2, repeat_count=5(连击累计数),
 *   combo_count=6, user=7{...,nick_name=3, avatar_thumb=9{Image}}, repeat_end=9(1=连击结束),
 *   group_id=11(连击组), gift=15(GiftStruct), log_id=16(string) }
 * GiftStruct{ image=1(Image), describe=2, id=5, combo=10, type=11, diamond_count=12(抖币单价),
 *   name=16, icon=21(Image) }
 * Image{ url_list=1 repeated string, uri=2 }
 *
 * 本文件不依赖 Electron / 路径别名，可被 scripts/test-gift-parse.mjs 独立打包测试。
 */
import { decodeFields, fint, fstr, type ProtoField } from './proto-lite'

/** 解析后的礼物消息（一条 GiftMessage 帧） */
export interface ParsedGift {
  /** common.msg_id，游客态可能为空 */
  msgId: string
  giftId: number
  /** 连击组 id；批量/连击时服务端下发，可能为空 */
  groupId: string
  /** 发送者昵称 */
  nick: string
  /** 发送者 uid（去重/合并键用；游客态可能被掩码） */
  uid: string
  /** 发送者头像（url_list 首项，已归一 https） */
  avatar: string
  /** 服务端累计连击数（repeat_count，兜底 combo_count / 1） */
  repeatCount: number
  /** 1 = 该连击组的最后一帧 */
  repeatEnd: boolean
  /** 礼物名（GiftStruct.name） */
  name: string
  /** 礼物静态图（GiftStruct.image 首项） */
  icon: string
  /** 抖币单价（GiftStruct.diamond_count；0 = 免费礼物/未下发） */
  diamond: number
}

/** 聚合后可入弹幕列表的礼物条目 */
export interface GiftItem {
  /** 渲染层原位合并键：同键行随连击更新计数，不新开一行 */
  key: string
  nick: string
  name: string
  count: number
  icon: string
  avatar: string
  /** 抖币单价 */
  diamond: number
  /** 连击结束帧 */
  comboEnd: boolean
}

export function parseGiftMessage(buf: Buffer): ParsedGift | null {
  const gm = decodeFields(buf)
  const user = gm.get(7)?.[0]
  if (!user) return null
  const u = decodeFields(user.bytes)
  const nick = fstr(u.get(3)?.[0])
  if (!nick) return null

  const giftId = fint(gm.get(2)?.[0])
  // group_id 公开源记 string，个别代际发 varint：两种 wire 都接
  const g11 = gm.get(11)?.[0]
  const groupId = g11 ? (g11.wire === 2 ? fstr(g11) : String(g11.int)) : ''
  const repeatCount = fint(gm.get(5)?.[0]) || fint(gm.get(6)?.[0]) || 1
  const repeatEnd = fint(gm.get(9)?.[0]) === 1

  let name = ''
  let icon = ''
  let diamond = 0
  const gs = pickGiftStruct(gm)
  if (gs) {
    name = fstr(gs.get(16)?.[0])
    diamond = fint(gs.get(12)?.[0])
    icon = firstUrl(gs.get(1)?.[0])
  }
  const msgId = msgIdOf(gm)

  return {
    msgId,
    giftId,
    groupId,
    nick,
    uid: fint(u.get(1)?.[0]) ? String(u.get(1)![0].int) : '',
    avatar: firstUrl(u.get(9)?.[0]),
    repeatCount,
    repeatEnd,
    name,
    icon,
    diamond
  }
}

/**
 * 轻礼物消息（小心心/人气票等 1 抖币级礼物）。字段号来源：f2（Johnserf-Seed/f2）
 * 编译描述符第三源 + 实测抓包（research/light_samples）。
 *
 * LightGiftMessage{ common=1, group_count=2, repeat_count=3, combo_count=4, to_user_id=5,
 *   priority=6, gift_info=7{gift_id=1, gift_icon=2(Image), diamond_count=3}, tray_info=8,
 *   send_type=9, count=10, banned_display_effects=12, gift_struct=13(GiftStruct) }
 *
 * 消息体不带发送者 user（轻礼物匿名聚合推送），sender 字段留空；
 * 计数取 repeat_count（累计值），兜底 count / combo_count。
 */
export function parseLightGiftMessage(buf: Buffer): ParsedGift | null {
  const lm = decodeFields(buf)
  let name = ''
  let icon = ''
  let diamond = 0
  const gs = lm.get(13)?.[0]
  if (gs && gs.wire === 2) {
    const gf = decodeFields(gs.bytes)
    name = fstr(gf.get(16)?.[0])
    diamond = fint(gf.get(12)?.[0])
    icon = firstUrl(gf.get(1)?.[0])
  }
  const gi = lm.get(7)?.[0]
  let giftId = 0
  if (gi && gi.wire === 2) {
    const gif = decodeFields(gi.bytes)
    giftId = fint(gif.get(1)?.[0])
    icon = icon || firstUrl(gif.get(2)?.[0])
    diamond = diamond || fint(gif.get(3)?.[0])
  }
  if (!giftId) return null
  const count = fint(lm.get(3)?.[0]) || fint(lm.get(10)?.[0]) || fint(lm.get(4)?.[0]) || 1
  return {
    msgId: msgIdOf(lm),
    giftId,
    groupId: '',
    nick: '',
    uid: '',
    avatar: '',
    repeatCount: count,
    repeatEnd: false,
    name,
    icon,
    diamond
  }
}

/**
 * 取 GiftStruct：标定字段号为 15；个别代际把 GiftStruct 放 16（16 同时是 log_id 的
 * string 字段，以「16 能解出嵌套消息且含 name 字段」判定，仅在 15 缺失时启用）。
 */
function pickGiftStruct(gm: Map<number, ProtoField[]>): Map<number, ProtoField[]> | null {
  const f15 = gm.get(15)?.[0]
  if (f15 && f15.wire === 2) {
    const gs = decodeFields(f15.bytes)
    if (gs.size > 0) return gs
  }
  const f16 = gm.get(16)?.[0]
  if (f16 && f16.wire === 2) {
    const gs = decodeFields(f16.bytes)
    if (gs.get(16)?.[0] || gs.get(1)?.[0]) return gs
  }
  return null
}

function msgIdOf(gm: Map<number, ProtoField[]>): string {
  const common = gm.get(1)?.[0]
  return common ? fstr(decodeFields(common.bytes).get(2)?.[0]) : ''
}

/** Image{ url_list=1 }：取首个 URL 并归一为 https */
function firstUrl(image?: ProtoField): string {
  if (!image || image.wire !== 2) return ''
  const im = decodeFields(image.bytes)
  for (const f of im.get(1) ?? []) {
    const url = fstr(f)
    if (url) return url.startsWith('http://') ? 'https://' + url.slice(7) : url
  }
  return ''
}

// ---------- 诊断工具 ----------

/** 递归打印 protobuf 字段树（DY_CHAT_DEBUG=1 时定位新礼物通道/协议漂移用） */
export function dumpProtoTree(buf: Buffer, maxDepth = 4): string {
  const out: string[] = []
  const walk = (b: Buffer, depth: number): void => {
    if (depth > maxDepth) return
    for (const [no, list] of decodeFields(b)) {
      for (const f of list) {
        const pad = '  '.repeat(depth + 1)
        if (f.wire !== 2) {
          out.push(`${pad}${no}: ${f.int}`)
          continue
        }
        const s = f.bytes.toString('utf8')
        const printable =
          s.length > 0 && [...s].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
        if (printable) {
          out.push(`${pad}${no}: ${JSON.stringify(s.slice(0, 90))}`)
          continue
        }
        try {
          const t = decodeFields(f.bytes)
          const total = [...t.values()].reduce((a, l) => a + l.length, 0)
          if (total > 0) {
            out.push(`${pad}${no}: msg(${f.bytes.length}B)`)
            walk(f.bytes, depth + 1)
            continue
          }
        } catch {
          // 非 protobuf 内容
        }
        out.push(`${pad}${no}: bytes(${f.bytes.length}B)`)
      }
    }
  }
  walk(buf, 0)
  return out.join('\n')
}

// ---------- 连击聚合 ----------

/** 同一连击组的帧间隔超过该值视为新连击（服务端 repeat_end 丢失时的兜底） */
const COMBO_GAP_MS = 4_000
const CATALOG_MAX = 400
const COMBO_MAX = 64

interface ComboState {
  count: number
  groupId: string
  /** 连击序号（聚合器内单调递增，保证每次连击的合并键唯一） */
  burst: number
  lastAt: number
}

/**
 * 礼物连击聚合 + 礼物档案缓存：
 * - repeat_count 是服务端累计值（非增量），直接展示；
 * - 同 (uid, giftId) 的连续帧合并为一条，渲染层按 key 原位更新计数；
 * - gift_id → 名称/图标/单价 的档案缓存，补偿个别帧缺 GiftStruct 的情况。
 */
export class GiftAggregator {
  private catalog = new Map<number, { name: string; icon: string; diamond: number }>()
  private combos = new Map<string, ComboState>()
  private nextBurst = 1

  consume(p: ParsedGift): GiftItem | null {
    // 档案按字段合并更新：缺 GiftStruct 的帧不得覆盖已有名称
    if (p.giftId > 0) {
      const c = this.catalog.get(p.giftId)
      const merged = {
        name: p.name || c?.name || '',
        icon: p.icon || c?.icon || '',
        diamond: p.diamond || c?.diamond || 0
      }
      if (merged.name || merged.icon || merged.diamond > 0) {
        this.catalog.set(p.giftId, merged)
        if (this.catalog.size > CATALOG_MAX) {
          const first = this.catalog.keys().next().value
          if (first !== undefined) this.catalog.delete(first)
        }
      }
    }
    let { name, icon, diamond } = p
    if (!name || !icon || !diamond) {
      const c = this.catalog.get(p.giftId)
      if (c) {
        name = name || c.name
        icon = icon || c.icon
        diamond = diamond || c.diamond
      }
    }

    const now = Date.now()
    // 游客态 uid 被掩码（研究实测固定 111111），此时回退昵称做连击键
    const actor = p.uid && p.uid !== '111111' ? `u${p.uid}` : `n${p.nick}`
    const ck = `${actor}|${p.giftId}`
    const prev = this.combos.get(ck)
    let state: ComboState
    if (
      !prev ||
      now - prev.lastAt > COMBO_GAP_MS ||
      (p.groupId && prev.groupId && p.groupId !== prev.groupId)
    ) {
      // 新连击：组 id 变化、或距上帧超时（repeat_end 丢失兜底）
      state = { count: p.repeatCount, groupId: p.groupId, burst: this.nextBurst++, lastAt: now }
    } else {
      state = {
        count: Math.max(prev.count, p.repeatCount),
        groupId: p.groupId || prev.groupId,
        burst: prev.burst,
        lastAt: now
      }
    }
    this.combos.set(ck, state)
    if (this.combos.size > COMBO_MAX) {
      for (const [k, v] of this.combos) {
        if (now - v.lastAt > COMBO_GAP_MS) this.combos.delete(k)
      }
      if (this.combos.size > COMBO_MAX) {
        const first = this.combos.keys().next().value
        if (first !== undefined) this.combos.delete(first)
      }
    }
    if (p.repeatEnd) this.combos.delete(ck)

    return {
      // 组 id + 连击序号共同入键：repeat_end 后即便服务端复用组 id 也会开新行
      key: `${ck}|${state.groupId}|${state.burst}`,
      nick: p.nick,
      name: name || (p.giftId ? `礼物#${p.giftId}` : '礼物'),
      count: state.count,
      icon,
      avatar: p.avatar,
      diamond,
      comboEnd: p.repeatEnd
    }
  }

  /** 切房时清空会话状态 */
  reset(): void {
    this.catalog.clear()
    this.combos.clear()
  }
}
