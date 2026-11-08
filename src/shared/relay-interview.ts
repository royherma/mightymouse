/**
 * A multi-question `ask`, shared so the phone card and the Mac HUD card step
 * through it identically. Invariant: nothing is typed into the picker until
 * every question is answered.
 */

/** `options` are labels only -- the picker is driven by ROW POSITION. */
export interface RelayQuestion {
  question: string
  options?: string[]
  /** Space-per-choice then Enter on Submit, not Down×N + Enter (picker-keys.ts multiSelectKeys). */
  multiSelect?: boolean
}

/** An answer to one question, keyed by its index in the array. Index, not
 *  question text: two questions may legitimately read the same. */
export interface RelayInterviewAnswer {
  index: number
  answer: string
  /** 0-based option rows picked for a multiSelect question; unset otherwise. */
  picks?: number[]
}

/** Why an interview cannot be finished from the phone. Each maps to one line of
 *  card copy -- a closed set so a new blocker cannot ship without its string. */
export type RelayInterviewBlock = 'noPane'

/** First answer per index wins, matching the store's first-answer-wins contract
 *  for the single-question case. A second answer to an index already held is
 *  dropped, not overwritten -- two surfaces racing must agree on the winner.
 *
 *  `revise` is the ONE exception, and it is not a weakening of that rule: a race
 *  is two surfaces answering the question each thinks is current, while a
 *  revision is someone who stepped BACK to an index they can see is answered and
 *  chose again. The card can tell those apart -- it knows it navigated -- and the
 *  store cannot, which is why the caller states it rather than the store
 *  inferring it from timing. */
export function bufferAnswer(
  buffered: readonly RelayInterviewAnswer[],
  next: RelayInterviewAnswer,
  revise = false
): RelayInterviewAnswer[] {
  if (buffered.some((a) => a.index === next.index)) {
    if (!revise) return [...buffered]
    return buffered.map((a) => (a.index === next.index ? next : a))
  }
  return [...buffered, next].sort((a, b) => a.index - b.index)
}

/** The answer already held for an index, or undefined. What a stepped-back
 *  question renders as its current pick. */
export function answerAt(
  buffered: readonly RelayInterviewAnswer[] | undefined,
  index: number
): string | undefined {
  return buffered?.find((a) => a.index === index)?.answer
}

/** Lowest index with no answer yet, or -1 when done (the signal to submit the
 *  burst). Gaps are possible -- the lock screen answers Q1 while the card may
 *  be open at any index -- so this scans rather than counts. */
export function cursorFor(
  questions: readonly RelayQuestion[],
  buffered: readonly RelayInterviewAnswer[]
): number {
  const answered = new Set(buffered.map((a) => a.index))
  for (let i = 0; i < questions.length; i++) if (!answered.has(i)) return i
  return -1
}

/** Every question has a buffered answer -- the one condition under which
 *  anything may be typed into the picker. */
export function isComplete(
  questions: readonly RelayQuestion[],
  buffered: readonly RelayInterviewAnswer[]
): boolean {
  return questions.length > 0 && cursorFor(questions, buffered) === -1
}

/** What stops this interview being finished on the phone, or null when nothing does. */
export function blockFor(
  questions: readonly RelayQuestion[],
  hasPane: boolean
): RelayInterviewBlock | null {
  // A single question is answerable blind -- one Down×N + Enter needs no
  // advancement check, which is the whole reason N=1 ships unchanged.
  if (!hasPane && questions.length > 1) return 'noPane'
  return null
}

/** Card copy for a block. Plain words, benefit-first: it says what to do, not
 *  what the software could not do. */
export function blockCopy(_block: RelayInterviewBlock): string {
  return 'Answer the first one here, then finish the rest on your Mac.'
}

/** How many questions this card may collect before it must hand back to the
 *  Mac. Under a `noPane` block that is one; otherwise the whole array. */
export function answerableCount(questions: readonly RelayQuestion[], hasPane: boolean): number {
  return blockFor(questions, hasPane) === null ? questions.length : Math.min(1, questions.length)
}

/** More than one question, so the notification drops its option buttons and the
 *  card becomes the only way to answer. */
export function isInterview(questions: readonly RelayQuestion[] | undefined): boolean {
  return (questions?.length ?? 0) > 1
}

/** May this card offer a typed answer at all? A free answer lands on the
 *  picker's "Type something" row, and picker-keys REFUSES to count down to a row
 *  it could not read (pickerPlan(..., false) === null). So without a pane the
 *  box takes an answer that nothing will ever type -- offer chips only.
 *
 *  Unless there are no chips either: a card with no controls at all cannot be
 *  answered from here, and a box that MIGHT not deliver still beats that. */
export function canTypeAnswer(hasPane: boolean, hasOptions: boolean): boolean {
  return hasPane || !hasOptions
}

/** What a PUSH says about an interview, or null for a single question. It has to
 *  say "tap": with no buttons, a notification that only shows the question looks
 *  like it is waiting for something the lock screen cannot give it. */
