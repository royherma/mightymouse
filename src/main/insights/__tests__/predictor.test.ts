import { describe, expect, it } from 'vitest'
import { parseSuggestionJson, parseSuggestionResult } from '../suggestion-json'

describe('parseSuggestionJson', () => {
  it('extracts valid suggestions from a JSON array response', () => {
    expect(
      parseSuggestionJson(`Here you go:
[
  {"label":"Reply yes","instruction":"Reply yes and confirm the time","mode":"rewrite"},
  {"label":"Explain","instruction":"Explain the current thread","mode":"ask"}
]`)
    ).toEqual([
      {
        label: 'Reply yes',
        instruction: 'Reply yes and confirm the time',
        mode: 'rewrite'
      },
      {
        label: 'Explain',
        instruction: 'Explain the current thread',
        mode: 'ask'
      }
    ])
  })

  it('drops malformed suggestions', () => {
    expect(
      parseSuggestionJson(
        `[{"label":"x","instruction":"too short","mode":"ask"},{"label":"Run","instruction":"Run the next step","mode":"bad"}]`
      )
    ).toEqual([])
  })
})

describe('parseSuggestionResult diagnostics', () => {
  it('reports no-array when the output has no JSON array', () => {
    const { suggestions, failure } = parseSuggestionResult('I cannot help with that.')
    expect(suggestions).toEqual([])
    expect(failure).toEqual({ kind: 'no-array' })
  })

  it('reports an empty array', () => {
    const { failure } = parseSuggestionResult('[]')
    expect(failure).toEqual({ kind: 'empty-array' })
  })

  it('reports parse-error on broken JSON inside the brackets', () => {
    const { failure } = parseSuggestionResult('[{"label": broken]')
    expect(failure?.kind).toBe('parse-error')
  })

  it('reports all-dropped with per-item reasons when every item is filtered', () => {
    const { failure } = parseSuggestionResult(
      `[{"label":"x","instruction":"too short","mode":"ask"},{"label":"Run it","instruction":"Run the next step","mode":"bad"}]`
    )
    expect(failure).toEqual({
      kind: 'all-dropped',
      total: 2,
      reasons: ['label-too-short', 'bad-mode']
    })
  })

  it('surfaces the model decline reason', () => {
    const { suggestions, failure } = parseSuggestionResult(
      `{"decline":"blank document with no content to work on"}`
    )
    expect(suggestions).toEqual([])
    expect(failure).toEqual({ kind: 'declined', reason: 'blank document with no content to work on' })
  })

  it('reads a decline wrapped as the sole array item (the prompt nudges this form)', () => {
    // Prod bug: the prompt says "return ONLY an array", so the model emitted
    // [{"decline":...}] inside ```json fences. The old check skipped the decline
    // branch whenever an array was present, so it fell through and the decline
    // object was dropped as "label-too-short". Both wrapped + fenced must read as declined.
    const { suggestions, failure } = parseSuggestionResult(
      '```json\n[\n  {\n    "decline": "LinkedIn feed is blank (about:blank); no compose box."\n  }\n]\n```'
    )
    expect(suggestions).toEqual([])
    expect(failure).toEqual({
      kind: 'declined',
      reason: 'LinkedIn feed is blank (about:blank); no compose box.'
    })
  })

  it('extracts the real array past a reasoning preamble that quotes [ask] history', () => {
    // Prod crash: the claude CLI (now reading the screenshot) reasoned out loud and
    // quoted history like "[ask] write a tweet" BEFORE the JSON. The old greedy regex
    // matched from that first '[' to the last ']' → garbage that failed JSON.parse.
    const raw =
      'Clear: LinkedIn compose modal is open. History shows [ask] write a punchy tweet.\n' +
      'The advice: draft + post what shipped today.\n\n' +
      '```json\n[\n  {"label":"Draft LinkedIn post","instruction":"write it","mode":"rewrite","kind":"write","text":"Shipped motion polish today."}\n]\n```'
    const { suggestions, failure } = parseSuggestionResult(raw)
    expect(failure).toBeUndefined()
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].label).toBe('Draft LinkedIn post')
  })

  it('returns no failure when suggestions parse cleanly', () => {
    const { suggestions, failure } = parseSuggestionResult(
      `[{"label":"Reply yes","instruction":"Reply yes and confirm","mode":"rewrite"}]`
    )
    expect(suggestions).toHaveLength(1)
    expect(failure).toBeUndefined()
  })
})
