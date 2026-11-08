import { describe, expect, it } from 'vitest'
import { parseClaudeJsonOutput } from '../../backend/parse'
import { factoryUsage, parsePlanDrafts, parseReview, takeAgentReply } from '../../../shared/factory'

const tasksJson =
  '{"tasks":[{"title":"Fix reconnect","outcome":"Pairing recovers after a drop","acceptance":["The phone reconnects"],"scope":["src/reconnect.ts"],"dependsOn":[],"sourceFile":"src/reconnect.ts"}]}'
const reviewJson = '{"pass":false,"findings":"The reconnect path never retries."}'

function stream(result: string): string {
  return [
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '{"tasks":[{"title":"Wrong"}]}' }] }
    }),
    JSON.stringify({ type: 'result', result })
  ].join('\n')
}

describe('agent replies', () => {
  it('rejects a hook failure even when the CLI exits successfully', () => {
    expect(
      takeAgentReply(
        'UserPromptSubmit operation blocked by hook:\nprivate hook details\nOriginal prompt: ' +
          tasksJson,
        0
      )
    ).toEqual({
      error: 'A Claude startup hook stopped the attempt. Fix the hook, then try again.'
    })
  })

  it('reads the parsed result, not the earlier JSONL object', () => {
    const raw = stream(tasksJson)
    const parsed = parseClaudeJsonOutput(raw)
    expect(parsed).toBe(tasksJson)
    expect(parsePlanDrafts(raw, 'brief').drafts).toEqual([])
    expect(parsePlanDrafts(parsed ?? '', 'brief').drafts.map((draft) => draft.title)).toEqual([
      'Fix reconnect'
    ])
    const reviewRaw = stream(reviewJson)
    expect(parseReview(reviewRaw)).toBeNull()
    expect(parseReview(parseClaudeJsonOutput(reviewRaw) ?? '')).toEqual({
      pass: false,
      findings: 'The reconnect path never retries.'
    })
  })

  it('does not turn a nonzero exit into drafts or a pass', () => {
    const reply = takeAgentReply(tasksJson, 1)
    expect(reply).toEqual({ error: 'The agent stopped before it finished.' })
    expect('text' in reply).toBe(false)
    expect(takeAgentReply('{"pass":true,"findings":""}', -3)).toEqual({
      error: 'The attempt timed out.'
    })
    expect(takeAgentReply('{"pass":true,"findings":""}', 0)).toEqual({
      text: '{"pass":true,"findings":""}'
    })
  })
})

describe('Factory usage accounting', () => {
  it('uses terminal totals once and keeps missing usage unknown', () => {
    const final = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 30 },
      total_cost_usd: 0.02,
      modelUsage: { 'model-a': {} }
    })
    expect(factoryUsage(final + '\n' + final)).toEqual({
      usage: { input: 12, output: 4, cacheRead: 30, cacheWrite: null, costUsd: 0.02 },
      models: ['model-a']
    })
    expect(factoryUsage('{"type":"result"}').usage).toBeNull()
    expect(
      factoryUsage('{"type":"result","usage":{"input_tokens":0,"output_tokens":0}}').usage?.input
    ).toBe(0)
    expect(factoryUsage('partial stream').usage).toBeNull()
  })
})
