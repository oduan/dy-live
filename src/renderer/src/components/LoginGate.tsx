import React, { useEffect, useRef } from 'react'
import { IconLogo } from './Icons'

// React 不内置 webview 标签类型，用别名透传属性
const Webview = 'webview' as unknown as React.FC<{
  partition: string
  src: string
  style?: React.CSSProperties
  ref?: React.Ref<HTMLElement>
}>

/** 扫码登录页：内嵌 webview 打开抖音首页（登录 Cookie 存于 persist:douyin 分区） */
export function LoginGate() {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    // webview 加载失败重试一次（首启网络慢时常见）
    const el = ref.current as unknown as { reload: () => void; addEventListener: Function; removeEventListener: Function } | null
    if (!el) return
    const onFail = (): void => {
      setTimeout(() => {
        try {
          el.reload()
        } catch {}
      }, 2500)
    }
    el.addEventListener('did-fail-load', onFail)
    return () => el.removeEventListener('did-fail-load', onFail)
  }, [])

  return (
    <div className="login-wrap">
      <div className="login-brand">
        <div className="brand-row">
          <IconLogo size={40} />
          <h1>dy-live</h1>
        </div>
        <p className="brand-sub">抖音关注直播 · 桌面观看</p>
        <ul className="brand-points">
          <li>登录后自动汇总「关注」中正在直播的主播</li>
          <li>视频直播 / 音频直播 / 语音厅 均可观看</li>
          <li>直播画面以<b>游客身份</b>加载，与你的账号隔离</li>
          <li>登录凭证仅保存在本机，不会上传</li>
        </ul>
        <div className="login-steps">
          <p>1. 点击右侧页面右上角的「登录」</p>
          <p>2. 使用抖音 App 扫码完成登录</p>
          <p>3. 如出现滑块验证，请在页面内完成</p>
        </div>
      </div>
      <div className="login-frame">
        <Webview
          ref={ref as never}
          partition="persist:douyin"
          src="https://www.douyin.com/"
          style={{ width: '100%', height: '100%', border: 'none', borderRadius: 12, background: '#fff' }}
        />
      </div>
    </div>
  )
}
