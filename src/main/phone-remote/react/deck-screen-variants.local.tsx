/**
 * Dev-only: mock the four "see your Mac from inside the deck" placements so the
 * choice gets made from pixels instead of from a description.
 *
 * Nothing here ships. It paints on TOP of the real `SwipeDeckSheet` via injected
 * CSS + a portal, so the shipped deck stays byte-identical while the layouts are
 * being judged. Whichever variant wins gets built properly afterwards.
 *
 * The screen is a fake: a static frame at the Mac's real 16:10, not WebRTC. What
 * is being judged is where the video BOX goes and what it does to the cards --
 * a live stream would answer none of that and needs a paired phone to see.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/** The four placements, in the order Roy proposed them. */
export type ScreenVariant =
  | 'off'
  | 'inCard'
  | 'headerBtn'
  | 'aboveCards'
  | 'backAndScreen'
  | 'behind'

export const SCREEN_VARIANTS: { id: ScreenVariant; label: string; note: string }[] = [
  { id: 'off', label: 'Off (today)', note: 'The deck exactly as it ships.' },
  {
    id: 'inCard',
    label: 'A · In the card',
    note: 'The screen lives inside each card, under the ask. The card grows to fit it.'
  },
  {
    id: 'headerBtn',
    label: 'B · Header button',
    note: 'One button next to the X. Tapping it opens the full mirror; the deck is untouched.'
  },
  {
    id: 'aboveCards',
    label: 'C · Above the cards',
    note: 'A live strip pinned above the stack. Always on, every card pushed down.'
  },
  {
    id: 'backAndScreen',
    label: 'D · Back ‹ + screen, strip on top',
    note:
      'Back caret left of the title, screen button pinned FAR RIGHT where the X was. The Mac sits up top at full brightness and the whole stack shifts down under it.'
  },
  {
    id: 'behind',
    label: 'E · Screen BEHIND the cards',
    note:
      'Back caret left, screen button replaces the X. The Mac fills the deck behind the stack, dimmed, so you see it without leaving the card.'
  }
]

/** A stand-in for the Mac at its real aspect. Deliberately crude: if a layout
 *  only reads well over a pretty screenshot it is not the layout that is
 *  working. 16:10 is the MacBook panel every phone-side geometry assumes. */
function FakeScreen({ tall }: { tall?: boolean }): React.JSX.Element {
  return (
    <div className="dsvScreen" data-tall={tall || undefined}>
      <div className="dsvScreenBar">
        <span className="dsvDot" />
        <span className="dsvDot" />
        <span className="dsvDot" />
        <span className="dsvScreenTitle">Your Mac · live</span>
      </div>
      <div className="dsvScreenBody">
        <div className="dsvWin" />
        <div className="dsvWin dsvWinB" />
        <div className="dsvCaret" />
      </div>
    </div>
  )
}

/** Injected rather than written into `theme.css`: this is a mock, and a real
 *  stylesheet edit would have to be unpicked once a variant wins. */
