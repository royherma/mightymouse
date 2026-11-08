#!/usr/bin/env node
// Generate supabase/functions/_shared/disposable-domains.ts from the public
// disposable-email-domains blocklist.
//
// Why vendored rather than fetched at runtime: abuse-guard.ts is on the
// signup/checkout hot path and its house rule is that a guard failure must
// never take down the route. A network call per signup would turn a cost guard
// into a latency-and-outage source, so the list ships as a frozen Set -- ~8.7k
// strings, zero dependencies, zero I/O.
//
// Refresh with `npm run gen:disposable`; CI runs `--check` so a stale file
// fails the build rather than silently drifting.
//
// The list does NOT cover alias relays (SimpleLogin, addy.io, DuckDuckGo).
// Those are handled separately in abuse-guard.ts -- see ALIAS_RELAY_DOMAINS
// there for why they need their own list and an MX-suffix fallback.

import { readFileSync, writeFileSync } from 'node:fs'

const SOURCE_URL =
  'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf'
const OUT_PATH = new URL('../supabase/functions/_shared/disposable-domains.ts', import.meta.url)

// Domains the upstream list must never be allowed to block, checked after the
// fetch. Proton is a PAID inbox used by exactly our buyer profile -- if it ever
// lands upstream, that is a bug in the list, not a signal about the domain.
// A hard exit here is deliberate: silently dropping the entry would hide the
// fact that upstream's policy changed.
const NEVER_BLOCK = [
  'proton.me',
  'protonmail.com',
  'protonmail.ch',
  'pm.me',
  'gmail.com',
  'googlemail.com',
  'icloud.com',
  'me.com',
  'outlook.com',
  'hotmail.com',
  'yahoo.com',
  'fastmail.com',
  'hey.com',
  'zoho.com',
]

// A sane floor. If upstream ever serves an error page or a truncated file, the
// parse would yield a handful of junk "domains" and we would ship a blocklist
// that blocks nothing -- failing loudly beats shipping a no-op guard.
const MIN_EXPECTED_DOMAINS = 5000

/** Parse the upstream .conf: one domain per line, `#` comments, blanks. */
export function parseBlocklist(source) {
  const domains = source
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith('#'))
    // Guards against an HTML error page parsing as "domains".
    .filter((line) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(line))
  return [...new Set(domains)].sort()
}

/** Render the generated TypeScript module. */
export function renderModule(domains) {
  const entries = domains.map((d) => `  '${d}',`).join('\n')
  return `// GENERATED FILE -- DO NOT EDIT BY HAND.
// Regenerate with: npm run gen:disposable
// Source: ${SOURCE_URL}
// Count: ${domains.length}
//
// Known disposable/throwaway inbox providers. Consumed by isDisposableEmail in
// abuse-guard.ts. Alias relays (SimpleLogin, addy.io, DuckDuckGo) are NOT here
// -- they live in ALIAS_RELAY_DOMAINS in abuse-guard.ts, which also carries the
// reason they need separate handling.

export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
${entries}
])
`
}

async function main() {
  const check = process.argv.includes('--check')

  const res = await fetch(SOURCE_URL)
  if (!res.ok) {
    console.error(`gen-disposable-domains: fetch failed -- HTTP ${res.status} from ${SOURCE_URL}`)
    process.exit(1)
  }
  const domains = parseBlocklist(await res.text())

  if (domains.length < MIN_EXPECTED_DOMAINS) {
    console.error(
      `gen-disposable-domains: only ${domains.length} domains parsed (expected >= ${MIN_EXPECTED_DOMAINS}) -- refusing to write a list that blocks nothing.`,
    )
    process.exit(1)
  }

  const blocked = NEVER_BLOCK.filter((d) => domains.includes(d))
  if (blocked.length > 0) {
    console.error(
      `gen-disposable-domains: upstream now lists real providers we must never block: ${blocked.join(', ')}. Investigate before regenerating.`,
    )
    process.exit(1)
  }

  const next = renderModule(domains)

  if (check) {
    let current = ''
    try {
      current = readFileSync(OUT_PATH, 'utf8')
    } catch {
      console.error('gen-disposable-domains: generated file missing -- run `npm run gen:disposable`.')
      process.exit(1)
    }
    if (current !== next) {
      console.error('gen-disposable-domains: generated file is stale -- run `npm run gen:disposable`.')
      process.exit(1)
    }
    console.log(`gen-disposable-domains: up to date (${domains.length} domains).`)
    return
  }

  writeFileSync(OUT_PATH, next)
  console.log(`gen-disposable-domains: wrote ${domains.length} domains.`)
}

main()
