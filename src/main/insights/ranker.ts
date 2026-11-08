import { CONFIG } from '../../shared/config'
import type { Suggestion } from '../../shared/types'
import { OutcomeStore, StemRate } from './outcome-store'
import type { InsightBucket } from './signal-collector'

const STEM_WORD_RE = /[a-z0-9]+/g
const JOINER = ' '

export function instructionStem(instruction: string): string {
  const words = instruction
    .toLowerCase()
    .match(STEM_WORD_RE)
    ?.slice(0, CONFIG.SUGGESTIONS.INSTRUCTION_STEM_WORDS)
  return words && words.length > 0 ? words.join(JOINER) : ''
}

function recencyWeight(lastTs: number, now: number): number {
  if (lastTs <= 0) return 0
  const age = Math.max(0, now - lastTs)
  return Math.pow(0.5, age / CONFIG.SUGGESTIONS.RECENCY_HALF_LIFE_MS)
}

function scoreSuggestion(rate: StemRate | undefined, originalIndex: number): number {
  const base = CONFIG.SUGGESTIONS.MAX - originalIndex
  if (!rate) return base
  const acceptedBoost = rate.accepted * rate.rate * CONFIG.SUGGESTIONS.ACCEPT_BOOST
  const dismissPenalty = rate.dismissed * (1 - rate.rate) * CONFIG.SUGGESTIONS.DISMISS_PENALTY
  const recent = recencyWeight(rate.lastTs, Date.now())
  return base + acceptedBoost + recent - dismissPenalty
}

export const Ranker = {
  rerank(suggestions: Suggestion[], bucket: InsightBucket): Suggestion[] {
    const rates = OutcomeStore.acceptRateByContext(bucket)
    return suggestions
      .map((suggestion, index) => ({
        suggestion,
        index,
        score: scoreSuggestion(rates.get(instructionStem(suggestion.instruction)), index)
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((item) => item.suggestion)
      .slice(0, CONFIG.SUGGESTIONS.MAX)
  },

  topAcceptedStems(bucket: InsightBucket, k = CONFIG.SUGGESTIONS.TOP_ACCEPTED_STEMS): string[] {
    return Array.from(OutcomeStore.acceptRateByContext(bucket).values())
      .filter((rate) => rate.accepted > 0)
      .sort((a, b) => b.rate - a.rate || b.accepted - a.accepted || b.lastTs - a.lastTs)
      .slice(0, k)
      .map((rate) => rate.stem)
  }
}

export function rerankWithRates(
  suggestions: Suggestion[],
  rates: Map<string, StemRate>
): Suggestion[] {
  return suggestions
    .map((suggestion, index) => ({
      suggestion,
      index,
      score: scoreSuggestion(rates.get(instructionStem(suggestion.instruction)), index)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.suggestion)
}