export function interviewPushSuffix(
  questions: readonly RelayQuestion[] | undefined,
  buffered?: readonly RelayInterviewAnswer[]
): string | null {
  const total = questions?.length ?? 0
  if (!isInterview(questions)) return null
  // Counts DOWN once anything is answered: a nudge must say what is LEFT, not
  // restate the total the person already worked through.
  const left = total - (buffered?.length ?? 0)
  return left === 1 ? '1 question left - tap to answer.' : `${left} questions - tap to answer.`
}

/** Everything a card needs to draw one step. Derived in ONE place -- the last
 *  shared relay component that kept per-surface copies of its own state drifted
 *  for months (phone-remote/CLAUDE.md, "rendered TWICE"). */
export interface RelayInterviewView {
  /** True only for a genuine multi-question ask. N=1 renders exactly as before,
   *  which is what keeps today's verified single-question flow untouched. */
  isInterview: boolean
  /** The question to draw right now, or null when there is nothing left. */
  current: RelayQuestion | null
  /** Its index -- what the card sends back as `questionIndex` so the Mac never
   *  re-derives a cursor the card already resolved. */
  index: number
  /** 1-based position and total, for the "2 of 3" label. */
  step: number
  total: number
  /** Copy for a blocked interview, or null when it can be finished here. */
  blockedCopy: string | null
  /** Whether to draw the free-text box -- false when no pane can carry it. */
  canType: boolean
  /** The answer already held for the question on screen, when stepping back onto
   *  one. Drives the chip's tick, and its presence is what makes the next answer
   *  a revision rather than a race. */
  answered?: string
  /** Which indexes the nav arrows may reach, so a card renders them disabled
   *  rather than working out reachability twice. -1 means "no such step". */
  prevIndex: number
  nextIndex: number
}

/** The furthest question this surface may show. One past the last answered one
 *  (the cursor), capped by what the surface may collect -- you may look back at
 *  anything you answered and forward to the one you are on, never at a question
 *  the interview has not reached. */
function reachableMax(
  questions: readonly RelayQuestion[],
  buffered: readonly RelayInterviewAnswer[],
  hasPane: boolean
): number {
  const cursor = cursorFor(questions, buffered)
  const limit = answerableCount(questions, hasPane) - 1
  // Cursor -1 means every question is answered, so the last one is reachable.
  return Math.min(cursor === -1 ? questions.length - 1 : cursor, limit)
}

/** One question's view. `hasPane` is the tmux fact from the request's origin;
 *  `buffered` is what has already been collected on any surface. `flatOptions`
 *  is the single-question `params.options`, which lives beside `questions`
 *  rather than inside it -- without it an N=1 ask reads as having no chips.
 *
 *  `viewIndex` is a card stepping BACK to re-read or change an earlier answer.
 *  It is clamped here rather than trusted: the card holds it across re-renders
 *  while `buffered` moves underneath it (the lock screen can answer the same
 *  interview), so a stale index must resolve to a real question rather than
 *  blanking the card. */
export function interviewView(
  questions: readonly RelayQuestion[] | undefined,
  buffered: readonly RelayInterviewAnswer[] | undefined,
  hasPane: boolean,
  flatOptions?: readonly string[],
  viewIndex?: number
): RelayInterviewView {
  const all = questions ?? []
  const held = buffered ?? []
  if (all.length <= 1) {
    const chips = all[0]?.options?.length ?? flatOptions?.length ?? 0
    return {
      isInterview: false,
      current: all[0] ?? null,
      index: 0,
      step: 1,
      total: 1,
      blockedCopy: null,
      canType: canTypeAnswer(hasPane, chips > 0),
      prevIndex: -1,
      nextIndex: -1
    }
  }
  const block = blockFor(all, hasPane)
  const max = reachableMax(all, held, hasPane)
  const cursor = cursorFor(all, held)
  const index =
    viewIndex === undefined ? cursor : Math.max(0, Math.min(viewIndex, max))
  // Past what this surface may collect: the remaining questions belong to the
  // Mac, so the card stops offering controls and says so instead.
  const beyondLimit = index === -1 || index >= answerableCount(all, hasPane)
  const current = beyondLimit ? null : all[index]
  // Back is available from the "all answered" state too (index -1): that screen
  // is the most likely place to notice a wrong answer, and it is the only one
  // where every question is behind you.
  const from = index === -1 ? all.length : index
  return {
    isInterview: true,
    current,
    index,
    step: index === -1 ? all.length : index + 1,
    total: all.length,
    blockedCopy: block ? blockCopy(block) : null,
    canType: canTypeAnswer(hasPane, (current?.options?.length ?? 0) > 0),
    answered: index === -1 ? undefined : answerAt(held, index),
    prevIndex: from > 0 ? from - 1 : -1,
    nextIndex: index !== -1 && index < max ? index + 1 : -1
  }
}
