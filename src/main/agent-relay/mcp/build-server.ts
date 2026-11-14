/** Separate from the HTTP listener so a test can drive the server over an
 *  in-memory transport without a real socket. */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CONFIG } from '../../../shared/config'
import { VERB_HANDLERS, SESSION_HANDLERS, TOOLING_HANDLERS, PHOTO_VERBS, askWithoutDecisions, askArgsWithoutDecisions } from './verbs'
import { BROWSER_HANDLERS } from './browser-tools'
import { DELEGATE_HANDLERS } from './delegate-tools'
import { PUBLISH_HANDLERS } from '../../publish'
import { PREFS } from '../../store/prefs'
import { setAgentSessionProgress } from './http-listener'
import type { AgentOrigin } from './http-listener'

/** `derivedFrom` (repo/branch, from the npx shim) is a per-REQUEST fact, never a
 *  module global -- two agents calling at once must not see each other's label. */
export function buildAgentRelayMcpServer(
  derivedFrom?: string,
  onStatedFrom?: (stated: string) => void,
  cwd?: string,
  origin?: AgentOrigin,
  sessionId?: string
): McpServer {
  const server = new McpServer({ name: 'mightymouse-code', version: CONFIG.APP_VERSION })
  const plainAsk = PREFS.getDecisionCardsEnabled() ? null : askWithoutDecisions()

  for (const [verb, handler] of Object.entries({
    ...VERB_HANDLERS,
    ...SESSION_HANDLERS,
    ...TOOLING_HANDLERS,
    ...BROWSER_HANDLERS,
    ...DELEGATE_HANDLERS,
    ...PUBLISH_HANDLERS
  })) {
    if (!handler) continue
    // Read per BUILD, not once per process: a server is built per connection,
    // so flipping the toggle reaches the next agent without a restart. Absent
    // rather than erroring is the point -- an agent must not see a tool it is
    // not allowed to call, or it will promise the user a photo it cannot get
    if (PHOTO_VERBS.has(verb) && !PREFS.getAgentRelayPhotosEnabled()) continue
    // Only the four design verbs declare `from`; the local-tooling tools
    // (relay_pending/relay_resolve) would have it silently stripped by their
    // own schema, so they are never handed one.
    const carriesFrom = verb in VERB_HANDLERS
    // `recap` names no card, so it has no `from` to state -- it addresses the
    // session by the id the shim already sends, which is the only key that
    // cannot mean a neighbouring pane in the same checkout. The card verbs need
    // it too now that `progress` writes to the session: a number keyed on `from`
    // is keyed on a label two panes in one checkout can share.
    const carriesSessionId = verb in SESSION_HANDLERS || verb in BROWSER_HANDLERS || verb in DELEGATE_HANDLERS || carriesFrom
    server.registerTool(
      verb,
      (verb === 'ask' && plainAsk ? plainAsk : handler) as { description: string; inputSchema: typeof handler.inputSchema },
      // A stated `from` always wins: the agent knows its own name better than
      // we can guess it from a working directory.
      async (raw) => {
        const args = verb === 'ask' && plainAsk ? askArgsWithoutDecisions(raw) : raw
        if (typeof args === 'string') return { content: [{ type: 'text' as const, text: args }], isError: true }
        // The session list is stuck with the derived repo/branch until an agent
        // states its own name -- so the first verb call is what names it.
        if (carriesFrom && typeof args.from === 'string') onStatedFrom?.(args.from)
        // Every verb that declares `progress`, in ONE place. Doing it inside a
        // handler means each new verb has to remember to, and three of them
        // already did not -- the number reached the card and never the session,
        // so the ring stayed dark while the card showed a percentage.
        if (carriesSessionId && typeof args.progress === 'number') {
          setAgentSessionProgress(sessionId, args.progress)
        }
        // `cwd`/`origin` ride along for the audit log + "go to session" only --
        // neither is a tool input, so both are attached here rather than
        // declared in any verb's schema.
        // Both, not either: a card verb states a `from` AND addresses a session,
        // and the old exclusive branch meant taking the id cost it the label.
        return handler.run({
          ...args,
          ...(carriesSessionId ? { sessionId } : {}),
          ...(carriesFrom ? { from: args.from ?? derivedFrom, cwd, origin } : {}),
          ...(verb in DELEGATE_HANDLERS ? { cwd, origin } : {})
        })
      }
    )
  }

  return server
}
