import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Standalone Vite build for the phone-remote page — deliberately NOT part of
// electron.vite.config.ts. This bundle runs in a plain phone Safari tab (no
// Electron, no preload, no IPC bridge), so it must never import anything from
// src/main or src/preload. It only shares src/shared (CONFIG.THEME_TOKENS,
// CONFIG.PHONE_REMOTE constants) with the rest of the app.
//
// Tailwind only inside `.phonePulse`, via ai/phone-pulse.css's own @config.
//
// Output: dist/ (gitignored), copied by server.ts's resolvePublicDir() in dev
// (npm run build:phone-remote) and by electron-builder's extraResources in
// packaged builds (see electron-builder.yml).
// Stamped into the bundle at build time and logged on connect. The bundle is
// pre-built and cached by mobile Safari, so "did my edit reach the device" is
// unanswerable from the Mac side -- a source file newer than dist/ and a phone
// holding last week's JS look identical in every other trace.
const BUILD_ID = new Date().toISOString().replace('T', ' ').slice(0, 19)

export default defineConfig({
  root: __dirname,
  base: './',
  define: {
    __PHONE_REMOTE_BUILD__: JSON.stringify(BUILD_ID),
    // ON by default, OFF only for a release. A bare `npm run build:phone-remote`
    // is always someone iterating on this directory, and they want the numbers;
    // opt-IN meant every such build silently dropped the overlay and the next
    // measuring run started by wondering where it went.
    //
    // The release path opts OUT explicitly -- `npm run build` chains
    // build:phone-remote:release (MM_MIRROR_STATS=0), and every packaged target
    // (build:mac, release:mac, CI) funnels through `build`, so a shipped bundle
    // cannot pick this up by omission.
    //
    // IS_DEV cannot answer this: dev and packaged BOTH serve a `vite build`
    // output to a phone Safari tab that has no `process`, so IS_DEV is false in
    // the bundle either way.
    __MIRROR_STATS_OVERLAY__: JSON.stringify(process.env.MM_MIRROR_STATS !== '0')
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../../../shared')
    }
  },
  plugins: [react()]
})
