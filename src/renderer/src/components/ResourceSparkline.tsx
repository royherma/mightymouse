import { JSX } from 'react'

const WIDTH = 240
const HEIGHT = 64

export function buildSparklinePath(samples: number[]): string {
  const data = trimLead(samples).slice(-120)
  if (data.length < 2) return ''
  const max = Math.max(...data, 0.0001)
  const stepX = WIDTH / (data.length - 1)
  return data
    .map((value, index) => {
      const x = index * stepX
      const y = HEIGHT - (value / max) * (HEIGHT - 2) - 1
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

function trimLead(samples: number[]): number[] {
  let index = 0
  while (index < samples.length - 2 && samples[index] === 0) index++
  return samples.slice(index)
}

export function ResourceSparkline({ samples }: { samples: number[] }): JSX.Element | null {
  const line = buildSparklinePath(samples)
  if (!line) return null
  const area = `${line} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`
  return (
    <svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
      <path d={area} fill="var(--accent-wash)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
