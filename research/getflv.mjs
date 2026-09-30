// 提取房间页 SSR 的 flv_pull_url 各清晰度地址
// 用法: node getflv.mjs <room.html路径>
import { readFileSync } from 'node:fs'

function unescapeAll(s) {
  let p = s
  for (let i = 0; i < 4; i++) {
    const n = p.replace(/\\(["\\\/])/g, '$1')
    if (n === p) break
    p = n
  }
  return p
}

const w = unescapeAll(readFileSync(process.argv[2], 'utf8'))
const m = w.match(/"flv_pull_url":(\{.*?\})/)
if (!m) {
  console.log('NOT FOUND')
  process.exit(1)
}
const obj = JSON.parse(m[1].replace(/\\(["\\\/])/g, '$1').replace(/\\"/g, '"'))
for (const [k, v] of Object.entries(obj)) console.log(`${k} ${v}`)
