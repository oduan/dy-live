// 批量探测房间页 SSR 的连麦/PK 状态
// 用法: node probe_pk.mjs <rid1> <rid2> ...
import { readFileSync } from 'node:fs'

function unescapeAll(s) {
  let prev = s
  for (let i = 0; i < 4; i++) {
    const next = prev.replace(/\\(["\\\/])/g, '$1').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    if (next === prev) break
    prev = next
  }
  return prev
}

for (const rid of process.argv.slice(2)) {
  let html
  try {
    html = readFileSync(`probe_${rid}.html`, 'utf8')
  } catch {
    console.log(`${rid} READ_FAIL`)
    continue
  }
  const w = unescapeAll(html)
  const linkerMap = (w.match(/"linker_map":(\{[^}]?\})/) || [])[1] || '{}'
  const roomTitle = (w.match(/"title":"([^"]{0,40})/) || [])[1] || ''
  const inPk = /"is_in_pk":(true|1)/.test(w) || /"isInPK":true/.test(w)
  const hasSeats = /"imLinkMicSeats":\{"0":\{"idx":0,"[^}]/.test(w) // 席位含额外字段=有数据
  const linkMicIds = (w.match(/"link_mic_id[^,]*/g) || []).slice(0, 2)
  const battleType = (w.match(/"roomBattleType":"(\w+)"/) || [])[1] || ''
  const markers = []
  if (linkerMap !== '{}') markers.push(`linker_map=${linkerMap.slice(0, 60)}`)
  if (inPk) markers.push('IN_PK')
  if (hasSeats) markers.push('seats_data')
  if (linkMicIds.length) markers.push(`link_mic_id:${linkMicIds.join('|').slice(0, 60)}`)
  console.log(`${rid} | ${roomTitle} | battle=${battleType} | ${markers.join(' ; ') || '-'}`)
}
