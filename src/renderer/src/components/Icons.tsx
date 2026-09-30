import type { ReactNode, SVGProps } from 'react'

function Svg({ children, size = 18, ...rest }: { children: ReactNode; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconTimer = ({ size = 18, className }: { size?: number; className?: string }) => (
  <Svg size={size} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.2 1.8" />
  </Svg>
)

export const IconChat = ({ size = 18, className }: { size?: number; className?: string }) => (
  <Svg size={size} className={className}>
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </Svg>
)

export const IconPlay = ({ size = 18 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
    <path d="M8 5.2v13.6c0 .8.9 1.3 1.6.9l10.6-6.8c.6-.4.6-1.4 0-1.8L9.6 4.3C8.9 3.9 8 4.4 8 5.2z" />
  </svg>
)

export const IconPause = ({ size = 18 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
    <rect x="6" y="4.5" width="4" height="15" rx="1.2" />
    <rect x="14" y="4.5" width="4" height="15" rx="1.2" />
  </svg>
)

export const IconRefresh = ({ size = 18, className }: { size?: number; className?: string }) => (
  <Svg size={size} className={className}>
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 4v5h-5" />
  </Svg>
)

export const IconVolume = ({ size = 18 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19z" />
    <path d="M15 9.5a3.5 3.5 0 0 1 0 5" />
    <path d="M17.8 7a7 7 0 0 1 0 10" />
  </Svg>
)

export const IconMute = ({ size = 18 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19z" />
    <path d="m15.5 9.5 5 5m0-5-5 5" />
  </Svg>
)

export const IconExternal = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M19 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Svg>
)

export const IconMaximize = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4" />
    <path d="M20 9V5a1 1 0 0 0-1-1h-4" />
    <path d="M4 15v4a1 1 0 0 0 1 1h4" />
    <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
  </Svg>
)

export const IconFullscreen = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3 8V5a2 2 0 0 1 2-2h3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
  </Svg>
)

export const IconSettings = ({ size = 17 }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3H9.8l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4.4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.06-.4.1-.8.1-1.2z" />
  </Svg>
)

export const IconLogout = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M9 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3" />
    <path d="M15 8l4 4-4 4" />
    <path d="M19 12H9" />
  </Svg>
)

export const IconBack = ({ size = 18, className }: { size?: number; className?: string }) => (
  <Svg size={size} className={className}>
    <path d="M19 12H5" />
    <path d="m11 18-6-6 6-6" />
  </Svg>
)

export const IconLive = ({ size = 8 }: { size?: number }) => (
  <svg viewBox="0 0 8 8" width={size} height={size} aria-hidden="true">
    <circle cx="4" cy="4" r="4" fill="currentColor" />
  </svg>
)

export const IconUsers = ({ size = 13 }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.6a3.2 3.2 0 0 1 0 4.8M17.8 13.4a5.5 5.5 0 0 1 2.7 4.6" />
  </Svg>
)

export const IconHeadphones = ({ size = 13 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
    <path d="M4 14h2.5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zm16 0h-2.5a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1H19a1 1 0 0 0 1-1z" />
  </Svg>
)

export const IconVideo = ({ size = 13 }: { size?: number }) => (
  <Svg size={size}>
    <rect x="3" y="6.5" width="13" height="11" rx="2" />
    <path d="m16 10.5 5-2.5v8l-5-2.5" />
  </Svg>
)

export const IconAlert = ({ size = 20 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 3 2.5 19.5h19z" />
    <path d="M12 9.5v4.5" />
    <circle cx="12" cy="16.8" r="0.4" fill="currentColor" />
  </Svg>
)

export const IconLogo = ({ size = 26 }: { size?: number }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
    <rect x="2" y="2" width="28" height="28" rx="8" fill="#25f4ee" opacity="0.22" />
    <path d="M12 9.5v13l10-6.5z" fill="#fe2c55" />
    <path d="M12 9.5v13l10-6.5z" fill="#25f4ee" opacity="0.45" transform="translate(3 -1.5)" />
  </svg>
)
