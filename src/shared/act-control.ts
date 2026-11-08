// Verb set for the act-agent → main control channel (see src/main/act-control.ts).
// Shared so the socket server, the `mm-ui` shim, and any future caller all name
// the same strings. Verbs here are APP-side capabilities (they need Electron
// window state); anything that is a real HID event belongs in mm-input instead.

export const ACT_CONTROL_VERB = {
  /** Ring a point on the real screen with the act highlight overlay. No click. */
  highlight: 'highlight'
} as const

export type ActControlVerb = (typeof ACT_CONTROL_VERB)[keyof typeof ACT_CONTROL_VERB]
