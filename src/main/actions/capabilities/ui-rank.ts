import type { ActionSlotOption } from '../../../shared/action-engine'
import { normalizeLabel, overlapScore, words } from '../../../shared/rank-options'

export interface AxFrame {
  x: number
  y: number
  w: number
  h: number
}

export interface AxElement {
  role: string
  label: string
  actions: string[]
  offscreen?: boolean
  frame?: AxFrame
}

const ROLE_RANK: Record<string, number> = {
  AXButton: 0,
  AXPopUpButton: 1,
  AXMenuItem: 1,
  AXTextField: 2,
  AXCheckBox: 3,
  AXRadioButton: 3,
  AXLink: 4
}

const ROLE_RANK_DEFAULT = 5

// 40 — the breadth-first walk emits window chrome before page content
const CHROME_PREFIX_ELEMENTS = 40

export function isPressable(el: AxElement): boolean {
  return el.actions.includes('AXPress') && normalizeLabel(el.label) !== ''
}

// A text field carries no AXPress, so isPressable drops it -- which is why
// nothing could ever be offered as a place to type.
const TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox'])

export function isTextTarget(el: AxElement): boolean {
  return TEXT_ROLES.has(el.role) && normalizeLabel(el.label) !== ''
}

const ROLE_WEIGHT = 2
const CHROME_BONUS = 3
const HABIT_BONUS = 1

interface Scored {
  label: string
  score: number
  index: number
}

export interface RankOptions {
  transcript: string
  limit: number
  recentLabels?: readonly string[]
  /** Text fields carry no AXPress, so the caller picks which gate applies. */
  keep?: (el: AxElement) => boolean
}

// Dropping duplicate labels is correctness: axPress presses the FIRST tree match,
// so offering a label 40 elements share presses an arbitrary one and reports success.
export function rankElements(
  elements: readonly AxElement[],
  { transcript, limit, recentLabels = [], keep = isPressable }: RankOptions
): ActionSlotOption[] {
  const said = words(transcript)
  const recent = new Set(recentLabels.map(normalizeLabel))

  const counts = new Map<string, number>()
  for (const el of elements) {
    if (!keep(el)) continue
    const label = normalizeLabel(el.label)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  const best = new Map<string, Scored>()

  elements.forEach((el, index) => {
    if (!keep(el)) return
    const label = normalizeLabel(el.label)
    const labelWords = words(label)
    if (labelWords.length === 0) return

    const overlap = overlapScore(said, label)
    const duplicated = (counts.get(label) ?? 0) > 1
    if (duplicated && overlap === 0) return

    const roleRank = ROLE_RANK[el.role] ?? ROLE_RANK_DEFAULT
    const score =
      overlap +
      (ROLE_RANK_DEFAULT - roleRank) * ROLE_WEIGHT +
      (index < CHROME_PREFIX_ELEMENTS ? CHROME_BONUS : 0) +
      (recent.has(label) ? HABIT_BONUS : 0)

    const prior = best.get(label)
    if (prior === undefined || score > prior.score) {
      best.set(label, { label, score, index })
    }
  })

  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ label }) => ({ value: label, label }))
}
