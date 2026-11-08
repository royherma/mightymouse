/**
 * Dev-only harness for the swipe deck.
 *
 * Why this exists: the deck is the one relay surface with no way to look at it
 * except a paired phone and a live idle agent. That loop is too slow to iterate
 * layout in, and it is why the deck shipped with suggestions that never rendered
 * -- nobody could see a second card without a real skip on a real device.
 *
 * It also front-runs the port: the deck is about to be shared between the phone
 * and a Mac window, and the thing that proves the fork is only skin-deep is
 * seeing ONE component render both skins from one fixture set, side by side.
 *
 * How real each column is, because that decides what it can be used to judge:
 *
 * - **Phone** -- the REAL `SwipeDeckSheet`, styled by the real theme.css.
 *   Layout evidence.
 * - **Mac** -- the same real component, styled by the renderer's real
 *   index.css. Until step 4 lands `MAC_DECK_CLASSES` it renders in the phone's
 *   class names against Mac tokens, so read it for TOKENS (color, contrast,
 *   density), not yet for Mac-specific layout.
 *
 * Cards come from the real `buildDeck` over fixture sessions + requests, never
 * from hand-written `SwipeCard`s: the bug this deck already had lived in that
 * derivation, and fixtures that skip it cannot catch its successor.
 *
 * Never imported by main.tsx. Reachable only via deck-harness.local.html.
 */

import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { CONFIG } from '@shared/config'
import { buildDeck } from '@shared/swipe-triage'
import type { SwipeAffirm, SwipeCard } from '@shared/swipe-triage'
import { cardSuggestKey } from '@shared/swipe-suggest'
import type { Suggestion } from '@shared/swipe-suggest'
import SwipeDeckSheet from './SwipeDeckSheet'
import SessionList from './SessionList'
import { SCENARIOS, NOW } from './deck-fixtures.local'
import { ScreenVariantOverlay, SCREEN_VARIANTS } from './deck-screen-variants.local'
import type { ScreenVariant } from './deck-screen-variants.local'
import { IslandVariantOverlay, ISLAND_VARIANTS } from './deck-island-variants.local'
import type { IslandVariant } from './deck-island-variants.local'
import type { DeckScenario } from './deck-fixtures.local'
import './theme.css'
import './skins/proII.css'
import '../../../renderer/src/index.css'
import './deck-harness.local.css'

/** Same call the renderer's main.tsx makes. Without it every var(--surface2) /
 *  var(--shadow-panel) the deck is built from resolves to nothing and both
 *  columns render as unstyled boxes. Key casing matters: the tokens are
 *  camelCase in CONFIG and kebab on the wire. */
function injectRendererTheme(): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(CONFIG.THEME_TOKENS)) {
    root.style.setProperty(`--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`, value)
  }
}
injectRendererTheme()

/** Chips for the idle-with-TLDR scenario, keyed the way the deck reads them.
 *  Derived from the built card rather than typed by hand: `cardSuggestKey` is
 *  the exact derivation the shipped bug got wrong, so a hand-written key here
 *  would re-create the bug inside the thing meant to catch it. */
function suggestionsFor(deck: SwipeCard[], chips: Suggestion[]): Record<string, Suggestion[]> {
  const top = deck[0]
  // `undefined` is a real answer: a card with no TLDR and no subject has no key,
  // so nothing can be keyed to it and the canned three are correct.
  const key = top ? cardSuggestKey(top) : undefined
  return key ? { [key]: chips } : {}
}

// Emoji on two of three on purpose: it is optional on the wire, so a set where
// every chip has one would hide a layout that only works when they all do.
const CHIPS: Suggestion[] = [
  { text: 'Ship it', emoji: '🚀' },
  { text: 'Run the tests', emoji: '🧪' },
  { text: 'Show me the diff' }
]

type Skin = 'phone' | 'mac'

const TUNE_DEFAULT = { o1: 0.8, o2: 1, b1: 11, b2: 5 }
type StackTune = typeof TUNE_DEFAULT
const CX_SLACK_PX = 2
const CY_SLACK_PX = 3

type CardRect = {
  depth: number
  w: number
  h: number
  cx: number
  cy: number
  dy: number
  dcx: number
}

/** Live `getBoundingClientRect` of every `.swipeDeckCard` in this stage.
 *  A stack is good when all three share one centre X and the Y step is the
 *  14/28 lip — the on-phone bug was a 185px centre gap. */
/** Frame-by-frame trace of the TOP card through a promotion.
 *  The resting `StackMeasure` above cannot see a pop: it samples every 400ms and
 *  the whole swap is over in ~200ms. This watches the card node itself, logging
 *  one row per rAF from the moment the deck's card count changes, so a snap
 *  shows up as one row where geometry jumps instead of a smooth ramp of them.
 *  Animation name is read live -- "(none)" while the card is changing size is
 *  the signature of the rise never starting. */
