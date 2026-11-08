import { describe, it, expect } from 'vitest'
import {
  computeChargeCents,
  computeChargeCentsFromCost,
  classifyProxyResponse,
  proxyResponseClassToExitCode,
  ANTHROPIC_PRICES_PER_M
} from '../billing-math'
import { CONFIG } from '../config'
import { LIFETIME_ERROR } from '../types'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── computeChargeCents ───────────────────────────────────────────────────────

describe('computeChargeCents', () => {
  it('zero tokens → 0 cents', () => {
    expect(computeChargeCents({ input_tokens: 0, output_tokens: 0 }, 1.4)).toBe(0)
  })

  it('input-only charge at default markup (1.4)', () => {
    // 1M input tokens at $15/M → $15 → ×1.4 = $21 → 2100 cents
    expect(computeChargeCents({ input_tokens: 1_000_000, output_tokens: 0 }, 1.4)).toBe(2100)
  })

  it('output-only charge at default markup (1.4)', () => {
    // 1M output tokens at $75/M → $75 → ×1.4 = $105 → 10500 cents
    expect(computeChargeCents({ input_tokens: 0, output_tokens: 1_000_000 }, 1.4)).toBe(10500)
  })

  it('cache_read tokens priced at cache_read rate', () => {
    // 1M cache_read tokens at $1.50/M → $1.50 → ×1.4 = $2.10 → 210 cents
    expect(
      computeChargeCents({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000 }, 1.4)
    ).toBe(210)
  })

  it('cache_creation tokens priced at cache_creation rate', () => {
    // 1M cache_creation at $3.75/M → $3.75 → ×1.4 = $5.25 → 525 cents
    expect(
      computeChargeCents({ input_tokens: 0, output_tokens: 0, cache_creation_tokens: 1_000_000 }, 1.4)
    ).toBe(525)
  })

  it('combined usage — small realistic request', () => {
    // 500 input + 200 output tokens (typical short rewrite)
    // input:  500 / 1e6 × $15 = $0.0075
    // output: 200 / 1e6 × $75 = $0.015
    // total:  $0.0225 → ×1.4 = $0.0315 → round(3.15) = 3 cents
    expect(computeChargeCents({ input_tokens: 500, output_tokens: 200 }, 1.4)).toBe(3)
  })

  it('markup multiplier = 1 (no markup) passes through raw cost', () => {
    // 1M input at $15/M → $15 → ×1 = $15 → 1500 cents
    expect(computeChargeCents({ input_tokens: 1_000_000, output_tokens: 0 }, 1.0)).toBe(1500)
  })

  it('markup multiplier = 2 doubles the cost', () => {
    // 1M output at $75/M → $75 → ×2 = $150 → 15000 cents
    expect(computeChargeCents({ input_tokens: 0, output_tokens: 1_000_000 }, 2.0)).toBe(15000)
  })

  it('missing optional cache fields default to 0 (no extra charge)', () => {
    const withCache = computeChargeCents(
      { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0 },
      1.4
    )
    const withoutCache = computeChargeCents({ input_tokens: 1000, output_tokens: 500 }, 1.4)
    expect(withCache).toBe(withoutCache)
  })

  it('result is always a non-negative integer', () => {
    // Very small usage rounds to 0, never goes negative
    const result = computeChargeCents({ input_tokens: 1, output_tokens: 1 }, 1.4)
    expect(Number.isInteger(result)).toBe(true)
    expect(result).toBeGreaterThanOrEqual(0)
  })

  it('prices in ANTHROPIC_PRICES_PER_M match spec values', () => {
    // If someone changes the constants, this forces them to update the test too —
    // protecting against accidentally cheap/expensive pricing.
    expect(ANTHROPIC_PRICES_PER_M.input).toBe(15.0)
    expect(ANTHROPIC_PRICES_PER_M.output).toBe(75.0)
    expect(ANTHROPIC_PRICES_PER_M.cache_read).toBe(1.5)
    expect(ANTHROPIC_PRICES_PER_M.cache_creation).toBe(3.75)
  })
})

// ── computeChargeCentsFromCost (OpenRouter real-cost path) ───────────────────

