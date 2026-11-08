// screen-context.ts — what the user was looking at when they started talking.
//
// Dictation drops the subject. "I'd like to update this UI" names nothing a
// recipient can act on, because the thing being pointed at was on screen, not
// in the sentence. This turns that pointing into text: the frontmost app, and
// for a browser the page title and URL of the tab actually in front.
//
// Used for two different jobs, which is why the two shapes below are separate:
//   forRanking  — one line into Jev's state, so "this UI" ranks against the
//                 agent working on that repo rather than the last one touched.
//   forDelivery — a header prepended to what a skill or agent receives, so the
//                 CLI on the other end can open the URL itself.
//
// Must not call readAppContext(): that spawnSyncs System Events + every Chrome
// tab + PNG icons and freezes the skeleton card (measured ~2.3s). This path is
// an NSWorkspace cache read plus one async front-tab osascript.
import { context as platformContext } from '../platform'

export interface ScreenContext {
  appName: string
  /** Title of the front tab/window, '' when the app has no adapter. */
  title: string
  /** URL of the front tab, '' for anything that is not a browser. The Chrome
   *  and Safari adapters put it in the item's `subtitle` (chrome.ts:124). */
  url: string
}

/** Longest URL that still reads as a locator rather than a payload. A data: or
 *  a tracking-stuffed link past this adds tokens without adding a subject. */
const MAX_URL_LENGTH = 300

/** Same reasoning for a tab title, which for some apps is a whole sentence. */
const MAX_TITLE_LENGTH = 200

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function fromReading(raw: {
  appName: string
  title: string
  url: string
}): ScreenContext | null {
  if (!raw.appName) return null
  return {
    appName: raw.appName,
    title: clamp(raw.title, MAX_TITLE_LENGTH),
    url: /^(https?|file):\/\//.test(raw.url) ? clamp(raw.url, MAX_URL_LENGTH) : ''
  }
}

/** Read the frontmost app and its active tab. Never throws: no context is a
 *  normal answer, and routing must degrade to exactly what it did before. */
export async function readScreenContext(): Promise<ScreenContext | null> {
  try {
    const raw = await platformContext.readFrontmostScreen()
    return raw ? fromReading(raw) : null
  } catch {
    return null
  }
}

/** One line for Jev's state. Not a question — free-form context it weighs when
 *  ranking, which is what makes "update this UI" land on the agent working in
 *  the repo that page belongs to. */
export function forRanking(ctx: ScreenContext | null): string {
  if (!ctx) return ''
  const parts = [ctx.appName]
  if (ctx.title) parts.push(ctx.title)
  if (ctx.url) parts.push(ctx.url)
  return parts.join(' — ')
}

/** Header above the transcript so a CLI can fetch the URL. '' when there's nothing to say. */
export function forDelivery(ctx: ScreenContext | null): string {
  if (!ctx) return ''
  if (!ctx.title && !ctx.url) return ''
  const lines = [`[on screen: ${ctx.appName}${ctx.title ? ` — ${ctx.title}` : ''}]`]
  if (ctx.url) lines.push(ctx.url)
  return `${lines.join('\n')}\n\n`
}
