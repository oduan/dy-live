/**
 * 极简 protobuf 解码（proto-lite）：只为直播间弹幕服务。
 * 抖音 IM 协议里我们只关心少数定长字段（string/bytes/varint），
 * 与其引入完整 protobufjs，不如按 wire format 直接解字段号，协议漂移时改这里即可。
 *
 * wire types: 0=varint, 1=64bit, 2=length-delimited, 5=32bit
 */
export interface ProtoField {
  no: number
  wire: number
  /** wire=2 时的原始字节 */
  bytes: Buffer
  /** wire=0 时的整型值 */
  int: bigint
}

export function decodeFields(buf: Buffer): Map<number, ProtoField[]> {
  const out = new Map<number, ProtoField[]>()
  let pos = 0
  const push = (f: ProtoField): void => {
    const list = out.get(f.no)
    if (list) list.push(f)
    else out.set(f.no, [f])
  }
  while (pos < buf.length) {
    const key = readVarint(buf, pos)
    if (!key) break
    pos = key.next
    const no = Number(key.value >> 3n)
    const wire = Number(key.value & 7n)
    if (no === 0) break
    if (wire === 0) {
      const v = readVarint(buf, pos)
      if (!v) break
      pos = v.next
      push({ no, wire, bytes: Buffer.alloc(0), int: v.value })
    } else if (wire === 1) {
      if (pos + 8 > buf.length) break
      push({ no, wire, bytes: buf.subarray(pos, pos + 8), int: 0n })
      pos += 8
    } else if (wire === 2) {
      const len = readVarint(buf, pos)
      if (!len) break
      pos = len.next
      const n = Number(len.value)
      if (pos + n > buf.length) break
      push({ no, wire, bytes: buf.subarray(pos, pos + n), int: 0n })
      pos += n
    } else if (wire === 5) {
      if (pos + 4 > buf.length) break
      push({ no, wire, bytes: buf.subarray(pos, pos + 4), int: 0n })
      pos += 4
    } else {
      break // 未知 wire type，放弃剩余部分
    }
  }
  return out
}

function readVarint(buf: Buffer, start: number): { value: bigint; next: number } | null {
  let value = 0n
  let shift = 0n
  let pos = start
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) return null
    const b = buf[pos++]
    value |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) return { value, next: pos }
    shift += 7n
  }
  return null
}

// ---------- 常用取值辅助 ----------

export function fstr(f?: ProtoField): string {
  return f && f.wire === 2 ? f.bytes.toString('utf8') : ''
}

export function fint(f?: ProtoField): number {
  return f ? Number(f.int) : 0
}

/** 把值按 varint 字段号编码（用于发送方向的极简封装） */
export function encodeVarintField(no: number, value: number): Buffer {
  return Buffer.concat([encodeKey(no, 0), encodeVarint(BigInt(value))])
}

/** 把 bytes 按 length-delimited 字段号编码 */
export function encodeBytesField(no: number, bytes: Buffer): Buffer {
  return Buffer.concat([encodeKey(no, 2), encodeVarint(BigInt(bytes.length)), bytes])
}

export function encodeVarint(value: bigint): Buffer {
  const out: number[] = []
  let v = value
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  out.push(Number(v))
  return Buffer.from(out)
}

function encodeKey(no: number, wire: number): Buffer {
  return encodeVarint((BigInt(no) << 3n) | BigInt(wire))
}
