/**
 * The relay harness reproduces strings it cannot import: the iPhone column's
 * live in Swift, and the Mac HUD column re-types HudApp's JSX so it can render
 * a fixture the real component only reaches through IPC. Those copies are the
 * one part of the harness that can go stale silently -- a renamed button would
 * leave it confidently previewing something no surface shows, which is worse
 * than not having a harness at all.
 *
 * So the strings are asserted against the sources themselves. If this fails,
 * the source changed and relay-harness.local.tsx is what needs updating --
 * never the other way round.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../../../../..')
const CATEGORY_SWIFT = resolve(ROOT, 'ios/MightyMouse/RelayNotificationCategory.swift')
const NSE_SWIFT = resolve(ROOT, 'ios/MightyMouseNSE/NotificationService.swift')
const HUD_APP = resolve(ROOT, 'src/renderer/src/HudApp.tsx')
const HARNESS = resolve(__dirname, '../relay-harness.local.tsx')
const PUSH_FN = resolve(ROOT, 'supabase/functions/agent-relay-push/index.ts')
const HARNESS_CSS = resolve(__dirname, '../relay-harness.local.css')

const swiftCategories = readFileSync(CATEGORY_SWIFT, 'utf8')
const swiftNse = readFileSync(NSE_SWIFT, 'utf8')
const hudApp = readFileSync(HUD_APP, 'utf8')
const harness = readFileSync(HARNESS, 'utf8')
const pushFn = readFileSync(PUSH_FN, 'utf8')

describe('relay harness mirrors the iOS notification strings', () => {
  // "Don't" is checked as its apostrophe-free stem: the harness writes it as a
  // JSX entity (&apos;) in one place and a plain string in another, and the
  // point of the assertion is the word, not the escaping.
  it.each(['Answer', 'Approve', 'Don'])(
    'action title %s still exists in Swift and in the harness',
    (title) => {
      expect(swiftCategories).toContain(title)
      expect(harness).toContain(title)
    }
  )

  // Removed 2026-08-14: the tap deep-links already. Matched as a quoted title,
  // not raw text -- both files still explain the removal in a comment.
  it('no category offers an "Open the screen" action any more', () => {
    expect(swiftCategories).not.toContain('"Open the screen"')
    expect(harness).not.toContain("'Open the screen'")
  })

  // Title Case: the phone renders these as headlines (Roy, 2026-08-14). All
  // three copies -- NSE, harness, this list -- move together or the test is
  // asserting a string no surface shows.
  // The leading glyph is part of the string on purpose: ❓/🔑 mark the two verbs
  // that block on a reply, and a notify (💬/⛔/⏳, never ❓) cannot take one. It
  // is what separates them on a lock screen, so it moves with the words.
  it.each([
    // Matches GENERIC_TITLE.ask in agent-relay-push VERBATIM. It once read
    // "Needs You" here and "Needs an Answer" on the server, so which of the two
    // a card showed silently told you whether the NSE had run -- the diagnosis
    // that found the missing options, and a wording change no user should see.
    '❓ Your Agent Needs an Answer',
    '🔑 Your Agent Needs Your OK (Unlock Required)',
    '🔑 Your Agent Needs Your OK',
    '👀 Your Agent Sent You Something'
  ])('notification title %s matches the NSE', (title) => {
    expect(swiftNse).toContain(`"${title}"`)
    expect(harness).toContain(title)
  })

  // Weight is hierarchy, and the harness had asserted the opposite in a CSS
   // comment: title and subtitle are BOTH bold on a real card (Roy's photo of
  // one, 2026-08-20), with the body the only regular line. Read off the CSS
  // because that is where it was wrong.
  it('the iOS card sets title and subtitle bold, body regular', () => {
    const css = readFileSync(HARNESS_CSS, 'utf8')
    expect(css).toMatch(/\.hIosSubtitle\s*\{[^}]*font-weight:\s*650/)
    expect(css).toMatch(/\.hIosBody\s*\{[^}]*font-weight:\s*400/)
  })

  // Pinned nil because two non-nil values (a title, the app name) were tried
  // on 2026-08-20 and neither changed the card: iOS ignores this slot unless
  // recipients.count > 1, and `updating(from:)` always puts the sender in the
  // title and drops content.title/content.subtitle (WWDC21 10091). The pin
  // stops a fourth guess landing here; it does not buy a third row.
  // iOS draws a communication card as sender + body only, so the headline has
  // to travel inside the body to get a row of its own.
  it('the NSE folds the title into the body on the avatar path', () => {
    expect(swiftNse).toContain('threeRow.body = "\\(content.title)\\n\\(content.body)"')
    expect(swiftNse).toContain('threeRow.updating(from: intent)')
  })

  it('the NSE sends no speakable group name -- the card is 1:1, not a group', () => {
    expect(swiftNse).toContain('speakableGroupName: nil')
    expect(swiftNse).not.toMatch(/speakableGroupName: INSpeakableString/)
  })

  // The harness rebuilds each card's three lines itself, so it can mirror every
  // title verbatim and still lay them out wrong -- it showed `detail` in the
  // identity slot for a full release after the NSE stopped. Structure, not
  // wording, is what this asserts.
  //
  // The subtitle belongs to the Edge function alone now. iOS already draws
  // `from` in the header above the card, so a verb writing it again printed the
  // session name twice; the NSE stopped setting the field at all rather than
  // each verb dropping it separately and one growing it back.
  it('no verb writes the subtitle -- the cloud owns it', () => {
    expect(swiftNse).not.toContain('content.subtitle =')
    expect(harness).not.toContain('subtitle: params.detail')
    expect(pushFn).toContain('{ subtitle: sender }')
  })

  // The fourth copy, and the one the case above could not see: the cloud's
  // GENERIC_TITLE is what iOS shows when the NSE never runs. approve and show
  // drifted from the NSE for exactly as long as this file pinned only the two
  // local surfaces -- the same silent tell the ask comment above describes,
  // where the words a card used said whether the fetch had landed.
  // notify is absent on purpose: its title is the agent's own text, and the
  // cloud's generic is a fallback the NSE is meant to replace.
  it.each([
    ['ask', '❓ Your Agent Needs an Answer'],
    ['approve', '🔑 Your Agent Needs Your OK'],
    ['show', '👀 Your Agent Sent You Something']
  ])('the cloud fallback title for %s matches the NSE', (verb, title) => {
    expect(pushFn).toContain(`${verb}: '${title}'`)
    expect(swiftNse).toContain(`"${title}"`)
  })

  // Inverted 2026-08-14: these once asserted the opposite, on the wrong premise
  // that action titles are frozen at launch. Locked in because the failure is
  // silent -- options that stop rendering look like options never sent.
  it('the NSE reads options and builds a category from them', () => {
    expect(swiftNse).toContain('let options: [String]?')
    expect(swiftNse).toContain('RelayNotificationCategory.dynamicAsk')
    expect(swiftNse).toContain(`content.userInfo["options"]`)
  })

  // setNotificationCategories REPLACES the set, so registering the dynamic one
  // alone strips every other verb's actions -- one push late, reading as random.
  it('the NSE unions the dynamic category with the static set, never replaces it', () => {
    expect(swiftNse).toContain('RelayNotificationCategory.all')
    expect(swiftNse).toMatch(/union\(/)
  })

  it('ask registers only the free-text answer; options come per-request', () => {
    const askBlock = swiftCategories.slice(
      swiftCategories.indexOf('identifier: ask,'),
      swiftCategories.indexOf('identifier: approve,')
    )
    expect(askBlock).toContain('[answer]')
  })

  // Registered with zero actions, not dropped: an unregistered category
  // silently strips a card's buttons, and both ids still arrive on every push.
  it.each(['show', 'notify'])('%s is registered with no actions', (verb) => {
    // Sliced to the next line: `notify` is last, so an end marker of ']' would
    // match its own `actions: [` bracket and cut the text under test.
    const start = swiftCategories.indexOf(`identifier: ${verb},`)
    const block = swiftCategories.slice(start, swiftCategories.indexOf('\n', start + 1) + 40)
    expect(block).toContain('actions: []')
  })

  it('approve keeps exactly its two decision actions', () => {
    const approveBlock = swiftCategories.slice(
      swiftCategories.indexOf('identifier: approve,'),
      swiftCategories.indexOf('identifier: show,')
    )
    expect(approveBlock).toContain('[approveYes, approveNo]')
  })
})

/**
 * A THIRD copy of these identifiers now exists, in the cloud: the push sets
 * `aps.category` itself so the buttons render even when the NSE's fetch never
 * lands (Mac asleep, tunnel down, extension budget expired) -- that path used
 * to deliver a card with no category at all, which iOS renders with zero
 * buttons, so an `ask` arrived unanswerable.
 *
 * This is the exact drift RelayNotificationCategory.swift's header warns about,
 * one surface further out: a category iOS has never heard of renders as a plain
 * notification with no buttons and NO error anywhere -- on the phone, a typo
 * here is indistinguishable from the bug this fix removes. Nothing else can
 * catch it; Swift and Deno never see each other's types.
 */
