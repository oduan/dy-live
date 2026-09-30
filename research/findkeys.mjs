// 关键字定位：打印房间页反转义文本中各关键词出现位置与上下文
// 用法: node findkeys.mjs <file.html> <kw1> <kw2> ...
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

const [file, ...kws] = process.argv.slice(2)
const w = unescapeAll(readFileSync(file, 'utf8'))
for (const kw of kws) {
  const idxs = []
  let i = -1
  while ((i = w.indexOf(kw, i + 1)) >= 0 && idxs.length < 6) idxs.push(i)
  console.log(`# ${kw}: ${idxs.length ? idxs.join(',') : 'none'}`)
  for (const ix of idxs.slice(0, 2)) {
    console.log('   ', JSON.stringify(w.slice(ix, ix + 300)).slice(0, 340))
  }
}
