import { ipcRenderer, webFrame } from 'electron'
import type { PasskeyResult } from '../shared/types'

// Sandboxed preloads can't require a shared chunk, so the channel arrives via argv (side-browser.ts).
const CHANNEL_ARG = '--mm-passkey-channel='
const channel = process.argv.find((a) => a.startsWith(CHANNEL_ARG))?.slice(CHANNEL_ARG.length)

const MAIN_WORLD_SHIM = `(() => {
  if (window.__mmPasskeyInstalled || !navigator.credentials) return
  window.__mmPasskeyInstalled = true
  const nav = navigator.credentials
  const originalCreate = nav.create.bind(nav)
  const originalGet = nav.get.bind(nav)
  let seq = 0

  function buf(b64url) {
    if (typeof b64url !== 'string') return undefined
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out.buffer
  }

  function toCredential(json) {
    const r = json.response || {}
    const isCreate = typeof r.attestationObject === 'string'
    const response = Object.create(
      isCreate ? AuthenticatorAttestationResponse.prototype : AuthenticatorAssertionResponse.prototype
    )
    Object.defineProperty(response, 'clientDataJSON', { value: buf(r.clientDataJSON), enumerable: true })
    if (isCreate) {
      Object.defineProperty(response, 'attestationObject', { value: buf(r.attestationObject), enumerable: true })
      Object.defineProperty(response, 'getTransports', { value: () => ['internal', 'hybrid'] })
    } else {
      Object.defineProperty(response, 'authenticatorData', { value: buf(r.authenticatorData), enumerable: true })
      Object.defineProperty(response, 'signature', { value: buf(r.signature), enumerable: true })
      Object.defineProperty(response, 'userHandle', { value: r.userHandle ? buf(r.userHandle) : null, enumerable: true })
    }
    const cred = Object.create(PublicKeyCredential.prototype)
    Object.defineProperties(cred, {
      id: { value: json.id, enumerable: true },
      rawId: { value: buf(json.rawId), enumerable: true },
      type: { value: 'public-key', enumerable: true },
      authenticatorAttachment: { value: 'platform', enumerable: true },
      response: { value: response, enumerable: true },
      getClientExtensionResults: { value: () => ({}) },
      toJSON: { value: () => ({ ...json, authenticatorAttachment: 'platform', clientExtensionResults: {} }) }
    })
    return cred
  }

  function bridge(kind, options) {
    return new Promise((resolve, reject) => {
      const id = 'mm-passkey-' + (++seq) + '-' + Date.now()
      function onMessage(event) {
        if (event.source !== window || !event.data || event.data.__mmPasskeyResult !== true) return
        if (event.data.id !== id) return
        window.removeEventListener('message', onMessage)
        if (event.data.ok) resolve(toCredential(event.data.credential))
        else reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'))
      }
      window.addEventListener('message', onMessage)
      window.postMessage({ __mmPasskeyRequest: true, id, kind, publicKey: options.publicKey }, '*')
    })
  }

  nav.create = function (options) {
    if (!options || !options.publicKey) return originalCreate(options)
    return bridge('create', options)
  }
  nav.get = function (options) {
    if (!options || !options.publicKey) return originalGet(options)
    return bridge('get', options)
  }
})()`

if (channel) window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.__mmPasskeyRequest !== true) return
  const { id, kind, publicKey } = event.data
  ipcRenderer
    .invoke(channel, { kind, publicKey })
    .then((result: PasskeyResult) => {
      window.postMessage(
        {
          __mmPasskeyResult: true,
          id,
          ok: result.ok,
          credential: result.credential,
          errorCode: result.errorCode
        },
        '*'
      )
    })
    .catch(() => {
      window.postMessage({ __mmPasskeyResult: true, id, ok: false, errorCode: 'internal' }, '*')
    })
})

if (channel) webFrame.executeJavaScript(MAIN_WORLD_SHIM)

const LOCATION_ARG = '--mm-location-channel='
const locationChannel = process.argv.find((a) => a.startsWith(LOCATION_ARG))?.slice(LOCATION_ARG.length)

// Electron never asks macOS for location, so its own lookup always times out.
const LOCATION_SHIM = `(() => {
  if (window.__mmLocationInstalled || !navigator.geolocation) return
  window.__mmLocationInstalled = true
  const geo = navigator.geolocation
  let seq = 0
  let watchSeq = 0
  const watches = new Set()
  function locate(ok, fail) {
    const id = 'mm-location-' + (++seq)
    function onMessage(event) {
      if (event.source !== window || !event.data || event.data.__mmLocationResult !== id) return
      window.removeEventListener('message', onMessage)
      const fix = event.data.fix || { error: 'unavailable' }
      if (fix.error) {
        const code = fix.error === 'denied' ? 1 : fix.error === 'timeout' ? 3 : 2
        if (fail) fail({ code, message: code === 1 ? 'User denied Geolocation' : 'Position unavailable', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 })
        return
      }
      const coords = { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null }
      coords.toJSON = () => ({ ...coords })
      const position = { coords, timestamp: Date.now() }
      position.toJSON = () => ({ coords: coords.toJSON(), timestamp: position.timestamp })
      ok(position)
    }
    window.addEventListener('message', onMessage)
    window.postMessage({ __mmLocationRequest: id }, '*')
  }
  geo.getCurrentPosition = (ok, fail) => locate(ok, fail)
  geo.watchPosition = (ok, fail) => {
    const w = ++watchSeq
    watches.add(w)
    locate((p) => watches.has(w) && ok(p), (e) => watches.has(w) && fail && fail(e))
    return w
  }
  geo.clearWatch = (w) => watches.delete(w)
})()`

if (locationChannel) {
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || typeof event.data.__mmLocationRequest !== 'string') return
    const id = event.data.__mmLocationRequest
    ipcRenderer
      .invoke(locationChannel)
      .catch(() => ({ error: 'unavailable' }))
      .then((fix) => window.postMessage({ __mmLocationResult: id, fix }, '*'))
  })
  webFrame.executeJavaScript(LOCATION_SHIM)
}

const MOD_WORLD_ARG = '--mm-mod-world='
const modWorld = Number(process.argv.find((a) => a.startsWith(MOD_WORLD_ARG))?.slice(MOD_WORLD_ARG.length))
// Electron ignores csp unless securityOrigin is set too.
if (modWorld && location.origin !== 'null')
  webFrame.setIsolatedWorldInfo(modWorld, {
    name: 'MightyMouse mods',
    securityOrigin: location.origin,
    csp: "default-src 'none'; form-action 'none'; base-uri 'none'"
  })