function PromoteTrace({ host }: { host: HTMLElement | null }): React.JSX.Element {
  const [rows, setRows] = useState<string[]>([])

  useEffect(() => {
    if (!host) return
    let raf = 0
    let framesLeft = 0
    let lastKey = ''
    let t0 = 0

    const topCard = (): HTMLElement | null =>
      host.querySelector<HTMLElement>('.swipeDeckCard:not(.swipeDeckCardBehind)')

    const sample = (): void => {
      const el = topCard()
      if (el) {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        const t = Math.round(performance.now() - t0)
        setRows((prev) =>
          [
            ...prev,
            `+${String(t).padStart(3)}ms  h=${r.height.toFixed(0)} y=${r.top.toFixed(0)} ` +
              `anim=${cs.animationName === 'none' ? '(none)' : cs.animationName} op=${Number(cs.opacity).toFixed(2)}`
          ].slice(-14)
        )
      }
      if (--framesLeft > 0) raf = requestAnimationFrame(sample)
    }

    // A promotion is a NEW card node under the same stage; its text identifies it.
    const watch = window.setInterval(() => {
      const el = topCard()
      const key = el?.textContent?.slice(0, 40) ?? ''
      if (key && key !== lastKey) {
        if (lastKey) {
          setRows([`--- promoted ---`])
          t0 = performance.now()
          framesLeft = 30
          cancelAnimationFrame(raf)
          raf = requestAnimationFrame(sample)
        }
        lastKey = key
      }
    }, 16)

    return () => {
      window.clearInterval(watch)
      cancelAnimationFrame(raf)
    }
  }, [host])

  return (
    <pre className="hMeasure">
      {rows.length === 0 ? 'swipe a card to trace the promotion' : rows.join('\n')}
    </pre>
  )
}

function StackMeasure({
  host,
  wantY
}: {
  host: HTMLElement | null
  wantY: readonly number[]
}): React.JSX.Element {
  const [rows, setRows] = useState<CardRect[]>([])

  useEffect(() => {
    if (!host) return
    const read = (): void => {
      const cards = [...host.querySelectorAll<HTMLElement>('.swipeDeckCard')]
      const stage = host.querySelector<HTMLElement>('.swipeDeckStage')
      const origin = stage?.getBoundingClientRect()
      if (!origin) {
        setRows([])
        return
      }
      const measured = cards
        .map((el) => {
          const r = el.getBoundingClientRect()
          const depth = Number(el.dataset.depth ?? '0')
          return {
            depth,
            w: r.width,
            h: r.height,
            cx: r.left - origin.left + r.width / 2,
            cy: r.top - origin.top + r.height / 2
          }
        })
        .sort((a, b) => a.depth - b.depth)
      const top = measured.find((m) => m.depth === 0)
      setRows(
        measured.map((m) => ({
          ...m,
          dy: top ? m.cy - top.cy : 0,
          dcx: top ? m.cx - top.cx : 0
        }))
      )
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(host)
    const id = window.setInterval(read, 400)
    return () => {
      ro.disconnect()
      window.clearInterval(id)
    }
  }, [host, wantY.join()])

  const ok =
    rows.length >= 2 &&
    rows.every((r) => {
      const want = wantY[r.depth] ?? 0
      return Math.abs(r.dcx) <= CX_SLACK_PX && Math.abs(r.dy - want) <= CY_SLACK_PX
    })

  return (
    <pre className="hMeasure" data-ok={ok ? '1' : rows.length ? '0' : undefined}>
      {rows.length === 0
        ? 'no cards yet'
        : [
            ok ? 'STACK OK' : 'STACK OFF',
            ...rows.map((r) => {
              const want = wantY[r.depth] ?? 0
              return `d${r.depth}  ${r.w.toFixed(0)}×${r.h.toFixed(0)}  Δx=${r.dcx.toFixed(0)} Δy=${r.dy.toFixed(0)}  want ${want}`
            })
          ].join('\n')}
    </pre>
  )
}

function TuneSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange: (n: number) => void
}): React.JSX.Element {
  return (
    <label className="hSlide">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="hSlideVal">
        {step < 1 ? value.toFixed(2) : value}
        {unit}
      </span>
    </label>
  )
}

/** The deck is `position: fixed` against the visual viewport, so each column
 *  needs a containing block of its own or both stack at the bottom of the page.
 *  `transform` on the stage creates one (same trick relay-harness uses). */
