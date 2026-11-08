// "View as user" preview flag — an admin's app-wide dress rehearsal.
//
// An admin can never see the app a normal user gets, because every admin
// surface (tray Admin ▸, Connectors, admin-only Settings sections) is gated on
// their own email. Flipping this on makes every VISIBILITY gate answer "not an
// admin", so the whole app renders exactly as it does for a real user.
//
// Deliberately in-memory and session-only: it is not persisted, so a restart
// always lands back in real admin view and nobody can get stuck outside their
// own tools. It gates DISPLAY only — main-process handlers and the Edge
// Functions keep checking the real email, so this can never grant or remove
// actual access.

let previewAsUser = false

/** Is the admin currently previewing the app as a regular user? */
export function isPreviewingAsUser(): boolean {
  return previewAsUser
}

export function setPreviewAsUser(on: boolean): void {
  previewAsUser = on
}
