// screen-wake-lock.ts -- hold the PHONE's screen on while it is recording.
//
// The failure this fixes: on the web path the mic is a getUserMedia track, and
// WebKit mutes it when the app backgrounds (see the nativeCaptureRef comment at
// hooks/use-dictation.ts:466). A phone lying on the desk hits its display
// timeout mid-sentence and the rest of the dictation is silence -- with no
// error, because a muted track is not a failed one. Lazy mode made this the
// PRIMARY posture rather than an edge case, which is what earned the fix.
//
// Not to be confused with src/main/phone-remote/stay-awake.ts: that is
// Electron's powerSaveBlocker holding the MAC's display awake, and has no reach
// onto the phone at all. Two different screens, two different mechanisms.
//
// Availability, measured rather than assumed: iOS Safari has had this since
// 16.4, but it was broken in INSTALLED PWAs until 18.4 -- and an installed PWA
// is exactly how this app is used. So a rejected request is an ordinary
// outcome on an older phone, not an error worth surfacing: the user simply gets
// today's behavior. Never let it reach a toast.

/** Live sentinel, or null when nothing is held. */
let sentinel: WakeLockSentinel | null = null

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

/**
 * Hold the screen on. Idempotent -- a second call while held is a no-op rather
 * than a second sentinel, since only the first would ever be released.
 */
export async function acquireScreenWakeLock(): Promise<void> {
  if (!supported() || sentinel) return

  try {
    sentinel = await navigator.wakeLock.request('screen')
    // The OS drops the lock on its own whenever the page is hidden, and does
    // NOT restore it on return. Clearing our handle here is what makes the
    // visibility re-acquire below able to tell "we lost it" from "we hold it".
    sentinel.addEventListener('release', () => {
      sentinel = null
    })
  } catch {
    // NotAllowedError on an old PWA, or a page that isn't visible yet. Both
    // mean "no wake lock this time", which is survivable by construction.
    sentinel = null
  }
}

/** Let the screen sleep again. Safe with nothing held. */
export async function releaseScreenWakeLock(): Promise<void> {
  const held = sentinel
  sentinel = null
  if (!held) return
  try {
    await held.release()
  } catch {
    /* already gone -- the OS released it when the page hid */
  }
}

/** True while a lock is held. Exposed for the re-acquire check and for tests. */
export function hasScreenWakeLock(): boolean {
  return sentinel !== null
}
