import React from 'react'
import QuickActionEditor from './components/QuickActionEditor'

// ── SkillEditorApp ────────────────────────────────────────────────────────────
// Host for the shortcuts editor in its OWN full-screen transparent overlay window
// (?window=skill-editor, built by skill-editor-window.ts). Lives in a dedicated
// window — not inside the panel — so the modal centers on the whole display and
// is never clipped by the panel's small bounds (CLAUDE.md fixed-can't-escape).
//
// The window IS the modal: closing it (Save done / Esc / backdrop) tells main to
// tear the window down. The panel reloads its shortcut pills off the
// `actionsChanged` broadcast that main fires after actionsSave — so nothing needs
// to travel back through this window.
export default function SkillEditorApp(): React.ReactElement {
  const close = (): void => window.api.skillEditorClose()

  return (
    <QuickActionEditor
      onClose={close}
      // Save persists via actionsSave (which broadcasts actionsChanged to the
      // panel); we just close the window afterward.
      onSaved={close}
    />
  )
}
