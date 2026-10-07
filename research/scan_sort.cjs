// 扫描旧样本里的 WebcastGiftSortMessage：可能内嵌真实 GiftStruct（礼物档案）
const fs = require('fs')
const path = require('path')
const { decodeFields, fstr } = require('./proto-lite.ts')

function printable(s) {
  return s.length > 0 && [...s].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
}
function dumpTree(buf, depth, maxDepth, out) {
  if (depth > maxDepth) return
  for (const [no, list] of decodeFields(buf)) {
    for (const f of list) {
      const pad = '  '.repeat(depth + 1)
      if (f.wire === 2) {
        const s = f.bytes.toString('utf8')
        if (printable(s)) out.push(`${pad}${no}: ${JSON.stringify(s.slice(0, 80))}`)
        else {
          try {
            const t = decodeFields(f.bytes)
            const total = [...t.values()].reduce((a, l) => a + l.length, 0)
            if (total > 0) {
              out.push(`${pad}${no}: msg(${f.bytes.length}B)`)
              dumpTree(f.bytes, depth + 1, maxDepth, out)
              continue
            }
          } catch {}
          out.push(`${pad}${no}: bytes(${f.bytes.length}B)`)
        }
      } else out.push(`${pad}${no}: ${f.int}`)
    }
  }
}

const dir = process.argv[2] || 'samples'
let found = 0
for (const file of fs.readdirSync(dir)) {
  const buf = fs.readFileSync(path.join(dir, file))
  let resp
  try {
    resp = decodeFields(buf)
  } catch {
    continue
  }
  for (const mm of resp.get(1) ?? []) {
    const msg = decodeFields(mm.bytes)
    const method = fstr(msg.get(1)?.[0])
    if (method === 'WebcastGiftSortMessage') {
      const mp = msg.get(2)?.[0]?.bytes
      if (!mp) continue
      found++
      if (found <= 2) {
        console.log(`\n=== WebcastGiftSortMessage (${file}, ${mp.length}B) ===`)
        const out = []
        dumpTree(mp, 0, 5, out)
        console.log(out.join('\n'))
      }
    }
  }
}
console.log(`\n命中 ${found} 条`)
