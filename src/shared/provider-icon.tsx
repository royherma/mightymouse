import React from 'react'
import { HardDrive, Sparkles, Zap } from 'lucide-react'
import { MouseGlyph } from './mouse-glyph'

// Brand glyphs for the AI Model picker. Inline SVG so we ship no extra assets
// and the marks inherit currentColor / theme tokens. One per backend id, plus
// one per OpenRouter model provider used by ModelPicker.tsx's per-conversation
// catalog (CONFIG.MODEL_CATALOG).
//
// - mightymouse → the shared MouseGlyph (same head used by the cursor overlay)
// - claude      → Anthropic "sunburst" mark
// - codex       → OpenAI knot mark
// - opencode    → OpenCode square mark
// - gemini      → Google Gemini sparkle mark
// - glm         → Zhipu/Z.ai geometric monogram (currentColor — no official brand color to license)
// - deepseek    → DeepSeek whale-fin monogram (currentColor)
// - kimi        → Moonshot AI crescent monogram (currentColor)
// - qwen        → Qwen facet monogram (currentColor)
// - grok        → xAI "X" monogram (currentColor)
// - auto        → not a brand — the "let the server pick" option, a sparkle reads as "smart routing"
// - local       → not a brand, so a plain lucide icon (no logo to license) instead of hand-rolled SVG
export type ProviderIconId =
  | 'mightymouse'
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'gemini'
  | 'glm'
  | 'deepseek'
  | 'kimi'
  | 'qwen'
  | 'grok'
  | 'meta'
  | `letter:${string}`
  | 'auto'
  | 'local'
  | 'mlx'
  | 'openrouter'

function ClaudeMark({ size }: { size: number }): React.ReactElement {
  // Official Anthropic "A\" mark. Native viewBox is 46×32; height scaled to keep
  // the wedge proportions. Brand orange (#D97757).
  return (
    <svg viewBox="0 0 46 32" width={size} height={(size * 32) / 46} fill="#D97757" aria-hidden>
      <path d="M32.73 0h-6.96L38.4 32h6.96L32.73 0ZM13.27 0 0 32h7.1l2.71-7.04h13.89L25.62 32h7.1L19.45 0h-6.18Zm-1.18 19.04 4.54-11.77 4.54 11.77H12.09Z" />
    </svg>
  )
}

function OpenAIMark({ size }: { size: number }): React.ReactElement {
  // Official OpenAI logomark (simple-icons, normalized 24×24). Neutral ink so it
  // reads on the warm card surface.
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="#1c1a18" aria-hidden>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  )
}

function OpenCodeMark({ size }: { size: number }): React.ReactElement {
  // Official OpenCode logomark (simple-icons, normalized 24×24).
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" />
    </svg>
  )
}

function GeminiMark({ size }: { size: number }): React.ReactElement {
  // Official Google Gemini sparkle mark (simple-icons, normalized 24×24).
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
    </svg>
  )
}

function GlmMark({ size }: { size: number }): React.ReactElement {
  // Z.ai/GLM has no licensable public mark. The earlier abstract geometric shape
  // read as a muddy squiggle at 16px — swapped for a crisp "G" letterform (a
  // rounded square badge, same silhouette language as OpenCode's square above)
  // so it's legible as GLM's initial at a glance, not just "some icon".
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M15.6 9.2A4.4 4.4 0 0 0 12.3 7.8c-2.6 0-4.5 1.9-4.5 4.3s1.9 4.3 4.5 4.3c2 0 3.5-1 4-2.7h-4.2v-1.9h6.4v.4c0 3.6-2.4 6.3-6.2 6.3-3.7 0-6.6-2.8-6.6-6.4S8.6 5.7 12.3 5.7c2.1 0 3.9.9 5.1 2.4z"
        fill="currentColor"
      />
    </svg>
  )
}

function DeepSeekMark({ size }: { size: number }): React.ReactElement {
  // A small whale-fin/wave monogram nodding to DeepSeek's whale mascot, kept
  // abstract (currentColor, no brand color) since there's no license to use theirs.
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M2 15.5c2.4 2 4.8 2 7 .8 1.8 2.3 4.6 3.1 7.4 1.9 2.1-.9 3.6-2.8 3.6-2.8s-2.4.5-3.9-.4c1.8-.6 3-1.9 3.4-3.7-2 .9-3.7.6-4.8-.5 1.1-1 1.5-2.4 1.1-4-1.3 1.5-2.7 1.9-4.1 1.2C10.9 6.4 9 6 9 6s1 1.6.6 3.2C7.9 8.4 6.3 8.7 5 10c1.5.1 2.5.7 2.9 1.8C5.9 11.5 4 12.3 2 15.5Z" />
    </svg>
  )
}

