import { describe, expect, it } from 'vitest'
import { firstSentence, ideaArea } from '../factory'

describe('firstSentence', () => {
  it('skips node warnings and keeps the first real sentence', () => {
    const raw = [
      '(node:4242) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type not specified',
      'Reparsing as ES module because module syntax was detected.',
      '(Use `node --trace-warnings ...` to show where the warning was created)',
      'Tests failed: 3 of 12. Run npm test to see them.'
    ].join('\n')
    expect(firstSentence(raw)).toBe('Tests failed: 3 of 12.')
  })

  it('drops terminal symbols and rules so the reason reads as words', () => {
    expect(firstSentence('──────\n✖ build broke -- missing export! More text')).toBe('build broke missing export!')
  })

  it('stops at the end of the first line when there is no full stop', () => {
    expect(firstSentence('Exit code 1\nsecond line')).toBe('Exit code 1')
    expect(firstSentence('Échec du test, réessayez')).toBe('Échec du test, réessayez')
  })

  it('returns nothing for output that is only noise', () => {
    expect(firstSentence('')).toBe('')
    expect(firstSentence('(node:1) Warning: x\n✔ ✔ ✔')).toBe('')
  })

  it('keeps a file name or decimal whole instead of cutting at its dot', () => {
    expect(firstSentence('FAIL src/auth.test.ts > login rejects bad password')).toBe('FAIL src/auth.test.ts login rejects bad password')
  })
})

describe('ideaArea', () => {
  const task = (over: Partial<Parameters<typeof ideaArea>[0]>): Parameters<typeof ideaArea>[0] => ({
    area: '',
    source: 'audit',
    sourceDetail: '',
    scope: [],
    ...over
  })

  it('keeps an area the task already has', () => {
    expect(ideaArea(task({ area: 'marketing', source: 'audit', scope: ['src/a.ts'] }))).toBe('marketing')
  })

  it('files a code-scan idea that names code as engineering', () => {
    expect(ideaArea(task({ source: 'audit', scope: ['src/a.ts'] }))).toBe('engineering')
    expect(ideaArea(task({ source: 'followup', sourceDetail: 'review said the retry loop never stops' }))).toBe('engineering')
  })

  it('leaves the area open when nothing ties the idea to code', () => {
    expect(ideaArea(task({ source: 'audit' }))).toBe('')
    expect(ideaArea(task({ source: 'brief', scope: ['src/a.ts'], sourceDetail: 'from the spec' }))).toBe('')
  })
})
