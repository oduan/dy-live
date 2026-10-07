/**
 * 礼物解析（src/main/douyin/gift.ts）单元验证（node 直跑，无需 Electron）：
 *   node scripts/test-gift-parse.mjs            — 合成报文断言
 *   node scripts/test-gift-parse.mjs x.bin      — 额外回放真实 im/fetch 抓包样本
 *
 * 覆盖：GiftStruct(15) 解析 / 字段 16 兼容代际 / 头像与图标 URL https 归一 /
 * 连击累计合并（同 key 原位更新）/ repeat_end 收尾 / 档案缓存兜底（缺 GiftStruct 帧）/
 * 新连击开新 key / 游客态掩码 uid。
 */
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'giftparse-'))
for (const [name, entry] of [
  ['gift', 'src/main/douyin/gift.ts'],
  ['proto-lite', 'src/main/douyin/proto-lite.ts']
]) {
  await build({
    entryPoints: [join(process.cwd(), entry)],
    outfile: join(dir, `${name}.mjs`),
    bundle: true,
    format: 'esm',
    logLevel: 'silent'
  })
}
const { GiftAggregator, parseGiftMessage, parseLightGiftMessage } = await import(
  pathToFileURL(join(dir, 'gift.mjs')).href
)
const { decodeFields, fstr } = await import(pathToFileURL(join(dir, 'proto-lite.mjs')).href)

// ---------- 合成 protobuf（与 proto-lite 同款 wire format 编码） ----------
function varint(n) {
  const out = []
  let v = BigInt(n)
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  out.push(Number(v))
  return out
}
function field(no, wire, payload) {
  // wire=2 需要 varint 长度前缀；wire=0（varint 值）不能加
  return wire === 2
    ? [...varint((no << 3) | wire), ...varint(payload.length), ...payload]
    : [...varint((no << 3) | wire), ...payload]
}
function str(no, s) {
  return field(no, 2, [...Buffer.from(s, 'utf8')])
}
function num(no, n) {
  return field(no, 0, varint(n))
}
function msg(no, bytes) {
  return field(no, 2, [...bytes])
}
function concat(...parts) {
  return Buffer.from(parts.flat())
}

const Nick = '测试用户'
const Avatar = 'https://p3.douyinpic.com/img/user-avatar~c5_100x100.jpeg'
const GiftIcon = 'http://p9-webcast.douyinpic.com/img/webcast/gift/roses.png' // 故意 http，验证归一

function userBuf(uid = 4242) {
  return concat(num(1, uid), str(3, Nick), msg(9, concat(str(1, Avatar))))
}
function giftStructBuf() {
  return concat(
    msg(1, concat(str(1, GiftIcon))),
    str(2, '送的浪漫礼物'),
    num(5, 250), // GiftStruct.id
    num(11, 1),
    num(12, 1), // diamond_count：玫瑰 1 抖币
    str(16, '玫瑰'),
    msg(21, concat(str(1, GiftIcon)))
  )
}
function giftMessageBuf({ uid, count, end = 0, group = '', withStruct = true, legacy = false }) {
  return concat(
    msg(1, concat(str(2, `msg-${uid}-${group}-${count}-${end}`), num(3, 7654321))),
    num(2, 250), // gift_id
    num(5, count),
    num(6, count),
    msg(7, userBuf(uid)),
    num(9, end),
    group ? str(11, group) : [],
    withStruct ? msg(legacy ? 16 : 15, giftStructBuf()) : [],
    legacy ? [] : str(16, 'log-id-string') // 字段 16 = log_id（15 存在时不得干扰）
  )
}

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failed++
    console.error(`  ✗ ${name} ${detail}`)
  }
}

console.log('— 解析 —')
{
  const p = parseGiftMessage(giftMessageBuf({ uid: 1, count: 5, group: 'g1' }))
  check('礼物名', p?.name === '玫瑰', JSON.stringify(p))
  check('抖币单价', p?.diamond === 1)
  check('累计连击数', p?.repeatCount === 5)
  check('gift_id', p?.giftId === 250)
  check('昵称', p?.nick === Nick)
  check('图标 https 归一', p?.icon === GiftIcon.replace('http://', 'https://'))
  check('头像', p?.avatar === Avatar)
  check('连击组', p?.groupId === 'g1')
  check('msg_id', p?.msgId === 'msg-1-g1-5-0')
  check('repeat_end', p?.repeatEnd === false)
}
{
  // 旧代际：GiftStruct 在字段 16（无字段 15）
  const p = parseGiftMessage(giftMessageBuf({ uid: 2, count: 1, legacy: true }))
  check('字段16 兼容代际礼物名', p?.name === '玫瑰', JSON.stringify(p?.name))
  check('字段16 兼容代际单价', p?.diamond === 1)
}
{
  const agg = new GiftAggregator()
  const p = parseGiftMessage(giftMessageBuf({ uid: 3, count: 1, withStruct: false }))
  check('无 GiftStruct 不崩溃', !!p && p.name === '')
  const it = agg.consume(p)
  check('档案兜底占位名', it?.name === '礼物#250', it?.name)
}

