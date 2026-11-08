import { describe, it, expect } from 'vitest'
import {
  searchLanguages,
  groupedLanguages,
  needsMultilingualModel,
  AUTO_LANGUAGE,
  WHISPER_LANGUAGES
} from '../whisper-languages'

describe('searchLanguages', () => {
  it('finds a language by its English name', () => {
    expect(searchLanguages('spanish')[0].code).toBe('es')
  })

  it('finds a language by its native name', () => {
    expect(searchLanguages('español')[0].code).toBe('es')
  })

  // The reason fold() exists: a US keyboard cannot type ê or ã, so a query
  // without diacritics must still match the accented native name.
  it('matches a native name typed without its diacritics', () => {
    expect(searchLanguages('portugues')[0].code).toBe('pt')
    expect(searchLanguages('francais')[0].code).toBe('fr')
  })

  it('finds a language typed in its own script', () => {
    expect(searchLanguages('עברית')[0].code).toBe('he')
    expect(searchLanguages('日本語')[0].code).toBe('ja')
  })

  // Substring hits would otherwise bury the obvious answer: 'en' appears inside
  // Slovenian and Français, but English is what the user meant.
  it('ranks prefix matches above substring matches', () => {
    expect(searchLanguages('en')[0].code).toBe('en')
  })

  it('matches an exact language code', () => {
    expect(searchLanguages('he')[0].code).toBe('he')
  })

  it('returns nothing for a blank query', () => {
    expect(searchLanguages('   ')).toEqual([])
  })

  it('returns nothing rather than throwing on no match', () => {
    expect(searchLanguages('klingon')).toEqual([])
  })
})

describe('the language list', () => {
  it('covers every language whisper decodes', () => {
    expect(WHISPER_LANGUAGES).toHaveLength(100)
  })

  it('has no duplicate codes', () => {
    const codes = WHISPER_LANGUAGES.map((l) => l.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('splits into common + rest with nothing lost or repeated', () => {
    const { common, rest } = groupedLanguages()
    expect(common[0].code).toBe('en')
    expect(common.length + rest.length).toBe(WHISPER_LANGUAGES.length)
    expect(new Set([...common, ...rest].map((l) => l.code)).size).toBe(
      WHISPER_LANGUAGES.length
    )
  })

  // Flags map to countries, not languages. Picking one for Spanish or Arabic
  // reads as careless to exactly the users this feature exists for.
  it('gives no flag to languages spoken across many countries', () => {
    for (const code of ['en', 'es', 'pt', 'ar', 'zh']) {
      expect(WHISPER_LANGUAGES.find((l) => l.code === code)?.flag).toBeUndefined()
    }
  })
})

describe('auto-detect', () => {
  // Detection is itself a multilingual capability — base.en cannot do it, so
  // routing auto to base.en would silently produce the exact garbled output
  // this whole feature exists to prevent.
  it('needs the multilingual model', () => {
    expect(needsMultilingualModel(AUTO_LANGUAGE)).toBe(true)
  })

  it('is not one of the 100 languages', () => {
    expect(WHISPER_LANGUAGES.some((l) => l.code === AUTO_LANGUAGE)).toBe(false)
  })

  // Auto is reached by the Automatic/Specific toggle, never by the list — so it
  // must not leak into search results and push a real language down.
  it('is not reachable through the language search', () => {
    expect(searchLanguages('auto')).toEqual([])
  })
})
