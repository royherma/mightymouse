import { describe, expect, it } from 'vitest'
import { describeGithubItem, splitNewItems, toGithubItems, type GithubItem } from '../github-trigger'

const item = (id: string): GithubItem => ({ id, title: `PR ${id}`, url: `https://github.com/o/r/pull/${id}` })

describe('splitNewItems', () => {
  it('the first poll records what already exists and fires nothing', () => {
    expect(splitNewItems([item('1'), item('2')], undefined)).toEqual({ fresh: [], seen: ['1', '2'] })
  })

  it('a later poll fires only ids it has not seen, and remembers them', () => {
    expect(splitNewItems([item('3'), item('2'), item('1')], ['1', '2'])).toEqual({ fresh: [item('3')], seen: ['1', '2', '3'] })
  })

  it('an empty first poll still arms the trigger, so the next new item fires', () => {
    const armed = splitNewItems([], undefined)
    expect(armed.seen).toEqual([])
    expect(splitNewItems([item('9')], armed.seen).fresh).toEqual([item('9')])
  })

  it('keeps only the newest 300 ids', () => {
    const old = Array.from({ length: 300 }, (_, i) => `old-${i}`)
    const { seen } = splitNewItems([item('new')], old)
    expect(seen).toHaveLength(300)
    expect(seen.at(-1)).toBe('new')
    expect(seen[0]).toBe('old-1')
  })
})

describe('toGithubItems', () => {
  const raw = [
    { number: 1, title: 'green', url: 'u1', headRefOid: 'aaa', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
    { number: 2, title: 'red', url: 'u2', headRefOid: 'bbb', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }] },
    { number: 3, title: 'errored status', url: 'u3', headRefOid: 'ccc', statusCheckRollup: [{ state: 'ERROR' }] },
    { number: 4, title: 'no checks', url: 'u4', headRefOid: 'ddd' },
    { number: 5, title: 'pending', url: 'u5', headRefOid: 'eee', statusCheckRollup: [{ state: 'PENDING' }] }
  ]

  it('checks-failed keeps only pull requests with a failed or errored check, keyed by head commit', () => {
    expect(toGithubItems('checks-failed', raw)).toEqual([
      { id: '2@bbb', title: 'red', url: 'u2' },
      { id: '3@ccc', title: 'errored status', url: 'u3' }
    ])
  })

  it('a new commit that fails again is a new item', () => {
    const first = toGithubItems('checks-failed', [raw[1]])
    const pushed = toGithubItems('checks-failed', [{ ...raw[1], headRefOid: 'fff' }])
    expect(splitNewItems(pushed, first.map((i) => i.id)).fresh).toEqual([{ id: '2@fff', title: 'red', url: 'u2' }])
  })

  it('opened events keep every row, keyed by number alone', () => {
    expect(toGithubItems('pr-opened', raw).map((i) => i.id)).toEqual(['1', '2', '3', '4', '5'])
    expect(toGithubItems('issue-opened', [{ number: 8, title: 'bug', url: 'u8' }])).toEqual([{ id: '8', title: 'bug', url: 'u8' }])
  })
})

describe('describeGithubItem', () => {
  it('says what happened, which item, and then the job instructions', () => {
    expect(describeGithubItem('checks-failed', item('2'), 'Fix the failing test.')).toBe(
      'Checks failed on a pull request: PR 2 https://github.com/o/r/pull/2. Fix the failing test.'
    )
  })
})
