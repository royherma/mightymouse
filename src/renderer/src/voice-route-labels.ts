// How a routing row is labelled: what text it shows and what letter its badge
// carries. Pure string work, split out of VoiceRouteApp so it is testable
// without a renderer (a component file may only export components).

/** An agent's label is the shim's derived identity, "repo/branch - tag" (see
 *  deriveIdentity in npm-shim/mightymouse-code/bin/mightymouse-code.js). Only
 *  the tag tells two agents apart; the repo is the avatar and the branch is a
 *  hover chip, so both are noise in a row this narrow. Cutting at the LAST "/"
 *  was not enough — that left "main - pro-paywall", six rows all starting
 *  "main". Cut the whole "repo/branch - " prefix instead.
 *
 *  A renamed session has no prefix ("fix the auth bug"), which is why the split
 *  is conditional rather than an unconditional slice. */
export function agentName(label: string): string {
  const dash = label.indexOf(' - ')
  const tag = dash > 0 ? label.slice(dash + 3).trim() : ''
  if (tag !== '') return tag

  // No tag: fall back to the branch, cut off the repo. Runs on the part BEFORE
  // the separator so an empty tag can't leave a dangling "main - ".
  const where = dash > 0 ? label.slice(0, dash) : label
  const cut = where.lastIndexOf('/')
  return cut >= 0 && cut < where.length - 1 ? where.slice(cut + 1) : where
}

/** The row already carries a "/" icon, so a label that also starts with one
 *  renders as "//wip-scan". */
export function skillName(label: string): string {
  return label.startsWith('/') ? label.slice(1) : label
}

/** The project's first letter, not the label's: an agent label leads with the
 *  branch ("main - pro-paywall"), so every agent on main drew the same M. */
export function badgeLetter(project: string, label: string): string {
  const source = project !== '' ? project : label
  return (source.match(/[a-z0-9]/i)?.[0] ?? source.slice(0, 1)).toUpperCase()
}

export const SKELETON_WIDTHS = ['72%', '54%', '63%']
