/** 应用自动更新：基于 electron-updater + GitHub Releases
 *
 * 仅在打包后的 Windows 上启用（macOS 未签名无法走静默更新）。
 * 启动后立即检查一次，之后每 10 分钟检查一次；发现新版本广播给渲染层，
 * 用户点击后开始下载，下载完成自动以静默方式安装并重启。
 */
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import { IPC } from '@shared/ipc'
import type { UpdateStateEvent } from '@shared/types'
import { log } from './util'

const { autoUpdater } = electronUpdater

const CHECK_INTERVAL_MS = 10 * 60 * 1000
/** 下载完成到自动安装的缓冲，让渲染层来得及展示"即将安装" */
const INSTALL_DELAY_MS = 1500

export class UpdateService {
  private broadcast: (channel: string, payload: unknown) => void
  private state: UpdateStateEvent | null = null
  private downloadStarted = false
  private installScheduled = false

  constructor(broadcast: (channel: string, payload: unknown) => void) {
    this.broadcast = broadcast
  }

  private emit(next: UpdateStateEvent | null): void {
    this.state = next
    if (next) this.broadcast(IPC.EvUpdateState, next)
  }

  getState(): UpdateStateEvent | null {
    return this.state
  }

  /** 渲染层点击"更新"后触发下载 */
  startDownload(): boolean {
    if (this.downloadStarted) return false
    if (this.state?.status !== 'available' && this.state?.status !== 'error') return false
    this.downloadStarted = true
    log('updater', '开始下载新版本')
    this.emit({ status: 'downloading', percent: 0 })
    autoUpdater.downloadUpdate().catch((e: unknown) => {
      log('updater', '下载启动失败:', (e as Error)?.message)
    })
    return true
  }

  start(): void {
    if (!app.isPackaged) {
      log('updater', '开发环境跳过更新检查')
      return
    }
    if (process.platform !== 'win32') {
      // macOS 未做代码签名，electron-updater 无法校验安装包，静默跳过
      log('updater', `平台 ${process.platform} 暂不支持自动更新`)
      return
    }

    autoUpdater.autoDownload = false
    autoUpdater.logger = {
      info: (...a: any[]) => log('updater', ...a),
      warn: (...a: any[]) => log('updater', 'warn:', ...a),
      error: (...a: any[]) => log('updater', 'error:', ...a)
    }

    autoUpdater.on('update-available', (info) => {
      this.downloadStarted = false
      log('updater', '发现新版本', info.version)
      this.emit({ status: 'available', version: info.version })
    })
    autoUpdater.on('update-not-available', () => {
      // 仅当此前展示过"可更新/失败"时才收回提示，避免打断下载中的状态
      if (this.state?.status === 'available' || this.state?.status === 'error') this.emit(null)
    })
    let lastPercent = -1
    autoUpdater.on('download-progress', (p) => {
      const percent = Math.round(p.percent)
      if (percent === lastPercent) return
      lastPercent = percent
      this.emit({ status: 'downloading', percent })
    })
    autoUpdater.on('update-downloaded', () => {
      if (this.installScheduled) return
      this.installScheduled = true
      log('updater', '下载完成，准备安装')
      this.emit({ status: 'downloaded' })
      setTimeout(() => {
        this.emit({ status: 'installing' })
        log('updater', '退出并安装新版本')
        autoUpdater.quitAndInstall(true, true)
      }, INSTALL_DELAY_MS)
    })
    autoUpdater.on('error', (e) => {
      const msg = (e as Error)?.message ?? String(e)
      log('updater', '出错:', msg)
      // 后台例行检查失败不打扰用户；下载过程中的失败才展示，点击可重试
      if (this.downloadStarted) {
        this.downloadStarted = false
        this.emit({ status: 'error', message: msg })
      }
    })

    // 首次打开检查一次，之后每 10 分钟一次；稍等片刻避开启动期的其他网络请求
    setTimeout(() => {
      this.check()
      setInterval(() => this.check(), CHECK_INTERVAL_MS)
    }, 3_000)
  }

  private check(): void {
    autoUpdater.checkForUpdates().catch((e: unknown) => {
      log('updater', '检查更新失败:', (e as Error)?.message)
    })
  }
}