const CSS = `
.dsvScreen {
  border-radius: 10px;
  overflow: hidden;
  background: #1c1c1e;
  border: 1px solid rgba(255,255,255,0.09);
  box-shadow: 0 6px 18px rgba(0,0,0,0.18);
  aspect-ratio: 16 / 10;
  width: 100%;
  display: flex;
  flex-direction: column;
}
.dsvScreenBar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  background: #2c2c2e;
  flex: 0 0 auto;
}
.dsvDot { width: 7px; height: 7px; border-radius: 50%; background: #5a5a5e; }
.dsvScreenTitle {
  margin-left: 6px; color: #9a9aa0; font-size: 9px; letter-spacing: 0.02em;
}
.dsvScreenBody { position: relative; flex: 1; background: linear-gradient(140deg,#2f3138,#1a1b20); }
.dsvWin {
  position: absolute; left: 10%; top: 14%; width: 52%; height: 56%;
  border-radius: 6px; background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.10);
}
.dsvWinB { left: 38%; top: 32%; width: 50%; height: 52%; background: rgba(255,255,255,0.12); }
.dsvCaret {
  position: absolute; left: 62%; top: 62%; width: 2px; height: 13px;
  background: #ff9d4d; animation: dsvBlink 1s steps(1) infinite;
}
@keyframes dsvBlink { 50% { opacity: 0 } }

/* ---- A: inside the card ------------------------------------------------- */
.dsvInCard .swipeDeckCard .dsvSlot { margin-top: 10px; }

/* ---- C/D: a strip above the stack --------------------------------------- */
.dsvStrip { flex: 0 0 auto; margin: 0 0 10px; }
.dsvStripLabel {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; color: var(--text-muted-medium); margin: 0 2px 5px;
}
.dsvStripLive { display: inline-flex; align-items: center; gap: 5px; }
.dsvLiveDot {
  width: 6px; height: 6px; border-radius: 50%; background: #34c759;
  box-shadow: 0 0 0 3px rgba(52,199,89,0.18);
}

/* ---- B/D: the header buttons -------------------------------------------- */
.dsvHeadBtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 9px;
  background: var(--surface2, rgba(120,120,128,0.12));
  border: none; color: var(--accent); cursor: pointer; padding: 0;
}
.dsvHeadBtn[data-ghost] { background: transparent; }

/* ---- D: the strip owns the top, cards shift down ------------------------ */
/* No scrim of any kind here -- D's whole point is the Mac at full brightness.
   The cards move rather than the screen dimming, so nothing competes. */
/* The margin-left:auto that pins the far-right control lives on .chatHeaderBtn
   (theme.css:2426) -- the X. Hiding it takes the push with it, so the screen
   button must carry the auto margin itself or it bunches up next to the count. */
.dsvTopStrip .chatHeaderBtn,
.dsvBehind .chatHeaderBtn { display: none; }
.dsvTopStrip .dsvHeadSlot,
.dsvBehind .dsvHeadSlot { margin-left: auto; display: inline-flex; }
.dsvBackSlot { display: inline-flex; }
.dsvTopStrip .dsvStrip { margin-bottom: 14px; }
.dsvTopStrip .dsvBackCaret { color: var(--text-muted-medium); }

/* ---- E: the screen IS the background ------------------------------------ */
/* The deck paints an opaque plate (theme.css:10484) precisely so nothing shows
   through it. That plate is the thing in the way here, so E replaces it with the
   screen and re-dims on top -- the cards still need an opaque field to read
   against, they just get it from a scrim instead of the panel. */
/* The plate is painted on .swipeDeck ITSELF (theme.css:10489), which is the
   parent of the backdrop -- so an element background beats any child z-index and
   the screen renders invisible. It has to be cleared, not out-stacked. */
.dsvBehind { background: #000 !important; }
.dsvBehind .dsvBackdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
}
.dsvBehind .dsvBackdrop .dsvScreen {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  aspect-ratio: auto;
  border: none;
  border-radius: 0;
  box-shadow: none;
}
/* Dim + desaturate: at full strength the Mac's own windows compete with the
   card's buttons for the same eye. This is the one number worth tuning. */
.dsvBehind .dsvBackdrop::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--surface1);
  opacity: var(--dsv-dim, 0.82);
  backdrop-filter: blur(var(--dsv-blur, 3px));
}
/* Everything the deck already renders sits above the backdrop. */
.dsvBehind > *:not(.dsvBackdrop) { position: relative; z-index: 1; }
.dsvBackCaret {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; margin-right: -2px; margin-left: -6px;
  background: transparent; border: none; padding: 0;
  color: var(--text-muted-medium); cursor: pointer;
}
`

/**
 * Paints a variant over the live deck.
 *
 * Portals rather than props: the deck's header and card bodies are internal to
 * `@shared/swipe-deck`, and the whole point of a mock is to not touch it yet.
 * Each effect finds the real node and hangs a slot off it, then cleans up.
 */
