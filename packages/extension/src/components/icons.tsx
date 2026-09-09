/**
 * Line icons, 1.5px stroke, 16px grid — matching the spec's iconography rule.
 * Hand-drawn rather than pulled from a set so the stroke weight and terminals
 * stay consistent with the hairline borders used everywhere else.
 */
interface IconProps { size?: number; className?: string }

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true" focusable="false"
    >
      {children}
    </svg>
  )
}

export const IconDatabase = (p: IconProps) => (
  <Svg {...p}>
    <ellipse cx="8" cy="3.75" rx="5" ry="2.25" />
    <path d="M3 3.75v8.5c0 1.24 2.24 2.25 5 2.25s5-1.01 5-2.25v-8.5" />
    <path d="M3 8c0 1.24 2.24 2.25 5 2.25S13 9.24 13 8" />
  </Svg>
)

export const IconSearch = (p: IconProps) => (
  <Svg {...p}><circle cx="7.25" cy="7.25" r="4.25" /><path d="m10.5 10.5 3 3" /></Svg>
)

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.6 1.9h2.8l.3 1.6 1.2.7 1.5-.6 1.4 2.4-1.2 1.05v1.4l1.2 1.05-1.4 2.4-1.5-.6-1.2.7-.3 1.6H6.6l-.3-1.6-1.2-.7-1.5.6-1.4-2.4 1.2-1.05v-1.4L2.2 6.0l1.4-2.4 1.5.6 1.2-.7.3-1.6Z" />
    <circle cx="8" cy="8" r="2.1" />
  </Svg>
)

/** Distinct from IconSettings so the two are never confused in the app bar. */
export const IconKey = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5.25" cy="5.25" r="2.75" />
    <path d="m7.2 7.2 6 6M10.7 10.7l-1.4 1.4M12.2 12.2l-1.4 1.4" />
  </Svg>
)

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 6.75 8 2.25l5.5 4.5v6a.75.75 0 0 1-.75.75H3.25a.75.75 0 0 1-.75-.75v-6Z" />
    <path d="M6.4 13.5V9.4h3.2v4.1" />
  </Svg>
)

export const IconExpand = (p: IconProps) => (
  <Svg {...p}><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" /></Svg>
)

export const IconBack = (p: IconProps) => (
  <Svg {...p}><path d="M9.5 3 4.5 8l5 5" /></Svg>
)

export const IconChevron = (p: IconProps) => (
  <Svg {...p}><path d="m5.5 3.5 5 4.5-5 4.5" /></Svg>
)

export const IconDownload = (p: IconProps) => (
  <Svg {...p}><path d="M8 2v7.5M5 7l3 3 3-3M2.5 12.5v1h11v-1" /></Svg>
)

export const IconCheck = (p: IconProps) => (
  <Svg {...p}><path d="m3 8.5 3.25 3.25L13 5" /></Svg>
)

export const IconAlert = (p: IconProps) => (
  <Svg {...p}><path d="M8 2.75 1.75 13.25h12.5L8 2.75Z" /><path d="M8 6.75v3M8 11.6v.1" /></Svg>
)

export const IconInfo = (p: IconProps) => (
  <Svg {...p}><circle cx="8" cy="8" r="6" /><path d="M8 7.25v3.75M8 5.15v.1" /></Svg>
)

export const IconX = (p: IconProps) => (
  <Svg {...p}><path d="m4 4 8 8M12 4l-8 8" /></Svg>
)

export const IconEye = (p: IconProps) => (
  <Svg {...p}><path d="M1.5 8S4 3.75 8 3.75 14.5 8 14.5 8 12 12.25 8 12.25 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="1.75" /></Svg>
)

export const IconEyeOff = (p: IconProps) => (
  <Svg {...p}><path d="M6.3 4.1A6.4 6.4 0 0 1 8 3.75C12 3.75 14.5 8 14.5 8a11 11 0 0 1-2.2 2.6M4 5.3A11 11 0 0 0 1.5 8S4 12.25 8 12.25c.6 0 1.2-.1 1.7-.25" /><path d="m2.5 2.5 11 11" /></Svg>
)

export const IconFile = (p: IconProps) => (
  <Svg {...p}><path d="M9 1.75H4.25v12.5h7.5V4.5L9 1.75Z" /><path d="M9 1.75V4.5h2.75" /></Svg>
)

export const IconLink = (p: IconProps) => (
  <Svg {...p}><path d="M6.75 9.25a2.5 2.5 0 0 0 3.54 0l2-2a2.5 2.5 0 0 0-3.54-3.54l-.9.9" /><path d="M9.25 6.75a2.5 2.5 0 0 0-3.54 0l-2 2a2.5 2.5 0 0 0 3.54 3.54l.9-.9" /></Svg>
)

export const IconSpark = (p: IconProps) => (
  <Svg {...p}><path d="M8 1.75 9.4 6.1l4.35 1.4-4.35 1.4L8 13.25 6.6 8.9 2.25 7.5 6.6 6.1 8 1.75Z" /></Svg>
)

export const IconShield = (p: IconProps) => (
  <Svg {...p}><path d="M8 1.75 3 3.5v4.25c0 3 2.1 5.4 5 6.5 2.9-1.1 5-3.5 5-6.5V3.5L8 1.75Z" /><path d="m5.9 8 1.5 1.5L10.2 6.7" /></Svg>
)

export const IconStop = (p: IconProps) => (
  <Svg {...p}><rect x="4" y="4" width="8" height="8" rx="1.5" /></Svg>
)

export const IconCopy = (p: IconProps) => (
  <Svg {...p}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 11h1" /></Svg>
)
