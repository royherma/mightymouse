import { describe, it, expect } from 'vitest'
import { redact } from '../../capture/redact'

describe('redact', () => {
  it('scrubs emails', () => {
    expect(redact('mail me at dev@example.com please')).toBe('mail me at [email] please')
  })

  it('scrubs a Luhn-valid card number', () => {
    // 4111 1111 1111 1111 is the classic Visa test number (Luhn-valid).
    expect(redact('card 4111 1111 1111 1111 ok')).toBe('card [card] ok')
    expect(redact('card 4111-1111-1111-1111 ok')).toBe('card [card] ok')
  })

  it('leaves a Luhn-invalid digit run alone', () => {
    // Not a valid card; should pass through untouched.
    const s = 'order 1234567812345678'
    expect(redact(s)).toBe(s)
  })

  it('scrubs prefixed tokens', () => {
    expect(redact('key sk-ABC123def456 here')).toBe('key [token] here')
    expect(redact('token ghp_abcDEF123456 here')).toBe('token [token] here')
    expect(redact('slack xoxb-12345-abcdef here')).toBe('slack [token] here')
  })

  it('scrubs bearer tokens', () => {
    expect(redact('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [token]')
  })

  it('scrubs long high-entropy strings', () => {
    expect(redact('secret aB3xY9zQ1wE4rT7yU2iO5pL8 done')).toBe('secret [token] done')
  })

  it('leaves ordinary prose untouched', () => {
    const s = 'thanks for the update, shipping friday'
    expect(redact(s)).toBe(s)
  })

  it('leaves short words and plain numbers alone', () => {
    expect(redact('meet at 5 or 600 pm')).toBe('meet at 5 or 600 pm')
  })
})
