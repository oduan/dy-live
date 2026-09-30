// 提取房间页 SSR(self.__pace_f.push)中的 roomStore/roomInfo 双重转义 JSON 并按关键字段摘要
// 用法: node extract_ssr.mjs <room.html路径> [关键词...]
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const html = readFileSync(file, 'utf8')

// SSR 块形如: self.__pace_f.push([1,"...json 转义串..."])，其中 JSON 再含 \"roomStore\"
// 直接找包含 roomStore 的大段转义串，反转义两层后截取
function unescapeAll(s) {
  let prev = s
  for (let i = 0; i < 4; i++) {
    const next = prev.replace(/\\(["\\\/])/g, '$1').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    if (next === prev) break
    prev = next
  }
  return prev
}

const out = []
const re = /self\.__pace_f\.push\(\[/g
let m
while ((m = re.exec(html))) {
  // 从 push( [ 后取第一个 "..." 长字符串（简化：取到 ")]</script>" 或 60KB 上限）
  const start = m.index
  const seg = html.slice(start, start + 400_000)
  if (!seg.includes('roomStore') && !seg.includes('roomInfo')) continue
  out.push(seg.slice(0, 400_000))
}

console.log('pace chunks with roomStore:', out.length)
for (const seg of out) {
  const u = unescapeAll(seg)
  // 打印 roomStore 周边的键名概览
  const idx = u.indexOf('"roomStore"')
  if (idx >= 0) {
    const slice = u.slice(idx, idx + 4000)
    console.log('---- roomStore context ----')
    console.log(slice.replace(/,/g, ',\n').slice(0, 6000))
    break
  }
}
