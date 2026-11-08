import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

if (!process.env.SENTRY_DSN) console.warn('[build] SENTRY_DSN unset - desktop errors will not reach Sentry')

export default defineConfig({
  main: {
    define: { 'process.env.SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN ?? '') }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          'side-browser-tab': resolve('src/preload/side-browser-tab.ts')
        }
      }
    }
  },
  renderer: {
    // MightyMouse owns a unique port lane so concurrent Electron projects (e.g.
    // tg-openstudio) never fight over Vite's default :5173 — a silent slide to
    // :5174 left the main process pointing at the wrong URL → blank/grey panel.
    // strictPort makes a collision FAIL LOUDLY instead of sliding. Override with
    // MM_RENDERER_PORT if 5273 is ever taken. DevTools lane is :9322 (index.ts).
    server: {
      port: Number(process.env.MM_RENDERER_PORT) || 5273,
      strictPort: true,
      // Vite's default error overlay paints INSIDE the window that loaded the
      // broken module — and nearly every surface here is alwaysOnTop
      // 'screen-saver', a macOS level above Mission Control and the Dock. That
      // makes a routine bad-import error an unescapable full-screen wall that
      // reads as a bricked machine. We render our own dismissible corner toast
      // instead, and un-pin the window first. See renderer/src/devErrorOverlay.ts.
      hmr: { overlay: false }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    // Both @ricky0123/vad-web AND onnxruntime-web ship CommonJS with plain
    // `require()` calls (onnxruntime-web's ort.wasm.min.js even has a
    // `typeof require<"u" ? require : ...` shim baked in by its own bundler).
    // Served unbundled, that require() throws "Dynamic require... not
    // supported" — there's no CJS runtime in the browser. Pre-bundling both
    // via esbuild is what resolves and inlines those requires into real ESM,
    // so BOTH packages must be pre-bundled, not excluded.
    //
    // ORT's actual wasm backend (.wasm + .mjs glue) is NOT copied into public/
    // anymore — ORT loads the .mjs via a dynamic import(), and Vite refuses to
    // module-serve a public/ file (appends ?import → 500). Instead
    // useVoiceActivity.ts imports both files from node_modules with `?url` and
    // hands them to ORT via ort.env.wasm.wasmPaths. `?url` is Vite-native:
    // served as a real module in dev, emitted as a hashed asset on build. So no
    // assetsInclude carve-out is needed — the only public/vad/ file left is the
    // Silero .onnx model, which loads via a plain fetch (baseAssetPath).
    optimizeDeps: {
      include: ['onnxruntime-web/wasm', '@ricky0123/vad-web']
    },
    plugins: [react()]
  }
})