describe('the cloud push names the same categories Swift registers', () => {
  const edgePush = readFileSync(
    resolve(ROOT, 'supabase/functions/agent-relay-push/index.ts'),
    'utf8'
  )

  it.each(['MM_RELAY_ASK', 'MM_RELAY_APPROVE', 'MM_RELAY_SHOW', 'MM_RELAY_NOTIFY'])(
    '%s is registered in Swift and sent by the Edge function',
    (identifier) => {
      expect(swiftCategories).toContain(`"${identifier}"`)
      expect(edgePush).toContain(`'${identifier}'`)
    }
  )

  // The whole point of the fix: set on the push itself, not left to the
  // extension. If this assertion is what broke, the category moved back behind
  // the tunnel fetch and every offline card lost its buttons again.
  it('sets the category on the aps payload, not only in the NSE', () => {
    expect(edgePush).toContain('category: CATEGORY[verb as RelayVerb]')
  })
})

describe('relay harness mirrors the Mac HUD', () => {
  it.each([
    'Approve',
    'Deny',
    'Got it',
    // The HUD's button jumps to the agent's own pane. iOS has no counterpart
    // any more -- its "Open the screen" action was removed 2026-08-14 because
    // tapping the notification already deep-links to that request.
    'Go to the agent',
    'Type an answer…',
    'Optional note…'
  ])('button/placeholder %s still exists in HudApp and in the harness', (label) => {
    expect(hudApp).toContain(label)
    expect(harness).toContain(label)
  })

  // The harness renders HudApp's own class names so it inherits index.css
  // verbatim. A renamed class would silently drop the real styling and leave
  // the column looking like unstyled text -- which reads as a harness bug.
  it.each([
    'hud-container',
    'hud-main',
    'hud-title',
    'hud-body',
    'hud-actions',
    'hud-action-btn',
    'hud-confirm-btn',
    'hud-cancel-btn',
    'hud-action-input'
  ])('class %s still exists in HudApp and in the harness', (cls) => {
    expect(hudApp).toContain(cls)
    expect(harness).toContain(cls)
  })

  // The two surfaces deliberately disagree on the deny label -- iOS says
  // "Don't" (short enough for an inline action), the HUD says "Deny". Seeing
  // both side by side is a thing the harness exists to show, so lock the
  // divergence rather than letting a well-meaning edit "fix" it to match.
  it('iOS says Don\'t where the HUD says Deny', () => {
    expect(swiftCategories).toContain('Don')
    expect(swiftCategories).not.toContain('"Deny"')
    expect(hudApp).toContain('Deny')
  })
})
