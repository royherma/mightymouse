/**
 * point-tag.ts — the one home for the "[POINT:…]" answer tag the model uses to
 * say WHERE on screen to point (and, when the user opts in, click).
 *
 * Two forms, both parsed here so the prompt copy (config.ts) and the parser
 * (hud-run.ts) never drift:
 *   [POINT:1240,860]    — raw IMAGE-PIXEL coords read off the screenshot the model
 *                         was shown. The caller converts pixels → logical screen
 *                         points (÷ display scale + display origin).
 *   [POINT:"Export"]    — a text LABEL to resolve locally via OCR (find-on-screen),
 *                         which is pixel-accurate and free when the control is text.
 *
 * Kept as a tiny shared module (not a magic string in two files) per the
 * no-magic-strings hard rule.
 */

/** A parsed point tag: either explicit pixel coords or a label to resolve. */
export type PointTag = { kind: 'coords'; x: number; y: number } | { kind: 'label'; label: string }

// One regex, both forms. Group 1 = quoted label, groups 2/3 = x,y. Case-insensitive
// on the POINT keyword; tolerant of spaces around the colon/comma.
// Examples matched: [POINT:1240,860]  [POINT: 1240 , 860 ]  [POINT:"Export as PNG"]
const POINT_TAG_RE = /\[POINT:\s*(?:"([^"]+)"|(\d+)\s*,\s*(\d+))\s*\]/i

/**
 * Pull the first [POINT:…] tag out of an answer. Returns the parsed tag plus the
 * answer with EVERY point tag stripped (so the visible text never shows the raw
 * directive), or null when there's no tag.
 */
export function parsePointTag(answer: string): { tag: PointTag; stripped: string } | null {
  const m = POINT_TAG_RE.exec(answer)
  if (!m) return null

  const stripped = answer.replace(new RegExp(POINT_TAG_RE, 'gi'), '').replace(/\s+\n/g, '\n').trim()

  if (m[1] !== undefined) {
    return { tag: { kind: 'label', label: m[1] }, stripped }
  }
  return { tag: { kind: 'coords', x: Number(m[2]), y: Number(m[3]) }, stripped }
}

/**
 * The "[TYPE:…]" answer tag — tells the app to synthesize keyboard input after
 * an optional point/click, so "click the search box and type hello" works. Two
 * forms, same opt-in gating as clicking (Accessibility + the toggle):
 *   [TYPE:"hello world"]  — type the literal text verbatim.
 *   [TYPE:key="cmd+a"]    — press a named key / combo (return, tab, cmd+a, …).
 */
export type TypeTag = { kind: 'text'; text: string } | { kind: 'key'; combo: string }

// Group 1 = key combo (key="…" form), group 2 = literal text. Case-insensitive
// on the TYPE keyword. Examples: [TYPE:"hello"]  [TYPE:key="cmd+a"]
const TYPE_TAG_RE = /\[TYPE:\s*(?:key\s*=\s*"([^"]+)"|"([^"]+)")\s*\]/i

/**
 * Pull the first [TYPE:…] tag out of an answer. Returns the parsed tag plus the
 * answer with EVERY type tag stripped, or null when there's no tag. Mirrors
 * parsePointTag so a single answer can carry both a POINT and a TYPE directive.
 */
export function parseTypeTag(answer: string): { tag: TypeTag; stripped: string } | null {
  const m = TYPE_TAG_RE.exec(answer)
  if (!m) return null

  const stripped = answer.replace(new RegExp(TYPE_TAG_RE, 'gi'), '').replace(/\s+\n/g, '\n').trim()

  if (m[1] !== undefined) {
    return { tag: { kind: 'key', combo: m[1] }, stripped }
  }
  return { tag: { kind: 'text', text: m[2] }, stripped }
}
