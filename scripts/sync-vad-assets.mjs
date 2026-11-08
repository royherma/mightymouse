// Copy the VAD runtime's assets out of node_modules so both surfaces that run
// a Silero VAD can serve them locally. Runs on postinstall so the copies always
// match the versions actually resolved in node_modules — onnxruntime-web is
// pinned to 1.27.0 via package.json `overrides` to match what
// @ricky0123/vad-web loads at runtime. Keeping this in sync by hand is exactly
// the drift that produced the "no available backend found" bug.
//
// Two destinations, because the phone-remote React app is a SEPARATE Vite build
// (its own root, its own public/) served to phone Safari by server.ts — it
// cannot reach the Electron renderer's assets at all.
//
//   src/renderer/src/vad-assets/            ORT wasm+mjs, `?url`-imported (see
//                                           useVoiceActivity.ts for why public/
//                                           and bare package imports both fail)
//   src/renderer/public/vad/                model + worklet, plain fetches
//   phone-remote/react/public/vad/          all four, plain fetches — the phone
//                                           bundle sets base:'./' so relative
//                                           asset paths resolve under public/
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ortSrc = resolve(root, 'node_modules/onnxruntime-web/dist')
const vadSrc = resolve(root, 'node_modules/@ricky0123/vad-web/dist')

// The single-threaded SIMD build ORT picks with numThreads=1, non-jsep.
const ortFiles = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']
// The legacy model is the one MicVAD's default `model: 'legacy'` fetches.
const vadFiles = ['silero_vad_legacy.onnx', 'vad.worklet.bundle.min.js']

if (!existsSync(ortSrc) || !existsSync(vadSrc)) {
  // Deps not installed yet (e.g. fresh clone mid-install) — skip silently;
  // postinstall runs again once they land.
  process.exit(0)
}

/** Copy `files` from `from` into `to`, creating `to` if needed. */
function sync(from, files, to) {
  mkdirSync(to, { recursive: true })
  for (const f of files) copyFileSync(resolve(from, f), resolve(to, f))
}

sync(ortSrc, ortFiles, resolve(root, 'src/renderer/src/vad-assets'))
sync(vadSrc, vadFiles, resolve(root, 'src/renderer/public/vad'))

// Split like the renderer: ORT's glue is a dynamic module import no base path
// can satisfy, so it is `?url`-imported from src/. Only the plain-fetch
// assets (model + worklet) can live in public/.
const phoneVad = resolve(root, 'src/main/phone-remote/react/public/vad')
sync(vadSrc, vadFiles, phoneVad)
sync(ortSrc, ortFiles, resolve(root, 'src/main/phone-remote/react/vad-assets'))

console.log('[sync-vad-assets] synced ORT + Silero assets → renderer + phone-remote')
