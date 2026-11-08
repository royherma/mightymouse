import { useId, type JSX } from 'react'
import { avatarFor, type AgentShape } from './agent-face'

export function AgentFaceMark({
  shape,
  color,
  size = 22,
  dim
}: {
  shape: AgentShape
  color: string
  size?: number
  dim?: boolean
}): JSX.Element {
  const clipId = useId().replace(/:/g, '')
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden
      style={{ display: 'block', flexShrink: 0, opacity: dim ? 0.45 : undefined }}
    >
      <defs>
        <clipPath id={clipId}>
          <ShapeGeom shape={shape} />
        </clipPath>
      </defs>
      <ShapeGeom shape={shape} fill={color} />
      <g clipPath={`url(#${clipId})`}>
        <rect x="11.2" y="11.5" width="3" height="7" rx="1.5" fill="white" />
        <rect x="17.8" y="11.5" width="3" height="7" rx="1.5" fill="white" />
      </g>
    </svg>
  )
}

export function AgentFace({
  id,
  size = 22,
  src,
  dim
}: {
  id: string
  size?: number
  src?: string
  dim?: boolean
}): JSX.Element {
  if (src) {
    return (
      <img
        src={src}
        width={size}
        height={size}
        alt=""
        aria-hidden
        style={{
          display: 'block',
          flexShrink: 0,
          objectFit: 'cover',
          borderRadius: Math.round(size * 0.28),
          opacity: dim ? 0.45 : undefined
        }}
      />
    )
  }
  const { shape, color } = avatarFor(id)
  return <AgentFaceMark shape={shape} color={color} size={size} dim={dim} />
}

/** Direct geometry only — a `<g>` inside `<clipPath>` is ignored, which made
 *  every quatrefoil hash paint an empty box. */
function ShapeGeom({ shape, fill }: { shape: AgentShape; fill?: string }): JSX.Element {
  const props = fill ? { fill } : undefined
  switch (shape) {
    case 'circle':
      return <circle cx="16" cy="16" r="15" {...props} />
    case 'squircle':
      return <rect x="1" y="1" width="30" height="30" rx="10" {...props} />
    case 'quatrefoil':
      return (
        <>
          <circle cx="16" cy="9.5" r="8.5" {...props} />
          <circle cx="22.5" cy="16" r="8.5" {...props} />
          <circle cx="16" cy="22.5" r="8.5" {...props} />
          <circle cx="9.5" cy="16" r="8.5" {...props} />
        </>
      )
    case 'hexagon':
      return <polygon points="16,1.5 29.5,9 29.5,23 16,30.5 2.5,23 2.5,9" {...props} />
    case 'diamond':
      return <polygon points="16,1.5 30.5,16 16,30.5 1.5,16" {...props} />
  }
}
