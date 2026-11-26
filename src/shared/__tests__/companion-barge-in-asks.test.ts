import { describe, it, expect } from 'vitest'
import { isAskNotDictation, isComposeAsk, isCorrection } from '../companion-barge-in'

describe('isCorrection', () => {
  it.each([
    'No, the other tab',
    'wait that is wrong',
    'Actually, open Safari instead',
    "don't click that",
    'not that one',
    'hold on a second',
    'cancel that please'
  ])('treats %j as aimed at the running turn', (said) => {
    expect(isCorrection(said)).toBe(true)
  })

  it.each([
    'no',
    'Wait.',
    'hold',
    'open the other tab',
    'nothing happened',
    'Noted, thanks',
    'holding pattern now',
    ''
  ])('does not treat %j as a correction', (said) => {
    expect(isCorrection(said)).toBe(false)
  })
})

describe('isAskNotDictation', () => {
  it('routes the verbatim regression to the agent instead of typing it', () => {
    expect(isAskNotDictation('can you fill in the post in my vibe')).toBe(true)
    expect(isAskNotDictation('Can you fill in the post, in my vibe?')).toBe(true)
  })

  it.each([
    'could u reply to him',
    'please send it',
    'write a tweet about cats',
    'come up with a caption',
    'say thanks like I would',
    'something I would say to my boss'
  ])('treats %j as a request', (said) => {
    expect(isAskNotDictation(said)).toBe(true)
  })

  it.each([
    'see you at five',
    "can't wait to see you",
    'posting this now',
    'the draft is attached',
    'I will call you later'
  ])('treats %j as words to type', (said) => {
    expect(isAskNotDictation(said)).toBe(false)
  })
})

describe('isComposeAsk', () => {
  it.each([
    'write a reply to this email',
    'can you fill in the post in my vibe',
    'draft a message to Sam',
    'respond like I would',
    'come up with a caption for this photo'
  ])('gives %j the writing recipe', (said) => {
    expect(isComposeAsk(said)).toBe(true)
  })

  it.each([
    'write the code for the login page',
    'open my email',
    'answer the phone',
    'what is on my screen',
    'post it'
  ])('does not give %j the writing recipe', (said) => {
    expect(isComposeAsk(said)).toBe(false)
  })
})
