// 提取房间页 SSR 中真实 roomInfo(含 room_id_str)与 pk/linkmic 相关状态
// 用法: node extract_ssr3.mjs <room.html路径>
import { readFileSync } from 'node:fs'

const html = readFileSync(process.argv[2], 'utf8')

function unescapeAll(s) {
  let prev = s
  for (let i = 0; i < 4; i++) {
    const next = prev.replace(/\\(["\\\/])/g, '$1').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    if (next === prev) break
    prev = next
  }
  return prev
}

const whole = unescapeAll(html)

// 找非默认的 roomInfo（含 room_id_str 的那一个）
const ridIdx = whole.indexOf('room_id_str')
if (ridIdx >= 0) {
  // 回溯到 "roomInfo":{
  const start = whole.lastIndexOf('"roomInfo":{', ridIdx)
  const seg = whole.slice(start, start + 9000)
  console.log('== roomInfo(实数据) 前 9000 字符 ==')
  console.log(seg.replace(/,"/g, ',\n"'))
} else {
  console.log('room_id_str NOT FOUND')
}