function DeckStage({
  skin,
  scenario,
  theme,
  tune,
  screen,
  island,
  islandScale,
  onEvent
}: {
  skin: Skin
  scenario: DeckScenario
  theme: 'light' | 'dark'
  tune?: StackTune
  screen: ScreenVariant
  island: IslandVariant
  islandScale: number
  onEvent: (line: string) => void
}): React.JSX.Element {
  // Remount on scenario change: the deck owns its own `order` state (a skip is
  // a local rearrangement), so switching fixtures without a fresh key would
  // leave the previous scenario's order in place.
  const deck = useMemo(
    () => buildDeck(scenario.sessions, scenario.requests, NOW),
    [scenario]
  )
  const suggestions = useMemo(
    () => (scenario.id === 'idle-suggestions' ? suggestionsFor(deck, CHIPS) : {}),
    [deck, scenario.id]
  )

  const onAffirm = (affirm: SwipeAffirm, card: SwipeCard): void => {
    onEvent(`${skin} · ${card.label} → ${JSON.stringify(affirm)}`)
  }

  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const wantY = [0, 14, 28] as const

  return (
    <>
      {skin === 'phone' && <StackMeasure host={host} wantY={wantY} />}
      {skin === 'phone' && <PromoteTrace host={host} />}
      {tune && (
        <style>{`
          .hColumn[data-skin='phone'] .swipeDeckCardBehind[data-depth='1'] {
            --deck-second-card-opacity: ${tune.o1};
            --deck-second-card-blur: ${tune.b1}px;
          }
          .hColumn[data-skin='phone'] .swipeDeckCardBehind[data-depth='2'] {
            --deck-second-card-opacity: ${tune.o2};
            --deck-second-card-blur: ${tune.b2}px;
          }
        `}</style>
      )}
      <div
        ref={setHost}
        className={`hDeckStage ${skin === 'phone' ? 'proRoot' : 'hDeckMac'}`}
        data-theme={theme}
      >
      <SwipeDeckSheet
        key={scenario.id}
        open
        deck={deck}
        suggestions={suggestions}
        onBack={skin === 'phone' ? () => onEvent('phone · back') : undefined}
        onClose={() => onEvent(`${skin} · close`)}
        onRequestSuggestions={(label, context) =>
          onEvent(`${skin} · ask suggestions ${label} :: ${context}`)
        }
        onAffirm={onAffirm}
        onOpenSession={(label) => onEvent(`${skin} · open session ${label}`)}
        onGoTo={(label) => onEvent(`${skin} · go to ${label}`)}
      />
      <ScreenVariantOverlay variant={screen} host={host} />
      <IslandVariantOverlay variant={island} host={host} scale={islandScale} />
      </div>
    </>
  )
}

/** The session strip: cards, and the detail sheet they open into. `SessionCard`
 *  and `SessionDetail` are both internal to `SessionList`, so the list IS the
 *  mount point for all three. The Mac's card is a separate fork living inside
 *  `CodePanel` and cannot be mounted standalone -- which is the duplication the
 *  port is meant to end, and why only one column renders here today. */
function SessionStage({
  scenario,
  theme,
  onEvent
}: {
  scenario: DeckScenario
  theme: 'light' | 'dark'
  onEvent: (line: string) => void
}): React.JSX.Element {
  return (
    <div className="hDeckStage proRoot" data-theme={theme}>
      <SessionList
        key={scenario.id}
        sessions={scenario.sessions}
        pending={scenario.requests}
        onReveal={(from) => onEvent(`sessions · reveal ${from}`)}
        onGoTo={(label) => onEvent(`sessions · go to ${label}`)}
        onReply={(label, text) => onEvent(`sessions · reply ${label}: ${text}`)}
        onArchive={(session) => { onEvent(`sessions · archive ${session.label}`); return true }}
      />
    </div>
  )
}

type Surface = 'deck' | 'sessions'

function scenarioFromUrl(): string {
  const want = new URLSearchParams(window.location.search).get('scenario')
  return SCENARIOS.some((s) => s.id === want) ? want! : SCENARIOS[0].id
}

