import { execFile } from 'child_process'
import { readFileSync } from 'fs'
import { resolveBinary } from '../platform/macos/resolve-binary'
import { probeEnv } from '../platform/macos/shell'
import { KeyProbeResult, KeyStatus, expiryStatus } from '../../shared/keys'
import { keyProvider } from '../../shared/key-providers'
import { KEYS } from './store'
import { parseEnvFile } from './scan-pure'

const PROBE_TIMEOUT_MS = 8000

function runProbe(bin: string, args: string[], extraEnv?: Record<string, string>): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: PROBE_TIMEOUT_MS, env: probeEnv(extraEnv) },
      (err, stdout, stderr) => {
        const lines = (err ? `${stderr}\n${stdout}` : stdout || stderr).split('\n').map((l) => l.trim())
        const detail = ((err && lines.find((l) => /^error\b/i.test(l))) || lines.find(Boolean) || '').slice(0, 120)
        resolve({ ok: !err, detail })
      }
    )
  })
}

function envFileValue(path: string | undefined, name: string): string | null {
  if (!path) return null
  try {
    return parseEnvFile(readFileSync(path, 'utf-8')).find((l) => l.name === name)?.value || null
  } catch {
    return null
  }
}

async function apiProbe(api: { url: string; alsoValid?: string }, value: string): Promise<{ ok: boolean; detail: string } | null> {
  try {
    const res = await fetch(api.url, { headers: { Authorization: `Bearer ${value}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    const body = await res.text()
    const ok = res.ok || (!!api.alsoValid && body.includes(api.alsoValid))
    const message = (body.match(/"message"\s*:\s*"([^"]{1,100})"/) ?? [])[1]
    return { ok, detail: ok ? `${new URL(api.url).host} accepted the key.` : message ?? `HTTP ${res.status}` }
  } catch {
    return null
  }
}

export async function probeKey(id: string): Promise<KeyProbeResult> {
  const checkedAt = new Date().toISOString()
  const record = KEYS.get(id)
  if (!record) return { id, status: 'missing', detail: 'No record found.', checkedAt }

  const provider = keyProvider(record.provider)

  if (record.source === 'cli-login' && provider?.cli) {
    const bin = resolveBinary(provider.cli.bin)
    if (!bin) {
      const detail = `${provider.cli.bin} not found on PATH.`
      KEYS.applyProbeResult(id, 'broken', detail, checkedAt)
      return { id, status: 'broken', detail, checkedAt }
    }
    const { ok, detail } = await runProbe(bin, provider.cli.probe)
    const status: KeyStatus = ok ? 'ready' : 'broken'
    KEYS.applyProbeResult(id, status, detail, checkedAt)
    return { id, status, detail, checkedAt }
  }

  const value = (await KEYS.getValue(record.name)) ?? envFileValue(record.sourcePath, record.name)
  const isToken = provider?.envNames[0] === record.name
  const checked =
    value && isToken && provider?.api
      ? await apiProbe(provider.api, value)
      : value && isToken && provider?.cli && resolveBinary(provider.cli.bin)
        ? await runProbe(resolveBinary(provider.cli.bin)!, provider.cli.probe, { [record.name]: value })
        : null
  if (checked) {
    const status: KeyStatus = checked.ok ? 'ready' : 'broken'
    KEYS.applyProbeResult(id, status, checked.detail, checkedAt)
    return { id, status, detail: checked.detail, checkedAt }
  }

  const expiry = expiryStatus(record.expiresAt)
  if (!value) {
    const detail = record.sourcePath ? `Not found in keychain or ${record.sourcePath}.` : 'Not found in keychain.'
    KEYS.applyProbeResult(id, 'missing', detail, checkedAt)
    return { id, status: 'missing', detail, checkedAt }
  }
  if (expiry) {
    const detail = `Expires ${record.expiresAt}.`
    KEYS.applyProbeResult(id, expiry, detail, checkedAt)
    return { id, status: expiry, detail, checkedAt }
  }
  const detail = 'Present, not checked against the service.'
  KEYS.applyProbeResult(id, 'ready', detail, checkedAt)
  return { id, status: 'ready', detail, checkedAt }
}

export async function probeKeysFor(scope: string, providers: string[]): Promise<number> {
  const ids = KEYS.readMaps()
    .flatMap((m) => m.keys)
    .filter(
      (k) =>
        (k.scope === scope || k.scope === 'global') &&
        !k.hidden &&
        providers.includes(k.provider)
    )
    .map((k) => k.id)
  await Promise.all([...new Set(ids)].map(probeKey))
  return ids.length
}
