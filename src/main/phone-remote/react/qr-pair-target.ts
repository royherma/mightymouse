/** Turning a scanned QR into a /pair target. The scan itself is native
 *  (Vision) -- no iOS browser engine implements BarcodeDetector. */

import { useEffect } from 'react'
import { CONFIG } from '@shared/config'
import { subscribeNativeIntent, nativeBridge } from './native-bridge'

/** Where to pair, plus the pairing code when the QR carries one. */
export interface PairingTarget {
  host: string
  port: number
  /** The QR's `?c=` -- the same 6 digits the Mac shows, so a scan runs the
   *  same /pair exchange as typing. Null for a QR minted with no running
   *  server; the caller then falls back to the typed code. Authorizes
   *  nothing on its own -- the Mac validates it, never this. */
  code: string | null
}

/** A page URL with a spendable `?c=`. Null when missing, malformed, or not ours. */
export function pairingCodeOnUrl(href: string): PairingTarget | null {
  const target = parsePairingTarget(href)
  return target?.code ? target : null
}

/** Path+search+hash with `?c=` gone, so a reload cannot POST a used code. */
export function stripPairingCodeParam(href: string): string {
  try {
    const url = new URL(href)
    url.searchParams.delete(CONFIG.PHONE_REMOTE.PAIR_CODE_PARAM)
    return url.pathname + url.search + url.hash
  } catch {
    return href
  }
}

export type SpendUrlPairingResult = 'ignored' | 'spent' | 'failed'

/** Spend the QR code on this page once. Strips `?c=` before the POST so an
 *  overlapping dial cannot burn it twice. Already-credentialed is a no-op. */
export async function spendUrlPairingCode(input: {
  href: string
  hasCredential: boolean
  replaceHref: (next: string) => void
  exchange: (
    code: string,
    target: { host: string; port: number }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
}): Promise<SpendUrlPairingResult> {
  if (input.hasCredential) return 'ignored'
  const target = pairingCodeOnUrl(input.href)
  if (!target?.code) return 'ignored'
  input.replaceHref(stripPairingCodeParam(input.href))
  const result = await input.exchange(target.code, { host: target.host, port: target.port })
  return result.ok ? 'spent' : 'failed'
}

/** Null unless the QR is one of ours -- a scanned code is attacker-supplied. */
export function parsePairingTarget(raw: string): PairingTarget | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || !url.hostname) return null
    // A tunnel URL carries no port; the edge implies 443.
    const port = url.port ? Number(url.port) : 443
    if (!Number.isFinite(port) || port <= 0) return null
    const rawCode = url.searchParams.get(CONFIG.PHONE_REMOTE.PAIR_CODE_PARAM)
    // Shape-checked here so a junk QR falls back to the keypad instead of
    // spending the phone's one /pair attempt (5 per minute) on garbage. The
    // Mac still does the real validation -- this is not a trust boundary.
    const digits = new RegExp(`^\\d{${CONFIG.PHONE_REMOTE.PAIR_CODE_LENGTH}}$`)
    return {
      host: url.hostname,
      port,
      code: rawCode && digits.test(rawCode) ? rawCode : null
    }
  } catch {
    return null
  }
}

export type QrScanResult =
  | { kind: 'target'; target: PairingTarget }
  | { kind: 'foreign' }
  | { kind: 'cancelled' }

export function useQrScan(onResult: (result: QrScanResult) => void): { scan: () => void } {
  useEffect(() => {
    return subscribeNativeIntent((intent) => {
      if (intent.type !== 'qrScanned') return
      if (intent.value === null) {
        nativeBridge.log('qr → cancelled')
        return onResult({ kind: 'cancelled' })
      }
      const target = parsePairingTarget(intent.value)
      if (!target) {
        // The payload itself, not just "rejected": every rejection reason here
        // (wrong scheme, no host, bad port) is invisible without seeing it.
        nativeBridge.log(`qr → FOREIGN, payload=${intent.value}`, 'error')
        return onResult({ kind: 'foreign' })
      }
      nativeBridge.log(
        `qr → target ${target.host}:${target.port} code=${target.code ? 'yes' : 'NONE'}`
      )
      onResult({ kind: 'target', target })
    }, [])
  }, [onResult])

  return { scan: () => nativeBridge.scanQr() }
}
