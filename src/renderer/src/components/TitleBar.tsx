import { useEffect, useState } from 'react'
import { api } from '../lib/dy'
import { IconLogo, IconWinClose, IconWinMax, IconWinMin, IconWinRestore } from './Icons'

/** 定制标题栏：替代系统标题栏，整条为拖拽区，右侧窗口控制按钮（与主题配色统一）；开发实例额外显示 dev 标记 */
export function TitleBar() {
  const [maxed, setMaxed] = useState(false)
  useEffect(() => api.onWinMaxChanged((e) => setMaxed(!!e?.maximized)), [])
  const isDev = import.meta.env.DEV

  return (
    <header className="titlebar">
      <div className="tb-brand">
        <IconLogo size={16} />
        <span className="tb-name">dy-live{isDev ? ' (dev)' : ''}</span>
      </div>
      <div className="tb-actions">
        <button className="tb-btn" title="最小化" onClick={() => void api.winMinimize()}>
          <IconWinMin />
        </button>
        <button className="tb-btn" title={maxed ? '向下还原' : '最大化'} onClick={() => void api.winMaximize()}>
          {maxed ? <IconWinRestore /> : <IconWinMax />}
        </button>
        <button className="tb-btn tb-close" title="关闭" onClick={() => void api.winClose()}>
          <IconWinClose />
        </button>
      </div>
    </header>
  )
}
