import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { store } from './store'
import { debounce } from './util'

export function createMainWindow(): BrowserWindow {
  const saved = store.get().window ?? {}
  const [defW, defH] = [1280, 820]
  // 位置超出可见屏幕（例如换过显示器）时回退默认
  let usePos = false
  if (typeof saved.x === 'number' && typeof saved.y === 'number') {
    usePos = screen.getAllDisplays().some((d) => {
      const { x, y, width, height } = d.bounds
      return saved.x! >= x && saved.x! < x + width && saved.y! >= y && saved.y! < y + height
    })
  }
  const win = new BrowserWindow({
    width: saved.width || defW,
    height: saved.height || defH,
    x: usePos ? saved.x : undefined,
    y: usePos ? saved.y : undefined,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#0d0e12',
    // 无边框窗口：系统标题栏由渲染层的定制标题栏替代（拖拽/窗口控制按钮）
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
      // 直播录制（captureStream）依赖隐藏状态下仍持续出帧，不做后台节流
      backgroundThrottling: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // 最大化状态变化同步给渲染层：标题栏据此切换最大化/还原图标
  const sendMaxState = (): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.EvWinMaxChanged, { maximized: win.isMaximized() })
  }
  win.on('maximize', sendMaxState)
  win.on('unmaximize', sendMaxState)

  const saveBounds = debounce(() => {
    if (win.isDestroyed() || win.isMinimized()) return
    const [x, y] = win.getPosition()
    const [width, height] = win.getSize()
    store.patch({ window: { x, y, width, height } })
  }, 800)
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('close', () => {
    const [x, y] = win.getPosition()
    const [width, height] = win.getSize()
    store.patch({ window: { x, y, width, height } })
    store.flush()
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}
