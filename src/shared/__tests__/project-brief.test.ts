import { describe, expect, it } from 'vitest'
import {
  GOAL_LIVE,
  INFRA_KINDS,
  briefSentence,
  cleanBrief,
  cleanTags,
  infraNeeds,
  kindWanted,
  type InfraKind,
  type InfraRecord
} from '../infra'
import { defaultGoalDay, goalChoices, goalFrom, parseBriefDraft, type GoalChoice } from '../brief'
import { goalDay, goalText, metricById, typicalFor } from '../playbooks'

const BUYERS = 'store.visitors-who-buy'
const ORDER_VALUE = 'store.average-order-value'

describe('cleanBrief', () => {
  it('collapses whitespace and caps each line at 80 characters', () => {
    const brief = cleanBrief({ what: '  Online \n pet\tstore  ', audience: 'x'.repeat(200) })
    expect(brief).toEqual({ what: 'Online pet store', audience: 'x'.repeat(80) })
  })

  it('drops anything that is not text, and returns nothing when nothing is left', () => {
    expect(cleanBrief({ what: 42, audience: ['a'], niche: '   ' })).toBeUndefined()
    for (const junk of [null, undefined, 'a brief', 7]) expect(cleanBrief(junk)).toBeUndefined()
  })

  it('keeps a goal on its own, with only a real number and a real day', () => {
    expect(cleanBrief({ goal: { metric: BUYERS, target: 3.5, by: '2026-12-31' } })).toEqual({
      goal: { metric: BUYERS, target: 3.5, by: '2026-12-31' }
    })
    for (const target of ['3.5', NaN, Infinity, null]) {
      expect(cleanBrief({ goal: { metric: BUYERS, target, by: 'next quarter' } })).toEqual({
        goal: { metric: BUYERS }
      })
    }
  })

  it('throws away a goal whose metric is not a plain id', () => {
    for (const metric of ['Store.Buyers', '../../etc', 'a b', '', 9, 'x'.repeat(61)]) {
      expect(cleanBrief({ what: 'Shop', goal: { metric } }), String(metric)).toEqual({ what: 'Shop' })
    }
  })
})

describe('cleanTags', () => {
  it('keeps only known ids, once each, in the catalog order', () => {
    expect(cleanTags('business', ['saas', 'nonsense', 'store', 'saas', 7])).toEqual(['store', 'saas'])
    expect(cleanTags('appKinds', ['worker', 'web', 'store'])).toEqual(['web', 'worker'])
  })

  it('treats anything but a list as no tags', () => {
    for (const junk of [null, 'store', { 0: 'store' }]) expect(cleanTags('business', junk)).toEqual([])
  })
})

describe('briefSentence', () => {
  it('builds one sentence from whichever halves exist', () => {
    expect(briefSentence({ what: 'Online pet store', audience: 'dog owners' })).toBe(
      'Online pet store, for dog owners.'
    )
    expect(briefSentence({ what: 'Online pet store' })).toBe('Online pet store.')
    expect(briefSentence({ audience: 'dog owners' })).toBe('It is for dog owners.')
    expect(briefSentence({ niche: 'Pet supplies' })).toBe('')
    expect(briefSentence(undefined)).toBe('')
  })
})

describe('parseBriefDraft', () => {
  it('pulls the JSON out of a chatty or fenced model reply', () => {
    const reply =
      'Sure, here you go:\n```json\n{"what": "Online pet store", "audience": "Dog owners", "niche": "Pet supplies"}\n```\nHope that helps.'
    expect(parseBriefDraft(reply)).toEqual({
      what: 'Online pet store',
      audience: 'Dog owners',
      niche: 'Pet supplies'
    })
  })

  it('never lets the model set a goal', () => {
    const reply = '{"what": "Shop", "goal": {"metric": "store.visitors-who-buy", "target": 99}}'
    expect(parseBriefDraft(reply)).toEqual({ what: 'Shop' })
  })

  it('returns null for a reply with no JSON, broken JSON, or nothing filled in', () => {
    expect(parseBriefDraft('I could not tell what this project is.')).toBeNull()
    expect(parseBriefDraft('{"what": "Shop", ')).toBeNull()
    expect(parseBriefDraft('{"what": "", "audience": "", "niche": ""}')).toBeNull()
  })
})

describe('goalFrom', () => {
  const choice: GoalChoice = { id: BUYERS, label: 'Visitors who buy', hint: '' }

  it('turns a typed target and day into a goal', () => {
    expect(goalFrom(choice, '3.5', '2026-12-31')).toEqual({ metric: BUYERS, target: 3.5, by: '2026-12-31' })
  })

  it('an empty or unreadable target is no target, not zero', () => {
    for (const typed of ['', '   ', 'lots', '3,5']) {
      expect(goalFrom(choice, typed, '2026-12-31'), JSON.stringify(typed)).toEqual({
        metric: BUYERS,
        by: '2026-12-31'
      })
    }
  })

  it('drops a day that is not YYYY-MM-DD', () => {
    expect(goalFrom(choice, '3', '31/12/2026')).toEqual({ metric: BUYERS, target: 3 })
  })

  it('get-it-live carries no number and no day', () => {
    expect(goalFrom({ id: GOAL_LIVE, label: '', hint: '' }, '5', '2026-12-31')).toEqual({ metric: GOAL_LIVE })
  })
})

