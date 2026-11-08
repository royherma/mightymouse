import { describe, it, expect } from 'vitest'
import { INFRA_KINDS } from '../infra'

const patterns = (id: string): RegExp[] => {
  const p = INFRA_KINDS.flatMap((k) => k.providers).find((x) => x.id === id)
  if (!p?.code) throw new Error(`no provider ${id}`)
  return p.code.map((r) => new RegExp(r, 'm'))
}
const hits = (id: string, text: string): boolean => patterns(id).some((r) => r.test(text))

describe('own_visits', () => {
  it('matches a page-view insert that records the path', () => {
    expect(hits('own_visits', "db.prepare('INSERT INTO page_views (path, ts) VALUES (?, ?)')")).toBe(true)
    expect(hits('own_visits', 'INSERT INTO events (name, path) VALUES')).toBe(true)
  })

  it('ignores inserts into other tables or without a path', () => {
    expect(hits('own_visits', 'INSERT INTO users (email, path) VALUES')).toBe(false)
    expect(hits('own_visits', 'INSERT INTO events (name, ts) VALUES (?, ?)')).toBe(false)
  })
})

describe('own_error_alert', () => {
  it('matches an onError handler that sends an alert', () => {
    expect(hits('own_error_alert', 'app.onError((err, c) => {\n  await fetch(env.SLACK_WEBHOOK_URL)\n})')).toBe(true)
  })

  it('ignores an onError handler that only logs', () => {
    expect(hits('own_error_alert', 'app.onError((err) => {\n  console.error(err)\n  return c.text("x", 500)\n})')).toBe(false)
  })
})
