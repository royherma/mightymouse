/**
 * The step header on a multi-question ask: "Question 2 of 3" with the arrows
 * that move between them.
 *
 * Shared because it has THREE hosts -- the phone card, the Mac HUD card and the
 * panel's card -- and this directory has already paid for a component rendered
 * in more than one place with per-host copies of its own logic (see
 * phone-remote/CLAUDE.md, "rendered TWICE"). The hosts differ only in class
 * prefix, so that is the one thing they pass.
 *
 * Render-only: it decides nothing about reachability. `prevIndex`/`nextIndex`
 * come from `interviewView`, which is the single place that knows how far back
 * and forward this surface may go.
 *
 * Hosts pass their own class names rather than a prefix: the phone is camelCase
 * (`codeCardStep`) and the Mac is hyphenated (`code-card-step`), so any single
 * convention would have made one of them wrong.
 */

import type { JSX } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { CONFIG } from './config'
import type { RelayInterviewView } from './relay-interview'
import { Button } from './ui/Button'

export interface RelayInterviewNavClasses {
  row: string
  label: string
  nav: string
  btn: string
}

/** The two host stylesheets, named here so a call site cannot typo one half of
 *  a pair and lose only the arrows. */
export const PHONE_NAV_CLASSES: RelayInterviewNavClasses = {
  row: 'codeCardStep',
  label: 'codeCardStepLabel',
  nav: 'codeCardStepNav',
  btn: 'codeCardStepBtn'
}

export const MAC_NAV_CLASSES: RelayInterviewNavClasses = {
  row: 'code-card-step',
  label: 'code-card-step-label',
  nav: 'code-card-step-nav',
  btn: 'code-card-step-btn'
}

export const HUD_NAV_CLASSES: RelayInterviewNavClasses = {
  row: 'hud-step',
  label: 'hud-step-label',
  nav: 'hud-step-nav',
  btn: 'hud-step-btn'
}

export function RelayInterviewNav({
  interview,
  onGo,
  classes
}: {
  interview: RelayInterviewView
  /** Move to this question index. Only ever called with a reachable one. */
  onGo: (index: number) => void
  classes: RelayInterviewNavClasses
}): JSX.Element | null {
  if (!interview.isInterview) return null
  const { prevIndex, nextIndex } = interview
  const label = `Question ${interview.step} of ${interview.total}`
  // Nothing reachable either way -- the first question of a fresh interview.
  // Two permanently greyed arrows read as broken, so it renders as the plain
  // label it was before this feature existed.
  if (prevIndex === -1 && nextIndex === -1) return <div className={classes.row}>{label}</div>
  return (
    <div className={classes.row}>
      <span className={classes.label}>{label}</span>
      <span className={classes.nav}>
        <Button variant="bare"
          type="button"
          className={classes.btn}
          disabled={prevIndex === -1}
          aria-label={CONFIG.UI_LABELS.CODE_ASK_BACK}
          title={CONFIG.UI_LABELS.CODE_ASK_BACK}
          onClick={() => onGo(prevIndex)}
        >
          <ChevronLeft size={16} strokeWidth={2.5} />
        </Button>
        <Button variant="bare"
          type="button"
          className={classes.btn}
          disabled={nextIndex === -1}
          aria-label={CONFIG.UI_LABELS.CODE_ASK_NEXT}
          title={CONFIG.UI_LABELS.CODE_ASK_NEXT}
          onClick={() => onGo(nextIndex)}
        >
          <ChevronRight size={16} strokeWidth={2.5} />
        </Button>
      </span>
    </div>
  )
}
