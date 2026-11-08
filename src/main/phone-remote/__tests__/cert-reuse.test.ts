/**
 * Regression guard for the cert-reuse check.
 *
 * The original implementation tested `certPem.includes('IP Address:' + ip)`.
 * A PEM is base64-encoded DER, so that readable form NEVER appears in the
 * file -- the check was permanently false and regenerated a fresh keypair on
 * every app start. Each regen voids Safari's per-certificate trust exception,
 * which strands an installed PWA (no URL bar to approve the new cert) on
 * "Can't find your Mac".
 *
 * The bug was invisible because nothing asserted the positive case: reusing a
 * cert that DOES cover the current IP. That's the first test below.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import selfsigned from 'selfsigned'
import { certCoversLanIp } from '../server'

const LAN_IP = '192.168.1.10'
const OTHER_IP = '10.0.0.5'

/** Cache keyed on the only two inputs, because `selfsigned.generate` is a real
 *  2048-bit RSA keygen -- seconds of pure CPU per call, not microseconds. Four
 *  callsites below asked for three distinct certs, and the repeat was enough to
 *  starve the sibling suite that stands up a real HTTPS server
 *  (ws-auth-gate.test.ts) past its 20s beforeAll under full-suite parallelism.
 *  That surfaced as an auth assertion failing in the full run while passing in
 *  isolation, which reads exactly like a broken security gate rather than a
 *  slow one. certCoversLanIp is a pure parser, so one cert per (ip, days) is
 *  indistinguishable from a fresh one to every assertion here. */
const certCache = new Map<string, string>()

function makeCert(ip: string, days = 365): string {
  const key = `${ip}:${days}`
  const hit = certCache.get(key)
  if (hit) return hit
  const pem = generateCert(ip, days)
  certCache.set(key, pem)
  return pem
}

function generateCert(ip: string, days: number): string {
  return selfsigned.generate([{ name: 'commonName', value: 'mightymouse.local' }], {
    days,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'mightymouse.local' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip }
        ]
      }
    ]
  }).cert
}

describe('certCoversLanIp', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The three cases below carry a 30s budget rather than the 5s default: each is
  // the first miss on its own cache key, so each pays a cold 2048-bit keygen. On
  // a loaded machine one of those alone can exceed 5s, and the resulting timeout
  // names the assertion rather than the keygen -- it reads as certCoversLanIp
  // being broken.
  it('reuses a cert whose SAN covers the current LAN IP', () => {
    // The case the substring check got wrong -- this is the whole bug.
    expect(certCoversLanIp(makeCert(LAN_IP), LAN_IP)).toBe(true)
  }, 30_000)

  it('regenerates when the LAN IP is not in the SAN (real DHCP change)', () => {
    expect(certCoversLanIp(makeCert(OTHER_IP), LAN_IP)).toBe(false)
  }, 30_000)

  it('regenerates an expired cert even when the IP still matches', () => {
    // selfsigned verifies its own output and refuses to emit an already-expired
    // cert, so age the CLOCK past a short-lived cert rather than backdating it.
    const cert = makeCert(LAN_IP, 1)
    const twoDaysOut = Date.now() + 2 * 24 * 60 * 60 * 1000
    vi.spyOn(Date, 'now').mockReturnValue(twoDaysOut)
    expect(certCoversLanIp(cert, LAN_IP)).toBe(false)
  }, 30_000)

  it('regenerates rather than throwing on an unparseable cert', () => {
    expect(certCoversLanIp('not a certificate', LAN_IP)).toBe(false)
    expect(certCoversLanIp('', LAN_IP)).toBe(false)
  })

  it('does not match the IP as a raw substring of the PEM', () => {
    // Guards the specific regression: a PEM body can contain arbitrary base64,
    // so a substring test is both false-negative (above) and unsound here.
    const pem = makeCert(LAN_IP)
    expect(pem.includes(`IP Address:${LAN_IP}`)).toBe(false)
  })
})
