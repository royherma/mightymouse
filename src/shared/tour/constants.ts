// Value tour — the ONE home for every tour string literal. Imported by main,
// preload, and renderer so nothing is hand-typed twice (no magic strings rule).
// Window/source params, analytics event names, and step keys all live here as
// `as const`, so the types in ./types.ts derive from them and the typechecker
// rejects any typo at the call site.

export const TOUR = {
  /** ?window= value that routes to TourApp (see renderer/src/main.tsx). */
  WINDOW: 'tour',

  /** Analytics event names — fired via window.api.track / track(). Snake_case
   * to match the existing event convention (e.g. onboarding_required_verified). */
  EVENT: {
    started: 'tour_started',
    stepViewed: 'tour_step_viewed',
    skipped: 'tour_skipped',
    completed: 'tour_completed',
    reopened: 'tour_reopened',
    keyConfirmed: 'tour_key_confirmed',
    keyTimedOut: 'tour_key_timed_out',
    /** The phone-pairing step: a phone actually connected during the tour.
     * Split from keyConfirmed so "learned the hotkeys" and "paired a phone"
     * stay separate funnels — they fail for completely different reasons. */
    phonePaired: 'tour_phone_paired',
    phonePairTimedOut: 'tour_phone_pair_timed_out'
  },

  /** ?source= value — how the tour was opened. Drives the `source` prop on
   * tour_started so we can split first-run (auto) vs manual re-open (tray). */
  SOURCE: {
    auto: 'auto',
    tray: 'tray',
    navigator: 'navigator'
  },

  /** Press-to-confirm state machine. One cap component reads
   * this to pick its treatment + motion; `idle` is the resting/breathing state,
   * `held` tracks live modifier state, `confirmed`/`wrong` are the two outcomes. */
  CONFIRM_STATE: {
    idle: 'idle',
    held: 'held',
    confirmed: 'confirmed',
    wrong: 'wrong'
  },

  /** The shortcuts whose tour step opens a live demo surface (tour-demo.ts).
   * ONE definition, read from both sides: main uses it to decide what to show,
   * the renderer uses it to pick the longer hold before advancing. They must
   * agree — a step that shows a demo but advances on the short beat tears the
   * demo down in the same blink it appeared. */
  DEMO_SHORTCUT_IDS: ['main', 'capture', 'listen'],

  /** Prefix for the fake run id behind a demo HUD card (tour-demo.ts). Namespaced
   * so it can never collide with a real run's uuid — a demo card is a real HUD
   * window with no run behind it, and nothing downstream should mistake it for
   * live work. */
  DEMO_RUN_ID_PREFIX: 'tour-demo:',

  /** Copy shown on the demo HUD cards. These stand in for the subtitle a real
   * run would stream in, so they describe what the user is looking at rather
   * than pretending a capture/transcription is in progress. */
  DEMO_HUD: {
    captureTitle: 'Screenshot',
    captureSubtitle: 'This card shows up when you capture.',
    listenTitle: 'Listening',
    listenSubtitle: 'Your words land here, then paste themselves.',
    /** The demo card resolves to its SUCCESS state instead of sitting in the
     * loading beat forever — a card stuck mid-capture reads as broken, and the
     * finished state is the half worth showing anyway. Nothing was captured or
     * transcribed; these are the shapes of a real result, not a real one. */
    captureDoneSummary: 'Captured',
    listenDoneSummary: 'Transcribed',
    /** Stand-in transcript on the finished listen card, so the body renders at a
     * realistic size rather than collapsing to an empty row. */
    listenDoneBody: 'That’s the idea - hold the keys, talk, and it types for you.'
  },

  /** How long the demo HUD holds its loading beat before flipping to success.
   * Short on purpose: the point is to show the card COMPLETING, and the step
   * only stays open TOUR_DEMO_ADVANCE_MS total, so this has to leave most of
   * that budget to the finished state. */
  DEMO_HUD_DONE_AFTER_MS: 700,

  /** §7.1 escalation: after this many hotkey steps time out with no press,
   * the unlocked line switches from the soft "no luck?" copy to the direct
   * "your shortcuts aren't responding" one. One miss could be hesitation;
   * two in a row is a broken-grant pattern. */
  NOT_RESPONDING_AFTER_TIMEOUTS: 2
} as const
