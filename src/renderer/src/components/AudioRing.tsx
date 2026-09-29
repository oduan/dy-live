import { useEffect, useRef } from 'react'

/**
 * 音频可视化光圈：金色旋转圆弧 + 环绕星星粒子，随实时音频能量呼吸/迸发。
 * 数据来自 Web Audio AnalyserNode（接在 MSE 播放管道上，同源 blob 无跨域污染）；
 * 无分析数据（静音/未就绪）时退化为缓慢的待机动效。
 */
export function AudioRing(props: { analyser: AnalyserNode | null; size?: number; dimmed?: boolean }) {
  const size = props.size ?? 200
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // 最新 props 经 ref 供 rAF 循环读取，避免每帧重启循环
  const analyserRef = useRef<AnalyserNode | null>(props.analyser)
  const dimmedRef = useRef<boolean>(!!props.dimmed)
  analyserRef.current = props.analyser
  dimmedRef.current = !!props.dimmed

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)

    const buf = { data: new Uint8Array(0) }
    const CX = size / 2
    const R0 = size * 0.39

    interface P {
      ang: number
      r: number
      orbit: number
      speed: number
      life: number
      decay: number
      size: number
      hue: number // 0 金 1 白
    }
    const parts: P[] = []
    let raf = 0
    let last = performance.now()
    let bassAvg = 0.12
    let beatCooldown = 0
    let rot = 0

    const star = (x: number, y: number, r: number, rot: number, alpha: number, hue: number): void => {
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(rot)
      ctx.fillStyle = hue ? `rgba(255,248,225,${alpha})` : `rgba(255,214,110,${alpha})`
      ctx.beginPath()
      const inner = r * 0.26
      for (let i = 0; i < 8; i++) {
        const rad = i % 2 === 0 ? r : inner
        const a = (Math.PI / 4) * i
        const px = Math.cos(a) * rad
        const py = Math.sin(a) * rad
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.fill()
      ctx.restore()
    }

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      const dim = dimmedRef.current ? 0.45 : 1

      // ---- 读取实时音频能量 ----
      let bass = 0
      let level = 0
      const an = analyserRef.current
      if (an) {
        if (buf.data.length !== an.frequencyBinCount) buf.data = new Uint8Array(an.frequencyBinCount)
        an.getByteFrequencyData(buf.data)
        let b = 0
        for (let i = 1; i <= 8; i++) b += buf.data[i]
        bass = b / 8 / 255
        let s = 0
        for (let i = 0; i < buf.data.length; i++) s += buf.data[i]
        level = s / buf.data.length / 255
      }
      // 静音/无数据时用缓慢正弦做待机呼吸
      const idle = an ? 0 : 0.1 + 0.06 * Math.sin(now / 900)
      const energy = Math.max(level, idle * 0.6)
      const pulse = Math.max(bass, idle)

      // 节拍检测：低频能量突增 → 迸发粒子
      bassAvg = bassAvg * 0.96 + bass * 0.04
      beatCooldown -= dt
      if (bass > 0.12 && bass > bassAvg * 1.4 && beatCooldown <= 0) {
        beatCooldown = 0.18
        const n = 5 + Math.round(bass * 6)
        for (let i = 0; i < n && parts.length < 90; i++) {
          parts.push({
            ang: Math.random() * Math.PI * 2,
            orbit: R0 + 4 + Math.random() * 22,
            r: 0,
            speed: (0.35 + Math.random() * 0.7) * (Math.random() < 0.5 ? -1 : 1),
            life: 1,
            decay: 0.5 + Math.random() * 0.6,
            size: 2 + Math.random() * (bass * 9 + 3),
            hue: Math.random() < 0.4 ? 1 : 0
          })
        }
      }

      // ---- 绘制 ----
      ctx.clearRect(0, 0, size, size)
      ctx.save()
      ctx.globalAlpha = dim

      rot += dt * (0.35 + energy * 0.9)
      const R = R0 * (1 + pulse * 0.09) // 低频呼吸

      // 光晕底
      ctx.beginPath()
      ctx.arc(CX, CX, R + 10, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255,205,110,${0.1 + energy * 0.16})`
      ctx.lineWidth = 10 + energy * 14
      ctx.shadowColor = 'rgba(255,200,90,0.9)'
      ctx.shadowBlur = 14 + energy * 26
      ctx.stroke()

      // 三段主弧（不同半径/速度/跨度，留缺口）
      const arcs = [
        { r: R, sp: 1, span: 1.9, w: 2.6, a: 0.95 },
        { r: R + 7, sp: -0.62, span: 1.1, w: 1.8, a: 0.6 },
        { r: R - 7, sp: 0.4, span: 2.6, w: 1.2, a: 0.4 }
      ]
      for (const a of arcs) {
        const start = rot * a.sp + a.span * 0.7
        ctx.beginPath()
        ctx.arc(CX, CX, a.r, start, start + a.span)
        ctx.strokeStyle = `rgba(255,214,120,${a.a})`
        ctx.lineWidth = a.w
        ctx.lineCap = 'round'
        ctx.shadowBlur = 10 + energy * 16
        ctx.stroke()
        // 弧端亮点
        const ex = CX + Math.cos(start + a.span) * a.r
        const ey = CX + Math.sin(start + a.span) * a.r
        ctx.beginPath()
        ctx.arc(ex, ey, a.w * 0.9, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255,244,200,${a.a})`
        ctx.fill()
      }
      ctx.shadowBlur = 0

      // 粒子更新与绘制
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]
        p.life -= p.decay * dt
        if (p.life <= 0) {
          parts.splice(i, 1)
          continue
        }
        p.ang += p.speed * dt * (1 + energy)
        p.r += dt * 6
        const x = CX + Math.cos(p.ang) * (p.orbit + p.r)
        const y = CX + Math.sin(p.ang) * (p.orbit + p.r)
        const a = Math.min(1, p.life * 1.4) * (0.55 + level * 0.6)
        star(x, y, p.size * (0.5 + p.life * 0.5), p.ang * 2, a, p.hue)
      }
      ctx.restore()
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [size])

  return <canvas ref={canvasRef} className="audio-ring" style={{ width: size, height: size }} aria-hidden="true" />
}
