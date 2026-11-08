/**
 * Self-signed TLS cert for the phone-remote HTTPS server: generated once,
 * cached under PATHS.ROOT, regenerated when the LAN IP or validity changes.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { X509Certificate } from 'crypto'
import { join } from 'path'
import selfsigned from 'selfsigned'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { PATHS } from '../store/paths'

const CERT_KEY_PATH = join(PATHS.ROOT, 'phone-remote-cert-key.pem')
const CERT_CERT_PATH = join(PATHS.ROOT, 'phone-remote-cert.pem')
// Regenerate yearly rather than never, so a long-lived install doesn't carry
// a cert past a sane lifetime -- the phone just eats one more "not private"
// tap-through the day it rotates.
const CERT_VALID_DAYS = 365

export function certCoversLanIp(certPem: string, lanIp: string): boolean {
  try {
    const parsed = new X509Certificate(certPem)
    if (!parsed.checkIP(lanIp)) return false
    // A cert past notAfter would be reused forever otherwise -- the phone
    // rejects it outright, with no regen path to recover.
    return new Date(parsed.validTo).getTime() > Date.now()
  } catch {
    return false
  }
}

export function loadOrCreateCert(lanIp: string): { key: string; cert: string } {
  if (existsSync(CERT_KEY_PATH) && existsSync(CERT_CERT_PATH)) {
    try {
      const cert = readFileSync(CERT_CERT_PATH, 'utf8')
      const key = readFileSync(CERT_KEY_PATH, 'utf8')
      if (certCoversLanIp(cert, lanIp)) return { key, cert }
      devLog.log('[phone-remote] cached cert SAN no longer matches LAN IP, regenerating')
    } catch (err) {
      devLog.warn('Phone Remote: failed to read cached cert, regenerating', err)
    }
  }

  const altNames: Array<{ type: number; value?: string; ip?: string }> = [
    { type: 2, value: CONFIG.PHONE_REMOTE.MDNS_HOSTNAME },
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: lanIp }
  ]
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: CONFIG.PHONE_REMOTE.MDNS_HOSTNAME }],
    {
      days: CERT_VALID_DAYS,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        {
          name: 'keyUsage',
          keyCertSign: true,
          digitalSignature: true,
          nonRepudiation: true,
          keyEncipherment: true,
          dataEncipherment: true
        },
        { name: 'subjectAltName', altNames }
      ]
    }
  )

  if (!existsSync(PATHS.ROOT)) mkdirSync(PATHS.ROOT, { recursive: true })
  writeFileSync(CERT_KEY_PATH, pems.private, { mode: 0o600 })
  writeFileSync(CERT_CERT_PATH, pems.cert, { mode: 0o600 })

  return { key: pems.private, cert: pems.cert }
}
