// 从 f2 的 pb2.py 序列化 FileDescriptorProto 里提取 LightGiftMessage 字段号
const fs = require('fs')

const src = fs.readFileSync(process.argv[2], 'utf8')
const callAt = src.indexOf('AddSerializedFile(')
if (callAt < 0) throw new Error('未找到 AddSerializedFile')
const start = src.indexOf("b'", callAt)
if (start < 0) throw new Error('未找到 bytes 字面量')
const bodyStart = start + 2
// 逐字符扫描到未转义的 '
let raw = []
for (let i = bodyStart; i < src.length; i++) {
  const c = src[i]
  if (c === '\\') {
    raw.push(c, src[i + 1])
    i++
    continue
  }
  if (c === "'") break
  raw.push(c)
}
// 还原 Python bytes 转义
let blob = Buffer.from(raw.join('').replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
  .replace(/\\\\/g, '\\').replace(/\\'/g, "'").replace(/\\"/g, '"'), 'binary')
console.log('descriptor bytes:', blob.length)

// 极简 protobuf 游走：FileDescriptorProto → message_type(4) 递归 → 找目标消息
function rv(b, p) {
  let v = 0n, s = 0n
  for (;;) {
    if (p >= b.length) return null
    const x = b[p++]
    v |= BigInt(x & 0x7f) << s
    if (!(x & 0x80)) return { v, p }
    s += 7n
  }
}
function fields(buf) {
  const out = []
  let p = 0
  while (p < buf.length) {
    const k = rv(buf, p)
    if (!k) break
    p = k.p
    const no = Number(k.v >> 3n), wire = Number(k.v & 7n)
    if (wire === 0) { const v = rv(buf, p); if (!v) break; p = v.p; out.push({ no, wire, v: v.v, b: null }) }
    else if (wire === 2) { const l = rv(buf, p); if (!l) break; p = l.p; const n = Number(l.v); out.push({ no, wire, b: buf.subarray(p, p + n) }); p += n }
    else break
  }
  return out
}
function sOf(f) { return f.b ? f.b.toString('utf8') : '' }

const TYPE = { 1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32', 8: 'bool', 9: 'string', 11: 'message', 12: 'bytes', 13: 'uint32', 14: 'enum', 15: 'sfixed32', 16: 'sfixed64', 17: 'sint32', 18: 'sint64' }

function dumpMessage(desc, indent) {
  const fs2 = fields(desc)
  const name = sOf(fs2.find((f) => f.no === 1) ?? { b: null })
  console.log(`${indent}message ${name}`)
  for (const fd of fs2.filter((f) => f.no === 2)) {
    const ff = fields(fd.b)
    const fname = sOf(ff.find((f) => f.no === 1) ?? { b: null })
    const fno = Number((ff.find((f) => f.no === 3) ?? { v: 0n }).v)
    const ftype = Number((ff.find((f) => f.no === 5) ?? { v: 0n }).v)
    const tname = sOf(ff.find((f) => f.no === 6) ?? { b: null }).replace(/^\.+/, '')
    console.log(`${indent}  ${fno}: ${fname} : ${TYPE[ftype] || ftype}${tname ? ' -> ' + tname : ''}`)
  }
  for (const nd of fs2.filter((f) => f.no === 3)) dumpMessage(nd.b, indent + '  ')
}

const root = fields(blob)
for (const mt of root.filter((f) => f.no === 4)) dumpMessage(mt.b, '')