describe('defaultGoalDay', () => {
  it('is the last day of the current quarter', () => {
    expect(defaultGoalDay(new Date('2026-10-02T03:00:00Z'))).toBe('2026-12-31')
    expect(defaultGoalDay(new Date('2026-02-10T12:00:00Z'))).toBe('2026-03-31')
    expect(defaultGoalDay(new Date('2026-04-01T00:00:00Z'))).toBe('2026-06-30')
    expect(defaultGoalDay(new Date('2026-12-31T23:59:00Z'))).toBe('2026-12-31')
  })
})

describe('typicalFor', () => {
  const buyers = metricById(BUYERS)!
  const general = buyers.benchmarks!.find((b) => !b.niche)!
  const pets = buyers.benchmarks!.find((b) => b.niche === 'Pet supplies')!

  it('matches the niche whatever its case or padding', () => {
    expect(typicalFor(buyers, '  pet SUPPLIES ')).toBe(pets)
  })

  it('falls back to the all-stores number for an unknown or missing niche', () => {
    expect(typicalFor(buyers, 'Submarines')).toBe(general)
    expect(typicalFor(buyers)).toBe(general)
  })

  it('has no number at all when the metric only has per-niche numbers and the niche is unknown', () => {
    expect(typicalFor(metricById(ORDER_VALUE)!, 'Submarines')).toBeUndefined()
  })
})

describe('goalChoices', () => {
  it('offers three metrics that have a typical value, then get-it-live last', () => {
    const choices = goalChoices(['store'], 'Pet supplies')
    expect(choices).toHaveLength(4)
    expect(choices[3].id).toBe(GOAL_LIVE)
    for (const pick of choices.slice(0, 3)) expect(metricById(pick.id)?.benchmarks, pick.id).toBeTruthy()
  })

  it('pre-fills the target from the niche number', () => {
    const [first] = goalChoices(['store'], 'Pet supplies')
    const pets = metricById(BUYERS)!.benchmarks!.find((b) => b.niche === 'Pet supplies')!
    expect(first).toMatchObject({ id: BUYERS, target: pets.value, typical: `${pets.value}%` })
    expect(first.hint.startsWith(`Typical for ${pets.group}. `)).toBe(true)
  })

  it('with no project type there is only get-it-live', () => {
    expect(goalChoices([]).map((c) => c.id)).toEqual([GOAL_LIVE])
  })
})

describe('goalText', () => {
  it('reads as metric, number with its unit, then the day', () => {
    expect(goalDay('2026-12-31')).toBe('31 Dec 2026')
    expect(goalText({ goal: { metric: BUYERS, target: 3.5, by: '2026-12-31' } })).toBe(
      'Visitors who buy to 3.5% by 31 Dec 2026'
    )
    expect(goalText({ goal: { metric: ORDER_VALUE, target: 80 } })).toBe('Average order value to $80')
    expect(goalText({ goal: { metric: BUYERS } })).toBe('Visitors who buy')
  })

  it('is empty for no goal or a metric that no longer exists', () => {
    expect(goalText(undefined)).toBe('')
    expect(goalText({ what: 'Shop' })).toBe('')
    expect(goalText({ goal: { metric: 'store.retired-metric', target: 3 } })).toBe('')
  })

  it('get-it-live has its own wording', () => {
    expect(goalText({ goal: { metric: GOAL_LIVE } })).toBe('Get it live first')
  })
})

describe('kindWanted', () => {
  const kind = (id: string): InfraKind => INFRA_KINDS.find((k) => k.id === id)!
  const record = (over: Partial<InfraRecord>): InfraRecord => ({
    checkedAt: '2026-10-02T00:00:00Z',
    appKinds: ['web'],
    services: {},
    skip: [],
    ...over
  })

  it('a skipped kind stays skipped even if it is also wanted', () => {
    expect(kindWanted(kind('auth'), record({ skip: ['auth'], want: ['auth'], business: ['saas'] }))).toBe(false)
  })

  it('an explicit want overrides both the app kind and the business type', () => {
    expect(kindWanted(kind('push'), record({ appKinds: ['web'], want: ['push'], business: ['content'] }))).toBe(true)
  })

  it('a kind that does not apply to this app is not wanted', () => {
    expect(kindWanted(kind('seo'), record({ appKinds: ['mobile'], business: ['store'] }))).toBe(false)
  })

  it('once the business type is known, a question kind is wanted only if that business needs it', () => {
    expect(kindWanted(kind('auth'), record({ business: ['content'] }))).toBe(false)
    expect(kindWanted(kind('auth'), record({ business: ['content', 'saas'] }))).toBe(true)
    expect(kindWanted(kind('seo'), record({ business: ['content'] }))).toBe(true)
  })

  it('before the business type is known, question kinds are still asked', () => {
    expect(kindWanted(kind('auth'), record({}))).toBe(true)
    expect(kindWanted(kind('auth'), record({ business: [] }))).toBe(true)
  })

  it('infraNeeds lists wanted kinds with nothing set up, and drops one once it has a service', () => {
    const content = record({ business: ['content'] })
    const needs = infraNeeds(content).map((k) => k.id)
    expect(needs).toEqual(expect.arrayContaining(['seo', 'email']))
    expect(needs).not.toContain('auth')
    expect(needs).not.toContain('payments')
    const withSeo = record({ business: ['content'], services: { seo: [{ provider: 'own' }] } })
    expect(infraNeeds(withSeo).map((k) => k.id)).not.toContain('seo')
    expect(infraNeeds(null)).toEqual([])
  })
})
