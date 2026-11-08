import { describe, it, expect } from 'vitest'
import {
  suggestKey,
  suggestPrompt,
  parseSuggestions,
  worthSuggesting,
  suggestContext,
  suggestWireKey,
  cardSuggestKey,
  MAX_SUGGESTIONS,
  MAX_SUGGESTION_CHARS,
  SUGGESTION_TARGET_CHARS
} from '../swipe-suggest'
import type { Suggestion } from '../swipe-suggest'
import { actionsFor, KEEP_GOING_TEXT } from '../swipe-triage'
import type { SwipeCard } from '../swipe-triage'

describe('suggestKey', () => {
  it('changes when the agent restates what it is doing', () => {
    const a = suggestKey({ sessionId: 's1', label: 'x', tldr: 'porting the list' })
    const b = suggestKey({ sessionId: 's1', label: 'x', tldr: 'writing tests' })
    expect(a).not.toBe(b)
  })

  it('falls back to the label when the shim reports no session id', () => {
    expect(suggestKey({ label: 'mm-dev-735', tldr: 'a' })).toBe('mm-dev-735 a')
  })

  it('is stable across skip-cycles of the same card', () => {
    const session = { sessionId: 's1', label: 'x', tldr: 'porting the list' }
    expect(suggestKey(session)).toBe(suggestKey({ ...session }))
  })
})

describe('suggestPrompt', () => {
  it('carries every observed field into the context', () => {
    const prompt = suggestPrompt({
      subject: 'porting the phone list',
      repo: 'ShowAndTell',
      branch: 'dev',
      agent: 'claude',
      model: 'opus',
      age: '4m',
      recent: ['tests are green'],
      paneTail: 'Which db?'
    })
    for (const value of [
      'porting the phone list',
      'ShowAndTell',
      'dev',
      'claude',
      'opus',
      '4m',
      'tests are green',
      'Which db?'
    ]) {
      expect(prompt).toContain(value)
    }
  })

  // A shim too old to send facts, a pane not under tmux and a session that only
  // ever notified each drop a different field, so absence is the normal case.
  it('drops fields it does not have rather than wording them', () => {
    const prompt = suggestPrompt({ subject: 'porting the phone list' })
    expect(prompt).toContain('porting the phone list')
    expect(prompt).not.toContain('branch')
    expect(prompt).not.toContain('last_on_screen')
  })

  it('states the limits it will be parsed against', () => {
    const prompt = suggestPrompt({ subject: 'porting the phone list' })
    expect(prompt).toContain(String(MAX_SUGGESTIONS))
    expect(prompt).toContain(String(SUGGESTION_TARGET_CHARS))
    expect(SUGGESTION_TARGET_CHARS).toBeLessThanOrEqual(MAX_SUGGESTION_CHARS)
  })
})

describe('parseSuggestions', () => {
  const texts = (raw: string): string[] => parseSuggestions(raw).map((s) => s.text)

  describe('the JSON shape the prompt asks for', () => {
    it('keeps the emoji alongside the text, never inside it', () => {
      expect(
        parseSuggestions('[{"emoji":"🧪","text":"Run the tests"},{"emoji":"🚀","text":"Ship it"}]')
      ).toEqual([
        { emoji: '🧪', text: 'Run the tests' },
        { emoji: '🚀', text: 'Ship it' }
      ])
    })

    it('reads the array out of a reasoning preamble and a code fence', () => {
      const raw = 'Looking at [ask] history, here you go:\n```json\n[{"emoji":"🐛","text":"Fix the bug"}]\n```'
      expect(parseSuggestions(raw)).toEqual([{ emoji: '🐛', text: 'Fix the bug' }])
    })

    it('keeps a suggestion whose emoji is missing or junk, minus the glyph', () => {
      expect(
        parseSuggestions(
          '[{"text":"Run the tests"},{"emoji":"xx","text":"Ship it"},{"emoji":"🚀🚀","text":"Undo"}]'
        )
      ).toEqual([{ text: 'Run the tests' }, { text: 'Ship it' }, { text: 'Undo' }])
    })

    it('accepts a multi-codepoint emoji as the one glyph it renders as', () => {
      expect(parseSuggestions('[{"emoji":"👍🏽","text":"Approve it"}]')).toEqual([
        { emoji: '👍🏽', text: 'Approve it' }
      ])
    })

    it('applies the same text bar as the line parser', () => {
      const long = 'x'.repeat(MAX_SUGGESTION_CHARS + 1)
      const raw = `[{"emoji":"🧪","text":"Run the tests"},{"emoji":"📝","text":"${long}"},{"emoji":"📖","text":"Ideas:"}]`
      expect(parseSuggestions(raw)).toEqual([{ emoji: '🧪', text: 'Run the tests' }])
    })

    it('caps at three and de-duplicates on text', () => {
      const raw =
        '[{"text":"a"},{"text":"a"},{"text":"b"},{"text":"c"},{"text":"d"}]'
      expect(texts(raw)).toEqual(['a', 'b', 'c'])
    })

    it('takes an explicit empty array as "nothing to suggest"', () => {
      expect(parseSuggestions('[]')).toEqual([])
    })

    it('drops an item that is not an object', () => {
      expect(texts('["Run the tests",{"text":"Ship it"}]')).toEqual(['Ship it'])
    })
  })

  describe('the bare-line fallback, for a model that ignored the format', () => {
    it('takes bare lines as chips', () => {
      expect(texts('Run the tests\nShow me the diff')).toEqual(['Run the tests', 'Show me the diff'])
    })

    it('carries no emoji, rather than inventing one', () => {
      expect(parseSuggestions('Run the tests')).toEqual([{ text: 'Run the tests' }])
    })

    it('strips numbering and bullets the model added anyway', () => {
      expect(texts('1. Run the tests\n- Show me the diff\n• Ship it')).toEqual([
        'Run the tests',
        'Show me the diff',
        'Ship it'
      ])
    })

    it('drops a line too long to be an instruction', () => {
      const long = 'x'.repeat(MAX_SUGGESTION_CHARS + 1)
      expect(texts(`Run the tests\n${long}`)).toEqual(['Run the tests'])
    })

    it('drops a heading rather than offering it as an action', () => {
      expect(texts('Here are some ideas:\nRun the tests')).toEqual(['Run the tests'])
    })

    it('caps at three even when the model ignores the limit', () => {
      expect(texts('a\nb\nc\nd\ne')).toEqual(['a', 'b', 'c'])
    })

    it('de-duplicates repeated lines', () => {
      expect(texts('Run the tests\nRun the tests\nShip it')).toEqual(['Run the tests', 'Ship it'])
    })

    it('returns nothing for prose, rather than a chip of prose', () => {
      const prose = 'I am not sure what this agent is doing, so I cannot suggest anything useful.'
      expect(parseSuggestions(prose)).toEqual([])
    })

    it('returns nothing for an empty reply', () => {
      expect(parseSuggestions('')).toEqual([])
      expect(parseSuggestions('   \n\n  ')).toEqual([])
    })
  })
})

