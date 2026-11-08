// sinks.ts — turn the apps that are open right now into ranking candidates.
//
// A "sink" is a destination a voice note can land in. They are the apps you
// already have running (from the AppSwitcherList binary), NOT a config file:
// the whole point is that you record a thought and it goes to the window you
// would have switched to by hand.
//
// Cost discipline: listSwitchableApps() is one spawn for the whole list, but
// the frontmost tab/URL is an async front-tab osascript (readScreenContext),
// not readAppContext() which also encodes PNG icons and every Chrome tab.
import { isOwnBundleId } from '../../shared/app-context'
import { context as platformContext } from '../platform'
import type { JevSink } from './jev-client'
import { readScreenContext, type ScreenContext } from './screen-context'

/** Apps that can never usefully receive dictated text. */
const EXCLUDED_BUNDLE_IDS = new Set([
  'com.apple.finder',
  'com.apple.systempreferences',
  'com.apple.ActivityMonitor'
])

/** Ranking quality per sink falls off well before this, and every extra sink is
 *  input tokens on the critical path. Twelve covers a heavy desktop. */
const MAX_SINKS = 12

/** A sink plus the bits only the Mac side needs: the delivery path needs the real
 *  app name to activate and paste into. */
export interface DesktopSink extends JevSink {
  appName: string
  bundleId: string
}

export interface SinkSnapshot {
  sinks: DesktopSink[]
  /** Sink id of the app that was frontmost when the recording ended. '' when it
   *  could not be read, which Jev treats as simply having no such hint. */
  frontmostSinkId: string
  /** The frontmost reading this already paid for, handed back so the caller
   *  can describe what was on screen without a second osascript. */
  screen: ScreenContext | null
}

/** Bundle ids are already unique per app and safe as ids: Jev echoes the id
 *  back verbatim and we look it up, never interpolate it into a script. */
function sinkIdFor(bundleId: string): string {
  return bundleId
}

/**
 * Snapshot every app that could receive this transcript. Empty list → skip ranking.
 */
export async function collectSinks(): Promise<SinkSnapshot> {
  const apps = platformContext
    .listSwitchableApps()
    .filter((a) => !EXCLUDED_BUNDLE_IDS.has(a.bundleId) && !isOwnBundleId(a.bundleId))
  if (apps.length === 0) return { sinks: [], frontmostSinkId: '', screen: null }

  const frontmostId = platformContext.userFacingFrontmostBundleId()
  const frontmostSinkId = frontmostId ? sinkIdFor(frontmostId) : ''
  const screen = await readScreenContext()
  const frontmostDetail = screen?.title ?? ''

  const sinks = apps.slice(0, MAX_SINKS).map<DesktopSink>((app) => {
    const id = sinkIdFor(app.bundleId)
    const isFrontmost = id === frontmostSinkId
    const detail = isFrontmost && frontmostDetail !== '' ? frontmostDetail : ''
    return {
      id,
      label: detail === '' ? app.name : `${app.name} — ${detail}`,
      description:
        detail === '' ? `The ${app.name} application` : `${app.name}, currently showing: ${detail}`,
      appName: app.name,
      bundleId: app.bundleId
    }
  })

  return { sinks, frontmostSinkId, screen }
}
