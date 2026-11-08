import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Mirrors the phone-remote and web builds' alias. Without it, any module
  // importing shared types is untestable here — which is most of them, so tests
  // were being written against whichever neighbouring file happened not to
  // import @shared rather than against the module that owns the logic.
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      // Unaliased, a test reaching this transitively fails at COLLECTION: 0
      // tests, which reads as a broken suite rather than a missing dep.
      'npm:@supabase/supabase-js@2': '@supabase/supabase-js',
      // Type-only under test; see the stub's header.
      'npm:stripe@14': resolve(__dirname, 'scripts/vitest-stripe-stub.mjs'),
      // Reads named exports off the electron CJS binary, which resolves only
      // inside Electron; see the stub's header.
      '@electron-toolkit/utils': resolve(__dirname, 'scripts/vitest-electron-toolkit-stub.mjs')
    }
  },
  // The .tsx test glob below predates any .tsx test, so nothing ever forced a
  // JSX transform to be configured — the first one failed with "React is not
  // defined". Matches tsconfig.web.json's "jsx": "react-jsx".
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    // Fails fast on Node <22, where better-sqlite3 13 segfaults instead of erroring.
    globalSetup: './scripts/vitest-native-setup.mjs',
    setupFiles: ['./scripts/vitest-deno-env-setup.mjs'],
    // The only runner portal/, web/ and supabase/ get: a test file outside
    // these globs silently never runs. Split on ONE axis -- binds a real
    // socket or not; the five below starve each other and must run serially.
    projects: [
      {
        extends: true,
        test: {
          name: 'live-server',
          include: [
            'src/main/phone-remote/__tests__/connect-lifecycle-live.test.ts',
            'src/main/phone-remote/__tests__/observer-live.test.ts',
            'src/main/phone-remote/__tests__/pair-cors-live.test.ts',
            'src/main/phone-remote/__tests__/connect-log-live.test.ts',
            'src/main/phone-remote/__tests__/ws-auth-gate.test.ts',
            'src/main/phone-remote/__tests__/queued-clip-flush.test.ts',
            'src/main/phone-remote/__tests__/viewer-zoom-live.test.ts',
            'src/main/phone-remote/__tests__/glasses-first-order.test.ts',
            'src/main/agent-relay/mcp/__tests__/chat-browser-door-live.test.ts'
          ],
          fileParallelism: false
        }
      },
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'src/**/*.test.{ts,tsx}',
            'supabase/functions/**/*.test.{ts,tsx}',
            'portal/src/**/*.test.{ts,tsx}',
            'portal/functions/**/*.test.{ts,tsx}',
            'web/functions/**/*.test.{ts,tsx}',
            'web/test/*.test.{ts,tsx}',
            '.claude/skills/*/test/*.test.{ts,tsx}'
          ],
          exclude: [
            '**/node_modules/**',
            'src/main/phone-remote/__tests__/connect-lifecycle-live.test.ts',
            'src/main/phone-remote/__tests__/observer-live.test.ts',
            'src/main/phone-remote/__tests__/pair-cors-live.test.ts',
            'src/main/phone-remote/__tests__/connect-log-live.test.ts',
            'src/main/phone-remote/__tests__/ws-auth-gate.test.ts',
            'src/main/phone-remote/__tests__/queued-clip-flush.test.ts',
            'src/main/phone-remote/__tests__/viewer-zoom-live.test.ts',
            'src/main/phone-remote/__tests__/glasses-first-order.test.ts',
            'src/main/agent-relay/mcp/__tests__/chat-browser-door-live.test.ts'
          ]
        }
      }
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Coverage is scoped to the modules we've decided are unit-testable WITHOUT a
      // live Electron/process harness — pure logic with a dedicated test file. The
      // rest of src/main (window wiring, the entrypoint, capture device I/O, IPC) and
      // every renderer .tsx need a DOM/Electron runtime we don't drive in unit tests;
      // counting them would dilute the number into noise and make the threshold a lie.
      // ADD a file here only when it gets a real test — keep the % honest.
      include: [
        'src/main/backend/adapters.ts',
        'src/main/backend/parse.ts',
        'src/main/backend/context-memory.ts',
        'src/main/capture/redact.ts',
        'src/main/backend/binary-resolver.ts',
        'src/main/store/prefs.ts',
        'src/main/platform/macos/permission-tests.ts',
        'src/shared/mode.ts',
        'src/shared/billing-math.ts'
      ],
      // Ratchet floor: set just under today's real numbers on the scoped set (~67%
      // across the board), so the gate blocks regressions but doesn't flap. adapters.ts
      // (~33%, its http-transport billing adapter needs a live network harness) and
      // prefs.ts (~48%, half is more getter/setter pairs) pull the average down. Raise
      // this floor as coverage climbs / those gaps get tests.
      thresholds: {
        statements: 65,
        branches: 65,
        functions: 65,
        lines: 65
      }
    }
  }
})