console.log('— 连击聚合 —')
{
  const agg = new GiftAggregator()
  const a = agg.consume(parseGiftMessage(giftMessageBuf({ uid: 4, count: 1, group: 'combo-1' })))
  const b = agg.consume(parseGiftMessage(giftMessageBuf({ uid: 4, count: 2, group: 'combo-1' })))
  const c = agg.consume(parseGiftMessage(giftMessageBuf({ uid: 4, count: 9, group: 'combo-1', end: 1 })))
  check('连击帧1', a?.count === 1)
  check('连击帧2 累计', b?.count === 2)
  check('连击帧3 累计', c?.count === 9)
  check('同一合并 key', a?.key && a.key === b?.key && b?.key === c?.key)
  check('末帧 comboEnd', a?.comboEnd === false && c?.comboEnd === true)
  const d = agg.consume(parseGiftMessage(giftMessageBuf({ uid: 4, count: 1, group: 'combo-1' })))
  check('收尾后新连击新 key', d?.key !== a?.key && d?.count === 1)
  const e = agg.consume(parseGiftMessage(giftMessageBuf({ uid: 5, count: 3, group: 'combo-2' })))
  check('不同用户独立计数', e?.count === 3 && e?.key !== a?.key)
}
{
  // 游客态 uid 掩码 111111：按昵称区分，仍可连击累计
  const agg = new GiftAggregator()
  const f1 = agg.consume(parseGiftMessage(giftMessageBuf({ uid: 111111, count: 2 })))
  const f2 = agg.consume(parseGiftMessage(giftMessageBuf({ uid: 111111, count: 4 })))
  check('游客态连击累计', f1?.key === f2?.key && f2?.count === 4)
}

console.log('— 档案缓存兜底 —')
{
  const agg = new GiftAggregator()
  agg.consume(parseGiftMessage(giftMessageBuf({ uid: 6, count: 1, group: 'x' })))
  const p = parseGiftMessage(giftMessageBuf({ uid: 6, count: 3, group: 'x', withStruct: false }))
  const it = agg.consume(p)
  check('缓存补名', it?.name === '玫瑰', it?.name)
  check('缓存补图标', it?.icon === GiftIcon.replace('http://', 'https://'))
  check('缓存补单价', it?.diamond === 1)
}

console.log('— 轻礼物 LightGiftMessage —')
{
  // LightGiftMessage{ common=1, repeat_count=3, count=10, gift_info=7{gift_id=1,gift_icon=2,diamond_count=3}, gift_struct=13 }
  function lightGiftBuf({ count, giftId = 32, withStruct = true }) {
    return concat(
      msg(1, concat(str(2, `lg-${count}`))),
      num(3, count), // repeat_count
      num(4, count), // combo_count
      num(5, 7654321), // to_user_id（主播）
      msg(7, concat(num(1, giftId), msg(2, concat(str(1, GiftIcon))), num(3, 1))), // gift_info
      num(10, count), // count
      withStruct
        ? msg(13, concat(msg(1, concat(str(1, GiftIcon))), num(12, 1), str(16, '小心心')))
        : []
    )
  }
  const agg = new GiftAggregator()
  const a = agg.consume(parseLightGiftMessage(lightGiftBuf({ count: 1 })))
  check('轻礼物解析：礼物名（gift_struct）', a?.name === '小心心', a?.name)
  check('轻礼物解析：图标', a?.icon === GiftIcon.replace('http://', 'https://'))
  check('轻礼物解析：单价（gift_struct 优先）', a?.diamond === 1)
  check('轻礼物解析：匿名', a && a.nick === '' && !a.avatar)
  check('轻礼物解析：数量', a?.count === 1)
  // 缺 gift_struct：从 gift_info 兜底 + 档案缓存补名
  const b = agg.consume(parseLightGiftMessage(lightGiftBuf({ count: 2, withStruct: false })))
  check('轻礼物缺 struct：缓存补名', b?.name === '小心心', b?.name)
  check('轻礼物缺 struct：gift_info 补图标', b?.icon === GiftIcon.replace('http://', 'https://'))
  check('轻礼物缺 struct：gift_info 补单价', b?.diamond === 1)
  check('轻礼物匿名连击累计', b?.count === 2)
  // 合成整包也应能从 Response 管线解出（回放同款路径）
  const p2 = parseLightGiftMessage(lightGiftBuf({ count: 5 }))
  check('轻礼物重复帧数量', p2?.repeatCount === 5)
}

// ---------- 可选：回放真实 im/fetch 抓包 ----------
const sample = process.argv[2]
if (sample) {
  console.log(`— 真实样本回放: ${sample} —`)
  const buf = readFileSync(sample)
  const resp = decodeFields(buf)
  const agg = new GiftAggregator()
  let gifts = 0
  for (const m of resp.get(1) ?? []) {
    const msg = decodeFields(m.bytes)
    const method = fstr(msg.get(1)?.[0])
    const mp = msg.get(2)?.[0]
    if (!mp) continue
    let p = null
    if (method === 'WebcastGiftMessage') p = parseGiftMessage(mp.bytes)
    else if (method === 'WebcastLightGiftMessage') p = parseLightGiftMessage(mp.bytes)
    else continue
    if (!p) {
      gifts++
      console.log(`  ${method}: 解析失败（缺 user/nick）`)
      continue
    }
    const it = agg.consume(p)
    gifts++
    console.log(
      `  ${method === 'WebcastGiftMessage' ? 'Gift  ' : 'Light '}: ${p.nick || '(匿名)'} 送出「${it.name}」×${it.count} ` +
        `diamond=${it.diamond} end=${p.repeatEnd ? 1 : 0} group=${p.groupId || '-'} icon=${it.icon ? '√' : '×'}`
    )
  }
  console.log(`  共 ${gifts} 条礼物消息`)
}

rmSync(dir, { recursive: true, force: true })
if (failed) {
  console.error(`\n${failed} 项断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')
