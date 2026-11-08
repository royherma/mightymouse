// Scrubs sensitive substrings out of a buffered text string before it is ever
// written to the ambient context log. Pure + unit-tested (see __tests__/redact.test.ts).
//
// Order matters: tokens first (greediest), then cards, then emails, so a card
// number inside an email-looking string can't slip through the wrong rule.

const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g
// Token prefixes that are unambiguously secrets.
const PREFIXED_TOKEN = /\b(?:sk-[A-Za-z0-9-]+|ghp_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+)\b/g
const BEARER = /Bearer\s+[A-Za-z0-9._-]+/g
// Long high-entropy run: >=24 chars, contains both a letter and a digit.
const HIGH_ENTROPY = /\b(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{24,}\b/g
// 13-16 digit runs, optionally separated by spaces/dashes BETWEEN digits only
// (the trailing separator must not be consumed, or it eats the following space).
const CARD_SHAPED = /\b\d(?:[ -]?\d){12,15}\b/g

function luhnValid(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (n < 0 || n > 9) return false
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

/** Replace emails, card numbers (Luhn-checked), and tokens with redaction tags. */
export function redact(text: string): string {
  let out = text
  out = out.replace(BEARER, 'Bearer [token]')
  out = out.replace(PREFIXED_TOKEN, '[token]')
  out = out.replace(HIGH_ENTROPY, '[token]')
  out = out.replace(CARD_SHAPED, (m) => {
    const digits = m.replace(/[ -]/g, '')
    return luhnValid(digits) ? '[card]' : m
  })
  out = out.replace(EMAIL, '[email]')
  return out
}
