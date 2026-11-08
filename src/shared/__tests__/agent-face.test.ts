import { describe, it, expect } from 'vitest'
import {
  AGENT_SHAPES,
  AGENT_FACE_COLORS,
  AGENT_FACE_COUNT,
  avatarFor,
  sessionFaceId,
  senderFaceId
} from '../agent-face'

describe('avatarFor', () => {
  it('returns the same pair for the same id', () => {
    expect(avatarFor('sess-a')).toEqual(avatarFor('sess-a'))
  })

  it('gives a defined pair for an empty id', () => {
    const pair = avatarFor('')
    expect(AGENT_SHAPES).toContain(pair.shape)
    expect(AGENT_FACE_COLORS).toContain(pair.color)
  })

  it('has 50 combos', () => {
    expect(AGENT_FACE_COUNT).toBe(50)
    expect(AGENT_SHAPES.length * AGENT_FACE_COLORS.length).toBe(50)
  })
})

describe('sessionFaceId', () => {
  it('prefers sessionId over label', () => {
    expect(sessionFaceId({ sessionId: 'uuid-1', label: 'repo/dev - tag' })).toBe('uuid-1')
  })

  it('falls back to label when sessionId is missing', () => {
    expect(sessionFaceId({ label: 'repo/dev - tag' })).toBe('repo/dev - tag')
  })
})

describe('senderFaceId', () => {
  const sessions = [
    { sessionId: 'uuid-a', label: 'ShowAndTell/dev - aa', stated: 'Jarvis' },
    { sessionId: 'uuid-b', label: 'ShowAndTell/dev - bb' }
  ]

  it('joins on stated name then uses sessionId', () => {
    expect(senderFaceId('Jarvis', sessions)).toBe('uuid-a')
  })

  it('joins on label when nothing is stated', () => {
    expect(senderFaceId('ShowAndTell/dev - bb', sessions)).toBe('uuid-b')
  })

  it('hashes the from string when no session matches', () => {
    expect(senderFaceId('unknown-agent', sessions)).toBe('unknown-agent')
  })

  it('returns empty when from is missing', () => {
    expect(senderFaceId(undefined, sessions)).toBe('')
  })
})
