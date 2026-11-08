import { describe, expect, it } from 'vitest'
import { FACTORY, FACTORY_MODEL_DEFAULTS, factoryModelStation } from '../../../shared/factory'
import { FactoryStore } from './store'

function storeWithSaved(raw?: string): FactoryStore {
  const db = new FactoryStore(':memory:')
  if (raw !== undefined) (db as unknown as { setMeta(k: string, v: string): void }).setMeta('models', raw)
  return db
}

describe('factory model per station', () => {
  it('a fresh factory uses Opus for ideas and review, Sonnet for build', () => {
    const db = storeWithSaved()
    expect(db.models()).toEqual({ ideas: 'opus', build: 'sonnet', review: 'opus' })
    expect(db.snapshot().models).toEqual(db.models())
  })

  it('maps the old Smart/Fast choices to Opus/Sonnet', () => {
    const db = storeWithSaved(JSON.stringify({ ideas: 'fast', build: 'smart', review: 'fast' }))
    expect(db.models()).toEqual({ ideas: 'sonnet', build: 'opus', review: 'sonnet' })
  })

  it('keeps valid picks and drops an unknown model per station', () => {
    const db = storeWithSaved(JSON.stringify({ ideas: 'gpt-9', build: 'haiku', review: 'fable' }))
    expect(db.models()).toEqual({ ideas: 'opus', build: 'haiku', review: 'fable' })
  })

  it.each(['not json', 'null', '[]', '"opus"'])('falls back to the defaults when the saved value is %s', (raw) => {
    expect(storeWithSaved(raw).models()).toEqual(FACTORY_MODEL_DEFAULTS)
  })

  it('changing one station keeps the others, including a migrated old choice', () => {
    const db = storeWithSaved(JSON.stringify({ ideas: 'smart', review: 'fast' }))
    db.setLimits({ models: { build: 'haiku' } })
    expect(db.models()).toEqual({ ideas: 'opus', build: 'haiku', review: 'sonnet' })
    db.setLimits({ models: { review: 'fable' } })
    expect(db.models()).toEqual({ ideas: 'opus', build: 'haiku', review: 'fable' })
  })

  it('caps slots at the one-task-at-a-time limit whatever was saved', () => {
    const db = storeWithSaved()
    db.setLimits({ globalSlots: 4 })
    expect(db.snapshot().globalSlots).toBe(FACTORY.maxSlots)
  })

  it.each([
    ['plan', 'ideas'],
    ['review', 'review'],
    ['build', 'build'],
    ['prepare', 'build'],
    ['check', 'build']
  ])('a %s attempt runs on the %s model', (role, station) => {
    expect(factoryModelStation(role)).toBe(station)
  })
})