describe('computeChargeCentsFromCost', () => {
  it('zero cost → 0 cents', () => {
    expect(computeChargeCentsFromCost(0, 1.4)).toBe(0)
  })

  it('$1.00 upstream at default markup (1.4) → 140 cents', () => {
    expect(computeChargeCentsFromCost(1.0, 1.4)).toBe(140)
  })

  it('markup = 1 passes through raw cost', () => {
    // $0.0225 upstream → ×1 = $0.0225 → round(2.25) = 2 cents
    expect(computeChargeCentsFromCost(0.0225, 1.0)).toBe(2)
  })

  it('markup = 2 doubles the cost', () => {
    // $0.50 upstream → ×2 = $1.00 → 100 cents
    expect(computeChargeCentsFromCost(0.5, 2.0)).toBe(100)
  })

  it('tiny cost rounds to 0, never negative', () => {
    const result = computeChargeCentsFromCost(0.00001, 1.4)
    expect(result).toBe(0)
    expect(result).toBeGreaterThanOrEqual(0)
  })

  it('negative / NaN upstream cost clamps to 0 (never credit the user)', () => {
    expect(computeChargeCentsFromCost(-5, 1.4)).toBe(0)
    expect(computeChargeCentsFromCost(Number.NaN, 1.4)).toBe(0)
    expect(computeChargeCentsFromCost(Infinity, 1.4)).toBe(0)
  })

  it('default markup is 1.4 when omitted', () => {
    expect(computeChargeCentsFromCost(1.0)).toBe(computeChargeCentsFromCost(1.0, 1.4))
  })

  it('result is always a non-negative integer', () => {
    const result = computeChargeCentsFromCost(0.0137, 1.4)
    expect(Number.isInteger(result)).toBe(true)
    expect(result).toBeGreaterThanOrEqual(0)
  })
})

// ── CONFIG.BILLING.PACKS lookup ──────────────────────────────────────────────