function Harness(): React.JSX.Element {
  const [scenarioId, setScenarioId] = useState(scenarioFromUrl)
  const [surface, setSurface] = useState<Surface>('deck')
  // Light is the SHIPPED default (`CONFIG.PHONE_REMOTE.COLOR_SCHEME_DEFAULT`),
  // so it is what opens here. Dark is a real user setting, not a debug view.
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [log, setLog] = useState<string[]>([])
  const [tune, setTune] = useState(TUNE_DEFAULT)
  const [screen, setScreen] = useState<ScreenVariant>('off')
  const [island, setIsland] = useState<IslandVariant>('stacked')
  const [islandScale, setIslandScale] = useState(1)
  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0]

  const onEvent = (line: string): void => setLog((prev) => [line, ...prev].slice(0, 8))

  return (
    <div className="hPage">
      <header className="hPageHead">
        <h1>Swipe deck — phone and Mac</h1>
        <p>
          One <code>SwipeDeckSheet</code>, two skins, fixture decks built by the real{' '}
          <code>buildDeck</code>. No server, no Electron, no phone. Drag a card, or use the rail.
        </p>
        <div className="hTabs" role="tablist">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={s.id === scenarioId}
              className="hTab"
              data-active={s.id === scenarioId || undefined}
              onClick={() => {
                setScenarioId(s.id)
                const url = new URL(window.location.href)
                url.searchParams.set('scenario', s.id)
                history.replaceState(null, '', url)
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="hNote">{scenario.note}</p>
        <div className="hTabs hSurfaceTabs" role="tablist">
          {(['deck', 'sessions'] as Surface[]).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={s === surface}
              className="hTab"
              data-active={s === surface || undefined}
              onClick={() => setSurface(s)}
            >
              {s === 'deck' ? 'Swipe deck' : 'Session cards + detail'}
            </button>
          ))}
          <button
            className="hTab hThemeTab"
            onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          >
            {theme === 'light' ? '☀ Light (default)' : '☾ Dark'}
          </button>
        </div>
        <div className="hTabs" role="tablist">
          {SCREEN_VARIANTS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={v.id === screen}
              className="hTab"
              data-active={v.id === screen || undefined}
              onClick={() => setScreen(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <p className="hNote">
          {SCREEN_VARIANTS.find((v) => v.id === screen)?.note}
        </p>
        <div className="hTabs" role="tablist">
          {ISLAND_VARIANTS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={v.id === island}
              className="hTab"
              data-active={v.id === island || undefined}
              onClick={() => setIsland(v.id)}
            >
              {v.label}
            </button>
          ))}
          <span className="hIslandScale">
            <TuneSlider
              label="island scale"
              value={islandScale}
              min={0.6}
              max={1.8}
              step={0.05}
              unit="×"
              onChange={setIslandScale}
            />
          </span>
        </div>
        <p className="hNote">
          Island: {ISLAND_VARIANTS.find((v) => v.id === island)?.note}
        </p>
      </header>

      <div className="hColumns">
        {surface === 'deck' ? (
          <>
            <section className="hColumn" data-skin="phone">
              <div className="hColumnLabel">Phone — theme.css, 393px (iPhone 15)</div>
              <div className="hTune">
                <TuneSlider
                  label="d1 opacity"
                  value={tune.o1}
                  min={0}
                  max={1}
                  step={0.05}
                  unit=""
                  onChange={(o1) => setTune((t) => ({ ...t, o1 }))}
                />
                <TuneSlider
                  label="d2 opacity"
                  value={tune.o2}
                  min={0}
                  max={1}
                  step={0.05}
                  unit=""
                  onChange={(o2) => setTune((t) => ({ ...t, o2 }))}
                />
                <TuneSlider
                  label="d1 blur"
                  value={tune.b1}
                  min={0}
                  max={16}
                  step={0.5}
                  unit="px"
                  onChange={(b1) => setTune((t) => ({ ...t, b1 }))}
                />
                <TuneSlider
                  label="d2 blur"
                  value={tune.b2}
                  min={0}
                  max={16}
                  step={0.5}
                  unit="px"
                  onChange={(b2) => setTune((t) => ({ ...t, b2 }))}
                />
                <button className="hTab" type="button" onClick={() => setTune(TUNE_DEFAULT)}>
                  Reset
                </button>
              </div>
              <DeckStage
                skin="phone"
                scenario={scenario}
                screen={screen}
                island={island}
                islandScale={islandScale}
                theme={theme}
                tune={tune}
                onEvent={onEvent}
              />
            </section>
            <section className="hColumn" data-skin="mac">
              <div className="hColumnLabel">Mac — renderer index.css tokens, 560px</div>
              <DeckStage
                skin="mac"
                scenario={scenario}
                screen={screen}
                island="off"
                islandScale={1}
                theme={theme}
                onEvent={onEvent}
              />
            </section>
          </>
        ) : (
          <section className="hColumn" data-skin="phone">
            <div className="hColumnLabel">Phone — session cards, tap one for the detail sheet</div>
            <SessionStage scenario={scenario} theme={theme} onEvent={onEvent} />
          </section>
        )}
      </div>

      <section className="hLog">
        <div className="hColumnLabel">Events</div>
        {log.length === 0 ? (
          <p className="hNote">Nothing yet. Swipe or tap a card.</p>
        ) : (
          <ul>
            {log.map((line, i) => (
              <li key={`${line}-${i}`}>{line}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// Cache the root on the container: Vite re-runs this module on every hot update,
// and a second `createRoot` on the same node stacks a duplicate React tree.
const container = document.getElementById('root')! as HTMLElement & { _root?: Root }
container._root ??= createRoot(container)
container._root.render(
  <StrictMode>
    <Harness />
  </StrictMode>
)
