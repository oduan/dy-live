// 离线解析 im/fetch 抓包：统计消息类型 + 采样 GiftMessage 完整字段树
const { decodeFields, fint, fstr } = require('./proto-lite.ts')
const fs = require('fs')

function printable(s) {
  return s.length > 0 && [...s].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
}

function dumpTree(buf, depth, maxDepth, out) {
  if (depth > maxDepth) return
  const fields = decodeFields(buf)
  for (const [no, list] of fields) {
    for (const f of list) {
      const pad = '  '.repeat(depth + 1)
      if (f.wire === 2) {
        const s = f.bytes.toString('utf8')
        if (printable(s)) out.push(`${pad}${no}: ${JSON.stringify(s.slice(0, 60))}`)
        else if (f.bytes.length >= 2 && f.bytes.length < 6000) {
          // 尝试嵌套消息
          const t = decodeFields(f.bytes)
          const total = [...t.values()].reduce((a, l) => a + l.length, 0)
          const consumed = [...t.values()].reduce((a, l) => a + l.reduce((x, ff) => x + (ff.wire === 2 ? ff.bytes.length + 2 + Math.ceil(ff.bytes.length / 128) : 1 + Math.ceil(Number(ff.int).toString(2).length / 7 || 1)), 0), 0)
          if (total > 0 && consumed <= f.bytes.length + 8) {
            out.push(`${pad}${no}: msg(${f.bytes.length}B)`)
            dumpTree(f.bytes, depth + 1, maxDepth, out)
          } else out.push(`${pad}${no}: bytes(${f.bytes.length}B)`)
        } else out.push(`${pad}${no}: bytes(${f.bytes.length}B)`)
      } else out.push(`${pad}${no}: ${f.int}`)
    }
  }
}

const file = process.argv[2] || 't2.bin'
const buf = fs.readFileSync(file)
const resp = decodeFields(buf)
const msgs = resp.get(1) ?? []
const counts = {}
let giftDump = 0
for (const mm of msgs) {
  const msg = decodeFields(mm.bytes)
  const method = fstr(msg.get(1)?.[0])
  counts[method] = (counts[method] || 0) + 1
  if (method === 'WebcastGiftMessage' && giftDump < 2) {
    giftDump++
    const mp = msg.get(2)?.[0]?.bytes
    console.log(`=== GiftMessage #${giftDump} (${mp.length}B) ===`)
    const out = []
    dumpTree(mp, 0, 2, out)
    console.log(out.join('\n'))
  }
}
console.log('types:', JSON.stringify(counts, null, 1))
console.log('cursor:', fstr(resp.get(2)?.[0]))