export function ScreenVariantOverlay({
  variant,
  host
}: {
  variant: ScreenVariant
  host: HTMLElement | null
}): React.JSX.Element | null {
  const [slots, setSlots] = useState<{
    card: HTMLElement[]
    strip: HTMLElement | null
    head: HTMLElement | null
    back: HTMLElement | null
    backdrop: HTMLElement | null
  }>({ card: [], strip: null, head: null, back: null, backdrop: null })

  useEffect(() => {
    if (!host || variant === 'off') {
      setSlots({ card: [], strip: null, head: null, back: null, backdrop: null })
      return
    }
    const made: HTMLElement[] = []
    const root = host.querySelector<HTMLElement>('.swipeDeck')
    if (!root) return
    root.classList.toggle('dsvInCard', variant === 'inCard')
    root.classList.toggle('dsvBehind', variant === 'behind')
    root.classList.toggle('dsvTopStrip', variant === 'backAndScreen')

    let strip: HTMLElement | null = null
    let head: HTMLElement | null = null
    let back: HTMLElement | null = null
    let backdrop: HTMLElement | null = null
    const cards: HTMLElement[] = []

    if (variant === 'inCard') {
      // Every card, not just the top one: the stack is the layout risk -- a
      // screen in card 1 changes where cards 2 and 3 peek out.
      for (const card of root.querySelectorAll<HTMLElement>('.swipeDeckCard')) {
        const slot = document.createElement('div')
        slot.className = 'dsvSlot'
        card.appendChild(slot)
        made.push(slot)
        cards.push(slot)
      }
    }

    if (variant === 'aboveCards' || variant === 'backAndScreen') {
      const header = root.querySelector<HTMLElement>('.chatHeader')
      strip = document.createElement('div')
      strip.className = 'dsvStrip'
      header?.after(strip)
      made.push(strip)
    }

    if (variant === 'backAndScreen' || variant === 'behind') {
      // The caret reads as "back" only before the title, so it is prepended
      // rather than dropped in the header's flex order.
      const title = root.querySelector<HTMLElement>('.chatTitle')
      back = document.createElement('span')
      back.className = 'dsvBackSlot'
      title?.before(back)
      made.push(back)
    }

    if (variant === 'behind') {
      // Prepended so it is the deck's first child, under everything, without
      // the stack needing a z-index of its own.
      backdrop = document.createElement('div')
      backdrop.className = 'dsvBackdrop'
      root.prepend(backdrop)
      made.push(backdrop)
    }

    if (variant === 'headerBtn' || variant === 'backAndScreen' || variant === 'behind') {
      // Appended, not inserted before the X: in D and E the screen button IS
      // the far-right control, so it takes the X's slot rather than crowding it.
      const closeBtn = root.querySelector<HTMLElement>('.chatHeaderBtn')
      head = document.createElement('span')
      // The portal renders INTO this span, so the span -- not the button -- is
      // the header's flex item. Any pinning has to land here.
      head.className = 'dsvHeadSlot'
      if (variant === 'headerBtn') closeBtn?.before(head)
      else closeBtn?.after(head)
      made.push(head)
    }

    setSlots({ card: cards, strip, head, back, backdrop })
    return () => {
      root.classList.remove('dsvInCard')
      root.classList.remove('dsvBehind')
      root.classList.remove('dsvTopStrip')
      for (const n of made) n.remove()
    }
  }, [host, variant])

  if (variant === 'off') return null

  return (
    <>
      <style>{CSS}</style>
      {slots.card.map((slot, i) => createPortal(<FakeScreen key={i} />, slot))}
      {slots.strip &&
        createPortal(
          <>
            <div className="dsvStripLabel">
              <span className="dsvStripLive">
                <span className="dsvLiveDot" />
                Your Mac
              </span>
              <span>tap to open</span>
            </div>
            <FakeScreen />
          </>,
          slots.strip
        )}
      {slots.backdrop && createPortal(<FakeScreen />, slots.backdrop)}
      {slots.back &&
        createPortal(
          <button className="dsvBackCaret" type="button" aria-label="Back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>,
          slots.back
        )}
      {slots.head &&
        createPortal(
          <button className="dsvHeadBtn" type="button" aria-label="Show my Mac">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="4" width="20" height="13" rx="2" />
              <path d="M8 20h8" />
            </svg>
          </button>,
          slots.head
        )}
    </>
  )
}
