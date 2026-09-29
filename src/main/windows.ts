import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
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
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

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
