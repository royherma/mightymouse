// ─────────────────────────────────────────────────────────────────────────────
// THE TOUR CONTENT. This is the one file to edit to change what the tour says.
// Add / remove / reorder a step here and TourApp re-renders it automatically —
// the App is a dumb renderer over this array, it has no content of its own.
//
// Hotkey display strings are pulled from the SHORTCUTS registry so the keys
// shown here never drift from the real shortcuts (single source of truth).
// ─────────────────────────────────────────────────────────────────────────────

import { comboGlyphs, getShortcut, type ShortcutId } from '../shortcuts'
import type { TourStep } from './types'

// A shortcut's display combo (e.g. "Cmd+Opt+Shift+;") by its typed id — getShortcut
// throws at module load if the id is unknown, so a rename fails loud, fail early.
function keysFor(id: ShortcutId): string {
  // Trim trailing "(or Space)"-style hints so the tour shows the primary combo.
  return comboGlyphs(getShortcut(id))
    .join('+')
    .split('(')[0]
    .trim()
}

export const TOUR_STEPS: TourStep[] = [
  // Title = the promise, blurb = the concrete proof. The promise is never allowed
  // to stand alone: "your computer, but easier" is the vaguest claim in software
  // on its own, and only earns its place because the next line is specific.
  {
    key: 'welcome',
    title: 'Build with MightyMouse',
    // Both halves of the product, in order: you tell it (command), and it
    // remembers (capture + recall). Leading on commands alone undersold recall
    // into a nice-to-have, which is what it is NOT.
    blurb: 'Describe what you want. Build it from your phone, the web, or your Mac.'
  },
  {
    key: 'listen',
    title: 'Talk instead of typing',
    blurb:
      'Press once to start talking, press again to stop. Your words show up right where you were.',
    shortcutKeys: keysFor('listen'),
    confirmShortcutId: 'listen'
  },
  {
    key: 'rewrite',
    // The three modes live in the blurb + the chips below, not in the title —
    // nobody should have to learn the word "Act" before they know what the app is for.
    title: 'Just say what you want',
    blurb:
      'Select anything, hit the keys, and tell it. Type to fix your writing, start with ? to ask, start with ! to get something done.',
    shortcutKeys: keysFor('main'),
    confirmShortcutId: 'main',
    // Rendered as three big tiles, not text chips. Rewrite is highlighted as the
    // one you get by just typing — the other two need a prefix key, so they read
    // as the deliberate step they are.
    chips: [
      { label: 'Rewrite & Type', mode: 'rewrite', highlighted: true },
      { label: 'Ask', mode: 'ask', glyph: '?' },
      { label: 'Act', mode: 'act', glyph: '!' }
    ]
  },
  {
    key: 'capture',
    title: 'Show it what you’re looking at',
    // Recording is the cost, finding it later is the reason — a blurb that stops
    // at "it writes down what was said" describes the mechanism and never says
    // why anyone would want it. "Later, in plain words" is the payoff and the
    // tour's only mention of recall.
    blurb:
      'Tap for a picture of your screen. Hold to record, then ask about any of it later, in plain words.',
    shortcutKeys: keysFor('capture'),
    confirmShortcutId: 'capture'
  },
  // Last on purpose: it's the only step needing a second device and a working
  // network, so it can't sit in front of the three hotkeys that ARE the product.
  {
    key: 'phone',
    title: 'Take it with you',
    // Says what the phone BECOMES, and nothing about scanning — the status line
    // under the code already gives that instruction, and repeating it here cost a
    // third wrapped line the 540px window doesn't have.
    blurb: 'Your phone becomes a trackpad and a mic, so you can run your Mac from the couch.',
    confirmPhonePair: true
  }
]
