import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server for the *-harness.local.html pages — deliberately separate from
// vite.config.ts, which is a single-entry BUILD config whose output is the
// bundle the phone actually loads. Adding a second entry there would ship the
// harness inside the real app; adding a dev server there would put a harness
// page on the port the server.ts bundle is built for.
//
// Serve-only, so extra harness pages cost nothing shipped: reach them by path
// (/relay-harness.local.html, /deck-harness.local.html).
//
// `/` is rewritten to the harness INDEX, not Vite's default index.html -- that
// file is the real phone app, so a bare :5274 served a working-looking remote
// and every wrong-URL visit read as "the harness is broken".
export default defineConfig({
  root: __dirname,
  define: {
    __PHONE_REMOTE_BUILD__: JSON.stringify('harness'),
    __MIRROR_STATS_OVERLAY__: JSON.stringify(false)
  },
  server: {
    port: 5274,
    strictPort: true,
    open: false
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../../../shared')
    }
  },
  plugins: [
    {
      // Must run BEFORE Vite's own html middleware, which would otherwise
      // resolve `/` to index.html (the real phone app).
      name: 'harness-index',
      enforce: 'pre',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const path = (req.url ?? '/').split('?')[0]
          const pageRequest = req.headers.accept?.includes('text/html') && !path.endsWith('.local.html')
          if (pageRequest) {
            req.url = '/harness-index.local.html'
          }
          next()
        })
      }
    },
    react()
  ]
})
