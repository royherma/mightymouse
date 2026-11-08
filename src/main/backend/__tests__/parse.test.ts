import { describe, it, expect } from 'vitest'
import { parseActResult, cleanOutput, parseClaudeJsonOutput } from '../parse'
import { buildActPrompts } from '../prompts'

describe('parseActResult', () => {
  it('full line with OUTPUT → {summary, outputPath}', () => {
    const result = parseActResult('ACT_RESULT: converted file | OUTPUT: /tmp/output.mp3')
    expect(result).toEqual({ summary: 'converted file', outputPath: '/tmp/output.mp3' })
  })

  it('summary only (no pipe) → {summary, outputPath: null}', () => {
    const result = parseActResult('ACT_RESULT: done')
    expect(result).toEqual({ summary: 'done', outputPath: null })
  })

  it('OUTPUT with empty value → outputPath null', () => {
    const result = parseActResult('ACT_RESULT: failed: reason | OUTPUT:')
    expect(result).toEqual({ summary: 'failed: reason', outputPath: null })
  })

  it('no ACT_RESULT line → null', () => {
    expect(parseActResult('some random output\nno result here')).toBeNull()
  })

  it('empty string → null', () => {
    expect(parseActResult('')).toBeNull()
  })

  it('multiple ACT_RESULT lines → takes the last', () => {
    const text = [
      'ACT_RESULT: first result | OUTPUT: /tmp/first.mp3',
      'some intermediate output',
      'ACT_RESULT: final result | OUTPUT: /tmp/final.mp3'
    ].join('\n')
    const result = parseActResult(text)
    expect(result).toEqual({ summary: 'final result', outputPath: '/tmp/final.mp3' })
  })

  it('ACT_RESULT buried in multi-line output', () => {
    const text =
      'Running...\nProcessing file...\nACT_RESULT: resized image | OUTPUT: /tmp/out.png\nDone.'
    const result = parseActResult(text)
    expect(result).toEqual({ summary: 'resized image', outputPath: '/tmp/out.png' })
  })
})

describe('cleanOutput', () => {
  it('em dash → space', () => {
    expect(cleanOutput('hello—world')).toBe('hello world')
  })

  it('en dash → hyphen', () => {
    expect(cleanOutput('2020–2021')).toBe('2020-2021')
  })

  it('empty string → empty string', () => {
    expect(cleanOutput('')).toBe('')
  })

  it('trims whitespace', () => {
    expect(cleanOutput('  hello  ')).toBe('hello')
  })
})

describe('parseClaudeJsonOutput', () => {
  it('JSON array with result element → returns result string', () => {
    const input = JSON.stringify([
      { type: 'system', system: 'init' },
      { type: 'result', result: 'the answer' }
    ])
    expect(parseClaudeJsonOutput(input)).toBe('the answer')
  })

  it('takes the last result element in array', () => {
    const input = JSON.stringify([
      { type: 'result', result: 'first' },
      { type: 'result', result: 'last' }
    ])
    expect(parseClaudeJsonOutput(input)).toBe('last')
  })

  it('garbage input → null', () => {
    expect(parseClaudeJsonOutput('not json at all')).toBeNull()
  })

  it('null/empty → null', () => {
    expect(parseClaudeJsonOutput('')).toBeNull()
  })

  it('NDJSON with result line → returns result', () => {
    const lines = [
      JSON.stringify({ type: 'text', text: 'thinking' }),
      JSON.stringify({ type: 'result', result: 'ndjson answer' })
    ].join('\n')
    expect(parseClaudeJsonOutput(lines)).toBe('ndjson answer')
  })
})

describe('buildActPrompts', () => {
  it('system prompt contains skill invocation hint with --permission-mode', () => {
    const { systemPrompt } = buildActPrompts({
      instruction: 'yap this file',
      finderFiles: [],
      selection: '',
      ctxData: null
    })
    expect(systemPrompt).toContain('--permission-mode bypassPermissions')
    expect(systemPrompt).toContain('/yap')
  })

  it('system prompt contains claude binary path', () => {
    const { systemPrompt } = buildActPrompts({
      instruction: 'do something',
      finderFiles: [],
      selection: '',
      ctxData: null
    })
    expect(systemPrompt).toContain('claude')
  })

  it('user prompt includes instruction', () => {
    const { userPrompt } = buildActPrompts({
      instruction: 'convert to mp3',
      finderFiles: ['/tmp/test.mov'],
      selection: '',
      ctxData: null
    })
    expect(userPrompt).toContain('convert to mp3')
    expect(userPrompt).toContain('/tmp/test.mov')
  })
})