describe('worthSuggesting', () => {
  it('spends a model call only on a session that declared a subject', () => {
    expect(worthSuggesting({ tldr: 'porting the list' }, false)).toBe(true)
    expect(worthSuggesting({}, false)).toBe(false)
    expect(worthSuggesting({ tldr: '   ' }, false)).toBe(false)
  })

  it('never suggests over a pending ask -- the ask has its own options', () => {
    expect(worthSuggesting({ tldr: 'porting the list' }, true)).toBe(false)
  })

  it('never suggests for an ended session', () => {
    expect(worthSuggesting({ tldr: 'porting the list', stale: true }, false)).toBe(false)
  })

  // 4 sessions in 1264 ever declare a TLDR, so the derived subject is what
  // almost every real card actually has.
  it('accepts a derived subject when the agent never declared one', () => {
    expect(worthSuggesting({}, false, 'fixing the login redirect')).toBe(true)
    expect(worthSuggesting({}, false, '   ')).toBe(false)
    expect(worthSuggesting({}, true, 'fixing the login redirect')).toBe(false)
    expect(worthSuggesting({ stale: true }, false, 'fixing the login redirect')).toBe(false)
  })
})

describe('suggestContext', () => {
  it('prefers the declared TLDR and falls back to the derived subject', () => {
    expect(suggestContext({ tldr: 'declared' }, 'derived')).toBe('declared')
    expect(suggestContext({}, 'derived')).toBe('derived')
    expect(suggestContext({ tldr: '  ' }, 'derived')).toBe('derived')
    expect(suggestContext({}, undefined)).toBe('')
  })
})

// The regression: the deck read its key off the raw TLDR while the requester
// used `suggestContext`. ~4 sessions in 1264 declare a TLDR, so the two keys
// disagreed on nearly every card and the answer landed where nobody looked.
describe('cardSuggestKey', () => {
  const card = (extra: Partial<SwipeCard> = {}): SwipeCard =>
    ({
      label: 'mm-dev-735',
      session: { label: 'mm-dev-735', pid: 4242 },
      subject: 'porting the list',
      pending: undefined,
      ...extra
    }) as SwipeCard

  it('keys a card with no declared TLDR off its derived subject', () => {
    expect(cardSuggestKey(card())).toBe(suggestWireKey('mm-dev-735', 'porting the list'))
  })

  it('matches the key the requester asks under, TLDR or not', () => {
    for (const c of [card(), card({ session: { label: 'mm-dev-735', pid: 4242, tldr: 'declared' } })]) {
      const asked = suggestWireKey(c.label, suggestContext(c.session, c.subject))
      expect(cardSuggestKey(c)).toBe(asked)
    }
  })

  it('is undefined when there is no context to suggest against', () => {
    expect(cardSuggestKey(card({ subject: undefined }))).toBeUndefined()
  })

  it('delivers chips to a card whose session never called recap', () => {
    const c = card()
    const map: Record<string, Suggestion[]> = {
      [suggestWireKey(c.label, suggestContext(c.session, c.subject))]: [
        { emoji: '🧪', text: 'Run the tests' }
      ]
    }
    const actions = actionsFor(c, map[cardSuggestKey(c) ?? ''] ?? [])
    expect(actions.map((a) => a.label)).toContain('Run the tests')
    expect(actions.map((a) => a.label)).not.toContain(KEEP_GOING_TEXT)
  })

  it('carries the emoji to the chip without putting it in what gets sent', () => {
    const [chip] = actionsFor(card(), [{ emoji: '🧪', text: 'Run the tests' }])
    expect(chip).toMatchObject({ emoji: '🧪', label: 'Run the tests' })
  })

  it('leaves a glyph-less suggestion with no emoji, rather than a placeholder', () => {
    const [chip] = actionsFor(card(), [{ text: 'Run the tests' }])
    expect(chip.emoji).toBeUndefined()
  })

  it('still accepts plain strings, for callers with no model output', () => {
    const [chip] = actionsFor(card(), ['Run the tests'])
    expect(chip).toMatchObject({ label: 'Run the tests' })
    expect(chip.emoji).toBeUndefined()
  })
})
