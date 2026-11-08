import { ipcMain, app, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import { CHANNELS } from '../shared/ipc'
import type { PasskeyRequest, PasskeyResult, PasskeyErrorCode } from '../shared/types'

interface PasskeyAddon {
  authorizationState(): string
  request(windowHandle: Buffer, json: string): Promise<string>
}

interface WebAuthnPublicKeyLike {
  rpId?: string
  challenge?: unknown
  user?: { id?: unknown; name?: string; displayName?: string }
  pubKeyCredParams?: Array<{ alg?: number }>
  allowCredentials?: Array<{ id?: unknown }>
  userVerification?: string
  authenticatorSelection?: { userVerification?: string }
}

let addon: PasskeyAddon | null | undefined

// native/ ships whole via electron-builder's mac extraResources — see native/build-all.sh.
function loadAddon(): PasskeyAddon | null {
  if (addon !== undefined) return addon
  if (process.platform !== 'darwin') return (addon = null)
  const addonPath = app.isPackaged
    ? join(process.resourcesPath, 'native/passkeys/build/Release/passkeys.node')
    : join(app.getAppPath(), 'native/passkeys/build/Release/passkeys.node')
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    addon = require(addonPath) as PasskeyAddon
  } catch {
    addon = null
  }
  return addon
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).hostname
  } catch {
    return null
  }
}

function rpIdAllowed(rpId: string, origin: string): boolean {
  const host = originHost(origin)
  if (!host || !rpId) return false
  if (!origin.startsWith('https://') && host !== 'localhost') return false
  return host === rpId || host.endsWith(`.${rpId}`)
}

function toBase64Url(value: unknown): string | undefined {
  if (value == null) return undefined
  if (Buffer.isBuffer(value)) return value.toString('base64url')
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('base64url')
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64url')
  }
  return undefined
}

function fail(errorCode: PasskeyErrorCode, errorMessage?: string): PasskeyResult {
  return { ok: false, errorCode, errorMessage }
}

export function registerSideBrowserPasskeyHandlers(): void {
  ipcMain.handle(
    CHANNELS.sideBrowserPasskey,
    async (event: IpcMainInvokeEvent, req: PasskeyRequest): Promise<PasskeyResult> => {
      const frame = event.senderFrame
      if (!frame || frame.parent !== null) return fail('not-top-frame')

      const origin = frame.origin
      const publicKey = req?.publicKey as WebAuthnPublicKeyLike | undefined
      const rpId = publicKey?.rpId ?? originHost(origin) ?? ''
      if (!rpIdAllowed(rpId, origin)) return fail('invalid-rp-id')

      const passkeys = loadAddon()
      if (!passkeys) return fail('not-entitled')

      const state = passkeys.authorizationState()
      if (state === 'unsupported-os') return fail('unsupported-os')

      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return fail('internal')

      const payload = {
        kind: req.kind,
        rpId,
        origin,
        topOrigin: origin,
        crossOrigin: false,
        challenge: toBase64Url(publicKey?.challenge),
        userId: toBase64Url(publicKey?.user?.id),
        userName: publicKey?.user?.name,
        userDisplayName: publicKey?.user?.displayName,
        pubKeyCredParams: publicKey?.pubKeyCredParams,
        allowCredentials: (publicKey?.allowCredentials ?? []).map((c) => ({
          id: toBase64Url(c.id)
        })),
        userVerification: publicKey?.authenticatorSelection?.userVerification ?? publicKey?.userVerification
      }

      try {
        const json = await passkeys.request(win.getNativeWindowHandle(), JSON.stringify(payload))
        return { ok: true, credential: JSON.parse(json) }
      } catch (errorCode) {
        const code = typeof errorCode === 'string' ? (errorCode as PasskeyErrorCode) : 'internal'
        return fail(code)
      }
    }
  )
}
