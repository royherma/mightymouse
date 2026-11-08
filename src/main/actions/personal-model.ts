import type { ActionHabit, ActionSlotValues } from '../../shared/action-engine'
import { CONFIG } from '../../shared/config'
import { readRecentActionRows } from './action-log'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const TOP_HABITS = 8
const MIN_WEIGHTED_SHOWS_FOR_BOOST = 3
const BOOST_MIN = 0.5
const BOOST_MAX = 1.5
const IGNORED_WEIGHT = 0.5

interface PairStats {
  frontApp: string
  actionId: string
  weightedShown: number
  weightedAccepted: number
}

interface HitEvent {
  ts: number
  hit: boolean
}

interface SlotStats {
  weightedChosen: number
  weightedRejected: number
}

let cache: Map<string, PairStats> | null = null
let muteStreaks: Map<string, HitEvent[]> | null = null
let slotCache: Map<string, SlotStats> | null = null

function keyOf(frontApp: string, actionId: string): string {
  return `${frontApp}\u0000${actionId}`
}

function slotKeyOf(frontApp: string, actionId: string, slotKey: string, value: string): string {
  return `${frontApp}\u0000${actionId}\u0000${slotKey}\u0000${value}`
}

function addSlotHit(
  map: Map<string, SlotStats>,
  key: string,
  weight: number,
  chosen: boolean
): void {
  const prev = map.get(key) ?? { weightedChosen: 0, weightedRejected: 0 }
  if (chosen) prev.weightedChosen += weight
  else prev.weightedRejected += weight
  map.set(key, prev)
}

function learnSlots(
  map: Map<string, SlotStats>,
  frontApp: string,
  actionId: string,
  suggested: ActionSlotValues,
  ran: ActionSlotValues,
  weight: number
): void {
  for (const [slotKey, ranValue] of Object.entries(ran)) {
    if (typeof ranValue !== 'string') continue
    const suggestedValue = suggested[slotKey]
    addSlotHit(map, slotKeyOf(frontApp, actionId, slotKey, ranValue), weight, true)
    if (typeof suggestedValue === 'string' && suggestedValue !== ranValue) {
      addSlotHit(map, slotKeyOf(frontApp, actionId, slotKey, suggestedValue), weight, false)
    }
  }
}

function decayWeight(ts: number, now: number): number {
  const ageDays = Math.max(0, (now - ts) / MS_PER_DAY)
  return Math.pow(0.5, ageDays / CONFIG.ACTIONS.HABIT_HALF_LIFE_DAYS)
}

function addHit(
  map: Map<string, PairStats>,
  frontApp: string,
  actionId: string,
  weight: number,
  accepted: boolean
): void {
  const key = keyOf(frontApp, actionId)
  const prev = map.get(key) ?? { frontApp, actionId, weightedShown: 0, weightedAccepted: 0 }
  prev.weightedShown += weight
  if (accepted) prev.weightedAccepted += weight
  map.set(key, prev)
}

function build(): void {
  const now = Date.now()
  const stats = new Map<string, PairStats>()
  const streaks = new Map<string, HitEvent[]>()
  const slots = new Map<string, SlotStats>()

  for (const row of readRecentActionRows(CONFIG.ACTIONS.HABIT_RECENT_ROWS)) {
    if (row.event !== 'outcome') continue
    const ts = Date.parse(row.ts) || now
    const w = decayWeight(ts, now)

    if (row.outcome === 'accepted' || row.outcome === 'overrode') {
      learnSlots(slots, row.frontApp, row.chosenActionId, row.suggestedSlots, row.slots, w)
    }

    if (row.outcome === 'accepted') {
      addHit(stats, row.frontApp, row.topActionId, w, true)
      pushStreak(streaks, row.frontApp, row.topActionId, ts, true)
    } else if (row.outcome === 'overrode') {
      addHit(stats, row.frontApp, row.chosenActionId, w, true)
      addHit(stats, row.frontApp, row.topActionId, w, false)
      pushStreak(streaks, row.frontApp, row.chosenActionId, ts, true)
      pushStreak(streaks, row.frontApp, row.topActionId, ts, false)
    } else if (row.outcome === 'dismissed') {
      addHit(stats, row.frontApp, row.topActionId, w, false)
      pushStreak(streaks, row.frontApp, row.topActionId, ts, false)
    } else if (row.outcome === 'ignored') {
      addHit(stats, row.frontApp, row.topActionId, w * IGNORED_WEIGHT, false)
    }
  }

  cache = stats
  muteStreaks = streaks
  slotCache = slots
}

function pushStreak(
  streaks: Map<string, HitEvent[]>,
  frontApp: string,
  actionId: string,
  ts: number,
  hit: boolean
): void {
  const key = keyOf(frontApp, actionId)
  const list = streaks.get(key) ?? []
  list.push({ ts, hit })
  streaks.set(key, list)
}

function ensureBuilt(): void {
  if (cache === null || muteStreaks === null || slotCache === null) build()
}

export function getHabits(frontApp: string): ActionHabit[] {
  ensureBuilt()
  const rows: ActionHabit[] = []
  for (const stats of cache!.values()) {
    if (stats.frontApp !== frontApp) continue
    rows.push({
      actionId: stats.actionId,
      frontApp: stats.frontApp,
      acceptRate: stats.weightedShown > 0 ? stats.weightedAccepted / stats.weightedShown : 0,
      shown: stats.weightedShown
    })
  }
  rows.sort((a, b) => b.acceptRate * b.shown - a.acceptRate * a.shown)
  return rows.slice(0, TOP_HABITS)
}

export function habitBoost(actionId: string, frontApp: string): number {
  ensureBuilt()
  const stats = cache!.get(keyOf(frontApp, actionId))
  if (!stats || stats.weightedShown < MIN_WEIGHTED_SHOWS_FOR_BOOST) return 1
  const rate = stats.weightedAccepted / stats.weightedShown
  return BOOST_MIN + rate * (BOOST_MAX - BOOST_MIN)
}

export function isMuted(actionId: string, frontApp: string): boolean {
  ensureBuilt()
  const events = muteStreaks!.get(keyOf(frontApp, actionId))
  if (!events) return false
  const sorted = [...events].sort((a, b) => a.ts - b.ts)
  let streak = 0
  for (const event of sorted) {
    if (event.hit) streak = 0
    else streak += 1
  }
  return streak >= CONFIG.ACTIONS.MUTE_AFTER_DISMISSALS
}

// Ranks a slot value the user has repeatedly corrected TO above the one the model
// keeps guessing, for this front app and action only.
export function slotValueBoost(
  frontApp: string,
  actionId: string,
  slotKey: string,
  value: string
): number {
  ensureBuilt()
  const stats = slotCache!.get(slotKeyOf(frontApp, actionId, slotKey, value))
  if (!stats) return 1
  const total = stats.weightedChosen + stats.weightedRejected
  if (total < MIN_WEIGHTED_SHOWS_FOR_BOOST) return 1
  return BOOST_MIN + (stats.weightedChosen / total) * (BOOST_MAX - BOOST_MIN)
}

export function invalidatePersonalModel(): void {
  cache = null
  muteStreaks = null
  slotCache = null
}
