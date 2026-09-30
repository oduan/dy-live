// 提取房间页 SSR 中的 linkmicStore 全文 + link_mic/stream_url 关键片段
// 用法: node extract_ssr2.mjs <room.html路径>
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

// 在整页反转义后的文本上做关键字定位
const whole = unescapeAll(html)

const dump = (label, key, spanBefore = 0, span = 3000) => {
  const idx = whole.indexOf(key)
  if (idx < 0) {
    console.log(`== ${label}: NOT FOUND (${key})`)
    return
  }
  console.log(`== ${label} @${idx} ==`)
  console.log(whole.slice(Math.max(0, idx - spanBefore), idx + span))
  console.log('')
}

dump('linkmicStore', '"linkmicStore"', 0, 6000)
dump('link_mic', '"link_mic"', 300, 2000)
dump('stream_url', '"stream_url"', 0, 2500)