describe('CONFIG.BILLING.PACKS', () => {
  it('contains exactly 3 packs', () => {
    expect(CONFIG.BILLING.PACKS).toHaveLength(3)
  })

  it('pack ids are pack_20, pack_100, pack_200', () => {
    const ids = CONFIG.BILLING.PACKS.map((p) => p.id)
    expect(ids).toContain('pack_20')
    expect(ids).toContain('pack_100')
    expect(ids).toContain('pack_200')
  })

  it('each pack has a non-empty label and bonus_label', () => {
    for (const pack of CONFIG.BILLING.PACKS) {
      expect(pack.label.length).toBeGreaterThan(0)
      expect(pack.bonus_label.length).toBeGreaterThan(0)
    }
  })

  it('pack_20 lookup by id succeeds', () => {
    const pack = CONFIG.BILLING.PACKS.find((p) => p.id === 'pack_20')
    expect(pack).toBeDefined()
    expect(pack?.label).toBe('$20')
  })

  it('pack_100 lookup by id succeeds', () => {
    const pack = CONFIG.BILLING.PACKS.find((p) => p.id === 'pack_100')
    expect(pack).toBeDefined()
    expect(pack?.label).toBe('$100')
  })

  it('pack_200 lookup by id succeeds', () => {
    const pack = CONFIG.BILLING.PACKS.find((p) => p.id === 'pack_200')
    expect(pack).toBeDefined()
    expect(pack?.label).toBe('$200')
  })

  it('unknown pack id returns undefined (no implicit sentinel)', () => {
    const pack = CONFIG.BILLING.PACKS.find((p) => p.id === ('pack_999' as string))
    expect(pack).toBeUndefined()
  })

  it('EDGE_FUNCTION_URL is defined and starts with https', () => {
    expect(CONFIG.BILLING.EDGE_FUNCTION_URL).toMatch(/^https:\/\//)
  })
})

// ── Out-of-credits signal contract ──────────────────────────────────────────

describe('classifyProxyResponse', () => {
  it('200 → ok', () => expect(classifyProxyResponse(200)).toBe('ok'))
  it('201 → ok', () => expect(classifyProxyResponse(201)).toBe('ok'))
  it('299 → ok', () => expect(classifyProxyResponse(299)).toBe('ok'))
  it('402 → out_of_credits', () => expect(classifyProxyResponse(402)).toBe('out_of_credits'))
  it('401 → error (not out-of-credits)', () => expect(classifyProxyResponse(401)).toBe('error'))
  it('403 → error', () => expect(classifyProxyResponse(403)).toBe('error'))
  it('500 → error', () => expect(classifyProxyResponse(500)).toBe('error'))
  it('0 → error (network-level fail)', () => expect(classifyProxyResponse(0)).toBe('error'))
})

describe('proxyResponseClassToExitCode', () => {
  it('ok → exit code 0', () => {
    expect(proxyResponseClassToExitCode('ok', 200)).toBe(0)
  })

  it('out_of_credits → exit code -2 (panel shows top-up UI)', () => {
    // -2 is the sentinel defined in adapters.ts + runner.ts; this test documents the contract.
    expect(proxyResponseClassToExitCode('out_of_credits', 402)).toBe(-2)
  })

  it('error with real HTTP status → exit code = http status', () => {
    expect(proxyResponseClassToExitCode('error', 500)).toBe(500)
    expect(proxyResponseClassToExitCode('error', 401)).toBe(401)
  })

  it('error with status 0 (network failure) → -1', () => {
    expect(proxyResponseClassToExitCode('error', 0)).toBe(-1)
  })
})

describe('402 maps to exit-code -2 (end-to-end contract)', () => {
  it('HTTP 402 classifies as out_of_credits which maps to exit-code -2', () => {
    const cls = classifyProxyResponse(402)
    const exitCode = proxyResponseClassToExitCode(cls, 402)
    expect(cls).toBe('out_of_credits')
    expect(exitCode).toBe(-2)
  })
})

// ── Lifetime offer ───────────────────────────────────────────────────────────
// The refusal codes cross the client/Edge-fn boundary. Deno functions can't
// import from src/, so LIFETIME_ERROR is duplicated in stripe-checkout by
// necessity — and a duplicated contract is exactly what drifts silently. These
// tests read the REAL function source and assert the two halves still agree,
// which the typechecker structurally cannot do across that boundary.

describe('LIFETIME_ERROR ↔ stripe-checkout contract', () => {
  const checkoutSrc = readFileSync(
    resolve(__dirname, '../../../supabase/functions/stripe-checkout/index.ts'),
    'utf8'
  )

  it('every client-side refusal code appears in the Edge function source', () => {
    for (const code of Object.values(LIFETIME_ERROR)) {
      expect(checkoutSrc).toContain(`'${code}'`)
    }
  })

  it('the Edge fn declares no refusal code the client cannot handle', () => {
    // Pull the literals out of the fn's own LIFETIME_REFUSAL block and check
    // each one has a client-side counterpart. A new server code with no client
    // copy would render as a generic "could not start checkout".
    const block = checkoutSrc.match(/const LIFETIME_REFUSAL = \{([\s\S]*?)\} as const;/)
    expect(block).not.toBeNull()
    const serverCodes = [...(block?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(serverCodes.length).toBeGreaterThan(0)
    const clientCodes = Object.values(LIFETIME_ERROR) as string[]
    for (const code of serverCodes) {
      expect(clientCodes).toContain(code)
    }
  })

  it('lifetime is a member of the checkout-kind union both sides use', () => {
    // The union lives in types.ts (BillingItemKind) and is mirrored by
    // CHECKOUT_KIND in the fn. A kind the server rejects is an unbuyable button.
    expect(checkoutSrc).toMatch(/CHECKOUT_KIND = \{[^}]*lifetime: 'lifetime'/)
  })
})

describe('CONFIG.BILLING.LIFETIME copy rules', () => {
  it('never says "unlimited" without qualifying it with the user\'s own key', () => {
    // The rule that keeps refund requests down: under Reading A the paid backend
    // still meters credits, so a bare "unlimited" is a promise we do not keep.
    for (const [field, text] of Object.entries(CONFIG.BILLING.LIFETIME)) {
      if (typeof text !== 'string') continue
      if (/unlimited/i.test(text)) {
        expect(text, `${field} says "unlimited" unqualified`).toMatch(/your own (api )?key/i)
      }
    }
  })

  it('uses no em or en dashes (brand voice)', () => {
    for (const [field, text] of Object.entries(CONFIG.BILLING.LIFETIME)) {
      if (typeof text !== 'string') continue
      expect(text, `${field} contains an em/en dash`).not.toMatch(/[—–]/)
    }
  })

  it('shows no seat number or cap count in any user-facing string', () => {
    // The cap bounds liability; it is deliberately never a pitch. A stray
    // "of 100" here would turn an invisible bound into a scarcity claim.
    for (const [field, text] of Object.entries(CONFIG.BILLING.LIFETIME)) {
      if (typeof text !== 'string') continue
      expect(text, `${field} leaks a seat/cap number`).not.toMatch(/\b\d+\s*(of|\/)\s*\d+\b/)
      expect(text, `${field} leaks a seat number`).not.toMatch(/#\d+/)
    }
  })

  it('closed and already-owned refusals have distinct, non-empty copy', () => {
    const { closed_message, already_message, owned_label } = CONFIG.BILLING.LIFETIME
    expect(closed_message.length).toBeGreaterThan(0)
    expect(already_message.length).toBeGreaterThan(0)
    expect(owned_label.length).toBeGreaterThan(0)
    expect(closed_message).not.toBe(already_message)
  })
})
