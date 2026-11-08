import { defineConfig } from 'vitest/config'

// Run with Electron as Node so tests never swap the running app's SQLite ABI.
export default defineConfig({
  test: {
    environment: 'node',
    pool: 'threads',
    fileParallelism: false,
    include: [
      'src/main/agent-relay/coordination/__tests__/*.test.ts',
      'src/main/agent-relay/mcp/__tests__/presence.test.ts',
      'src/main/agent-relay/mcp/__tests__/published-names.test.ts',
      'src/main/agent-relay/mcp/__tests__/session-starts.test.ts'
    ]
  }
})