function KimiMark({ size }: { size: number }): React.ReactElement {
  // Moonshot AI / Kimi — a crescent-moon monogram (currentColor), plain geometry
  // rather than a licensed mark.
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M14.5 2a10 10 0 1 0 7.5 16.6A9 9 0 0 1 14.5 2Z" />
    </svg>
  )
}

function QwenMark({ size }: { size: number }): React.ReactElement {
  // Qwen — a faceted diamond monogram (currentColor), abstract by design.
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M12 2 3 12l9 10 9-10-9-10Zm0 3.4 5.8 6.6L12 18.6 6.2 12 12 5.4Z" />
    </svg>
  )
}

function GrokMark({ size }: { size: number }): React.ReactElement {
  // xAI/Grok — a bold "X" monogram (currentColor), the same restrained
  // treatment as the other non-licensed marks above.
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M4 4h4.6l3.4 4.9L15.4 4H20l-5.9 8 6.1 8h-4.6l-3.6-5.2L8.2 20H4l6.1-8.3Z" />
    </svg>
  )
}

function MetaMark({ size }: { size: number }): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="M6.5 7C3.5 7 2 9.7 2 12s1.5 5 4.5 5c2.4 0 4-2.3 5.5-4.8C13.5 14.7 15.1 17 17.5 17c3 0 4.5-2.7 4.5-5s-1.5-5-4.5-5c-2.4 0-4 2.3-5.5 4.8C10.5 9.3 8.9 7 6.5 7Z" />
    </svg>
  )
}

function LetterMark({ size, letter }: { size: number; letter: string }): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <text x="12" y="16.6" textAnchor="middle" fontSize="13" fontWeight="700" fontFamily="system-ui, sans-serif" fill="currentColor">{letter}</text>
    </svg>
  )
}

function OpenRouterMark({ size }: { size: number }): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z" />
    </svg>
  )
}

export function ProviderIcon({
  id,
  size = 22
}: {
  id: ProviderIconId
  size?: number
}): React.ReactElement {
  if (id === 'mightymouse') return <MouseGlyph size={size} />
  if (id === 'claude') return <ClaudeMark size={size} />
  if (id === 'codex') return <OpenAIMark size={size} />
  if (id === 'opencode') return <OpenCodeMark size={size} />
  if (id === 'gemini') return <GeminiMark size={size} />
  if (id === 'glm') return <GlmMark size={size} />
  if (id === 'deepseek') return <DeepSeekMark size={size} />
  if (id === 'kimi') return <KimiMark size={size} />
  if (id === 'qwen') return <QwenMark size={size} />
  if (id === 'grok') return <GrokMark size={size} />
  if (id === 'meta') return <MetaMark size={size} />
  if (id.startsWith('letter:')) return <LetterMark size={size} letter={id.slice(7)} />
  if (id === 'auto') return <Sparkles size={size} strokeWidth={2} aria-hidden />
  if (id === 'mlx') return <Zap size={size} strokeWidth={2} aria-hidden />
  if (id === 'openrouter') return <OpenRouterMark size={size} />
  return <HardDrive size={size} strokeWidth={2} aria-hidden />
}

// Slug prefix → provider icon. Derived from the OpenRouter slug so a new catalog
// row never needs a second hand-maintained map — just needs its prefix listed here
// once. Order matters only for readability; lookup is a `find`, not positional.
const PROVIDER_PREFIXES: ReadonlyArray<{ prefix: string; icon: ProviderIconId }> = [
  { prefix: 'anthropic/', icon: 'claude' },
  { prefix: 'openai/', icon: 'codex' },
  { prefix: 'google/', icon: 'gemini' },
  { prefix: 'z-ai/', icon: 'glm' },
  { prefix: 'deepseek/', icon: 'deepseek' },
  { prefix: 'moonshotai/', icon: 'kimi' },
  { prefix: 'qwen/', icon: 'qwen' },
  { prefix: 'x-ai/', icon: 'grok' },
  { prefix: 'meta/', icon: 'meta' }
]

export function providerIconFor(slug: string): ProviderIconId {
  const bare = slug.replace(/^fal\//, '')
  const known = PROVIDER_PREFIXES.find((p) => bare.startsWith(p.prefix))?.icon
  if (known) return known
  const lab = bare.includes('/') ? bare.split('/')[0].replace(/[^a-z0-9]/gi, '') : ''
  return lab ? `letter:${lab[0].toUpperCase()}` : 'mightymouse'
}
