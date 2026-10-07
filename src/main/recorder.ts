import fs from 'node:fs'
import path from 'node:path'
import { app, dialog, type BrowserWindow } from 'electron'
import type { RecStartPayload, RecStartResult } from '@shared/types'
import { store } from './store'
import { log } from './util'

const DEFAULT_DIR_NAME = 'dy-live'

/** Windows/macOS 文件名非法字符与控制字符 */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g

function sanitize(raw: string, fallback: string): string {
  const s = String(raw ?? '')
    .replace(ILLEGAL, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
    .slice(0, 60)
  return s || fallback
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地时间戳：2026-10-07 19-30-05（文件名不含冒号） */
function stamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

/**
 * 直播录制落盘服务：渲染层用 MediaRecorder 出分片，这里按
 * <保存目录>/<主播id_名字>/年-月-日 时-分-秒.<ext> 逐片写入。
 * 写入用同步 fd：保证 IPC 分片顺序落盘，退出时可在 before-quit 同步收尾。
 */
export class RecordService {
  private fd: number | null = null
  private id = 0
  private file = ''

  get active(): boolean {
    return this.fd !== null
  }

  get filePath(): string {
    return this.file
  }

  /** 录制根目录：设置值优先，默认 系统视频目录/dy-live */
  resolveDir(): string {
    const custom = store.get().settings.recordDir
    if (custom) return custom
    try {
      return path.join(app.getPath('videos'), DEFAULT_DIR_NAME)
    } catch {
      return path.join(app.getPath('home'), 'Videos', DEFAULT_DIR_NAME)
    }
  }

  start(info: RecStartPayload): RecStartResult {
    if (this.fd !== null) throw new Error('已有录制任务进行中')
    const ext = /^\w{1,5}$/.test(info.ext) ? info.ext : 'mp4'
    const rid = info.webRid || info.roomId || info.secUid || 'room'
    const base = this.resolveDir()
    const ridPart = sanitize(rid, 'room')
    // 主播改名不分散录像：同一 id 已有目录（首次录制时的昵称）则复用
    let existing: string | undefined
    try {
      existing = fs
        .readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .find((name) => name === ridPart || name.startsWith(`${ridPart}_`))
    } catch {}
    const dir = path.join(base, existing ?? `${ridPart}_${sanitize(info.nickname, '主播')}`)
    fs.mkdirSync(dir, { recursive: true })
    let file = path.join(dir, `${stamp()}.${ext}`)
    let n = 2
    while (fs.existsSync(file)) file = path.join(dir, `${stamp()} (${n++}).${ext}`)
    this.fd = fs.openSync(file, 'a')
    this.id++
    this.file = file
    log('recorder', '开始录制:', file)
    return { id: this.id, file }
  }

  write(id: number, chunk: ArrayBuffer): boolean {
    if (this.fd === null || id !== this.id) return false
    try {
      fs.writeSync(this.fd, Buffer.from(chunk))
      return true
    } catch (e) {
      log('recorder', '写入失败:', (e as Error)?.message)
      return false
    }
  }

  /** 结束并落盘。id 不匹配（旧会话迟到）时不动当前录制，返回 null */
  stop(id?: number): string | null {
    if (this.fd === null) return null
    if (typeof id === 'number' && id !== this.id) return null
    const fd = this.fd
    this.fd = null
    const file = this.file
    this.file = ''
    try {
      fs.closeSync(fd)
    } catch (e) {
      log('recorder', '关闭文件失败:', (e as Error)?.message)
    }
    // 编码器冷启动早于首帧输出：只落下文件头碎片（不可播放）时直接丢弃
    try {
      const size = fs.statSync(file).size
      if (size <= 4096) {
        fs.unlinkSync(file)
        log('recorder', '录制内容过短，已丢弃:', file, size)
        return null
      }
    } catch (e) {
      log('recorder', '检查录制文件失败:', (e as Error)?.message)
    }
    log('recorder', '录制结束:', file)
    return file
  }

  /** 设置菜单：目录选择对话框；选中即写入设置并返回生效目录 */
  async pickDir(win: BrowserWindow | null): Promise<string> {
    const opts = {
      title: '选择直播录制保存位置',
      defaultPath: this.resolveDir(),
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const res = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (!res.canceled && res.filePaths[0]) {
      store.patch({ settings: { recordDir: res.filePaths[0] } })
    }
    return this.resolveDir()
  }
}
