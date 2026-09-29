/** 侧栏头部的应用更新提示：发现新版本时出现，点击下载，完成后自动安装重启 */
import { useEffect, useState } from 'react'
import type { UpdateStateEvent } from '@shared/types'
import { api } from '../lib/dy'

export function UpdateBadge() {
  const [st, setSt] = useState<UpdateStateEvent | null>(null)

  useEffect(() => {
    // 挂载时先同步一次当前状态（事件可能在订阅前已发出）
    void api.updateGetState().then(setSt)
    return api.onUpdateState(setSt)
  }, [])

  if (!st) return null

  if (st.status === 'downloading') {
    return (
      <span className="update-pill busy" title="正在下载更新">
        <span className="dot pulse" /> 更新中 {Math.round(st.percent ?? 0)}%
      </span>
    )
  }
  if (st.status === 'downloaded' || st.status === 'installing') {
    return (
      <span className="update-pill busy" title="更新包已就绪">
        <span className="dot pulse" /> {st.status === 'downloaded' ? '即将安装…' : '正在安装…'}
      </span>
    )
  }

  // available / error：可点击
  const failed = st.status === 'error'
  return (
    <button
      className="update-pill"
      title={failed ? `更新失败，点击重试（${st.message ?? ''}）` : `发现新版本 v${st.version}，点击自动下载并安装`}
      onClick={() => void api.updateInstall()}
    >
      <span className="dot" /> {failed ? '更新失败·重试' : `新版本 v${st.version}`}
    </button>
  )
}
