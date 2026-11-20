import { JSX } from 'react'
import { CONFIG } from '../../../../shared/config'
import { visibleCursorStyles } from '../../../../shared/cursor-styles'
import { LanguagePicker } from './LanguagePicker'
import { Switch } from '../Switch'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { SegmentedControl } from '../SegmentedControl'
import { ActionsSettingsSection } from '../ActionsSettingsSection'
import { SECTIONS, BUCKETS } from './registry'
import { Section, SettingRow } from './sections'
import { CursorStyleCard } from './SettingsUi'
import { cardCls, bucketCls } from './settings-consts'
import type { SettingsCtx } from './settings-state'

export function CapturePage({ s }: { s: SettingsCtx }): JSX.Element {
  const {
    state,
    query,
    whisperLang,
    holdForSmart,
    cursorCompanion,
    cursorStyle,
    suggestions,
    fnListenEnabled,
    clickEnabled,
    actHighlight,
    voiceRoutingMode,
    voiceRoutingGoTo,
    voiceRoutingSkills,
    voiceRoutingAgents,
    advancedMenu,
    collapse,
    showBucketHeader,
    apply,
    toggleCursorCompanion,
    chooseCursorStyle,
    toggleSuggestions,
    toggleClickEnabled,
    toggleActHighlight,
    grantAccessibility,
    pickVoiceRoutingMode,
    toggleVoiceRoutingGoTo,
    toggleVoiceRoutingSkills,
    toggleVoiceRoutingAgents,
    toggleHoldForSmart,
    saveLanguage
  } = s
  return (
    <>
      {showBucketHeader(BUCKETS.capture) && <div className={bucketCls}>Capture</div>}

      <Section
        sectionKey="dictation"
        title={SECTIONS.dictation.title}
        keywords={SECTIONS.dictation.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <div className="text-sm text-muted">What MightyMouse listens for when you dictate.</div>
          <LanguagePicker
            state={state}
            value={whisperLang}
            onChange={saveLanguage}
            onDownloaded={apply}
          />
          <SettingRow
            className="mt-4 pt-4 border-t border-surface3"
            title="Hold the listen key to write for the screen"
            control={<Switch on={holdForSmart} onChange={toggleHoldForSmart} />}
          >
            <div className="text-muted text-sm">
              Hold it 3 seconds and MightyMouse rewrites what you said to fit the app you're in.
            </div>
          </SettingRow>
        </div>
      </Section>

      {/* Cursor Companion */}
      <Section
        sectionKey="cursor"
        title={SECTIONS.cursor.title}
        keywords={SECTIONS.cursor.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title="Animated pointer"
            control={<Switch on={cursorCompanion} onChange={toggleCursorCompanion} />}
          >
            <div className="text-muted text-sm">
              Show a glowing pointer that follows your cursor across the screen.
            </div>
          </SettingRow>

          {cursorCompanion && (
            <div className="mt-4 pt-4 border-t border-surface3">
              <div className="font-semibold text-md mb-2">Pointer style</div>
              {/* Horizontally scrolling preview cards — pick by look, not name. */}
              <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 cursor-style-row">
                {visibleCursorStyles(advancedMenu).map((s) => (
                  <CursorStyleCard
                    key={s.id}
                    meta={s}
                    active={s.id === cursorStyle}
                    onPick={() => chooseCursorStyle(s.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* Click to act — admin-only (needs Accessibility + auto-clicks; not for the
          simple view). Let an Ask answer move + click a spot on screen. Off by
          default. The pointer (point-at) always works; this only adds the real click. */}
      {advancedMenu && (
        <Section
          sectionKey="click"
          title={SECTIONS.click.title}
          keywords={SECTIONS.click.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={
                <>
                  Click to act <Badge color="violet">Admin</Badge>
                </>
              }
              control={<Switch on={clickEnabled} onChange={toggleClickEnabled} />}
            >
              <div className="text-muted text-sm">
                Let an answer point at a spot and actually click it for you. Without this it only
                points. Needs Accessibility.
              </div>
              {clickEnabled &&
                (() => {
                  // Surface the real Accessibility grant whenever clicking is on, so
                  // the user can SEE and FIX it here — clicks silently no-op without
                  // it. Granted → a green confirm chip; missing → amber chip + a
                  // Grant button that fires the OS prompt and refreshes live.
                  const granted =
                    state.permissions.find((p) => p.key === 'accessibility')?.status === 'granted'
                  return (
                    <div className="flex items-center gap-2 mt-2">
                      <Badge color={granted ? 'green' : 'amber'}>
                        {granted ? '✓ Accessibility granted' : 'Accessibility needed'}
                      </Badge>
                      {!granted && (
                        <Button variant="ghost" onClick={grantAccessibility}>
                          Grant
                        </Button>
                      )}
                    </div>
                  )
                })()}
            </SettingRow>
          </div>
        </Section>
      )}

      {/* Act highlight — flashes a dashed box around where act mode is about to
          click/type/drag, so a real screen action never happens with zero
          warning. On by default. Independent of Click to act — it observes the
          CLI's own mm-input calls, it doesn't gate them. */}
      <Section
        sectionKey="actHighlight"
        title={SECTIONS.actHighlight.title}
        keywords={SECTIONS.actHighlight.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title={CONFIG.UI_LABELS.SHOW_BEFORE_ACTING}
            control={<Switch on={actHighlight} onChange={toggleActHighlight} />}
          >
            <div className="text-muted text-sm">{CONFIG.UI_LABELS.SHOW_BEFORE_ACTING_HINT}</div>
          </SettingRow>
        </div>
      </Section>

      <Section
        sectionKey="actions"
        title={SECTIONS.actions.title}
        keywords={SECTIONS.actions.keywords}
        query={query}
        collapse={collapse}
      >
        <ActionsSettingsSection />
      </Section>

      <Section
        sectionKey="voiceRouting"
        title={SECTIONS.voiceRouting.title}
        keywords={SECTIONS.voiceRouting.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title={
              <>
                Action routing <Badge color="blue">Experimental</Badge>
              </>
            }
          >
            <div className="text-muted text-sm">
              After you dictate, {CONFIG.PRODUCT_NAME} looks at the apps you have open and offers
              the one your words most likely belong in. Pick it and the text is pasted there. Your
              words are never rewritten.
            </div>
            <SegmentedControl
              items={[
                { id: 'off', label: 'Off' },
                { id: 'hover', label: 'With a button' },
                { id: 'always', label: 'Always' }
              ]}
              active={voiceRoutingMode}
              onChange={(m) => void pickVoiceRoutingMode(m)}
              className="mt-3 max-w-[420px]"
            />
            <div className="text-muted text-sm">
              {voiceRoutingMode === 'hover'
                ? 'Your words are pasted as usual. A small round button shows on the bottom-left corner of the transcript card - click it and you get the list of places to send it instead.' +
                  (fnListenEnabled
                    ? ' Already know it belongs somewhere else? Hold fn and tap Option while you record, and the list opens by itself when you stop.'
                    : '')
                : voiceRoutingMode === 'always'
                  ? 'Every dictation opens the list of places to send it.'
                  : 'Dictation pastes into whatever app you are in.'}
            </div>
          </SettingRow>

          {voiceRoutingMode !== 'off' && (
            <SettingRow
              className="mt-4 pt-4 border-t border-surface3"
              title={<>Offer &quot;go there&quot;</>}
              control={<Switch on={voiceRoutingGoTo} onChange={toggleVoiceRoutingGoTo} />}
            >
              <div className="text-muted text-sm">
                Adds a second button that pastes and then leaves you in that app, instead of
                returning you to what you were doing.
              </div>
            </SettingRow>
          )}

          {voiceRoutingMode !== 'off' && (
            <SettingRow
              className="mt-4 pt-4 border-t border-surface3"
              title="Send to a skill"
              control={<Switch on={voiceRoutingSkills} onChange={toggleVoiceRoutingSkills} />}
            >
              <div className="text-muted text-sm">
                Say what you want and pick the skill that does it - it runs straight away, with what
                you said as the instruction.
              </div>
            </SettingRow>
          )}

          {voiceRoutingMode !== 'off' && (
            <SettingRow
              className="mt-4 pt-4 border-t border-surface3"
              title="Send to a coding agent"
              control={<Switch on={voiceRoutingAgents} onChange={toggleVoiceRoutingAgents} />}
            >
              <div className="text-muted text-sm">
                Talk to an agent that is already running without finding its window first - your
                words go into its prompt and it starts.
              </div>
            </SettingRow>
          )}
        </div>
      </Section>

      {/* Suggestions — advanced-only (power knob, not for the simple view) */}
      {advancedMenu && (
        <Section
          sectionKey="suggestions"
          title={SECTIONS.suggestions.title}
          keywords={SECTIONS.suggestions.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={
                <>
                  Suggestions <Badge color="violet">Admin</Badge>
                </>
              }
              control={<Switch on={suggestions} onChange={toggleSuggestions} />}
            >
              <div className="text-muted text-sm">
                Pop a small bubble near your cursor with the best next move. Fires when you pause,
                or any time you press the suggest shortcut.
              </div>
            </SettingRow>
          </div>
        </Section>
      )}

      {/* Sound effects + Capture HUD — plain preferences, everyone gets them.
          Were admin-gated until 2026-07-22 by an {advancedMenu} FRAGMENT that
          wrapped both; neither is admin-worthy on its own. */}

      {/* Talk out loud — opens the companion overlay and turns on the mic loop.
          The overlay has no other entry point, so this switch is how it exists. */}

      {/* Auto-paste + Feedback + Ambient context log + Run details. Auto-paste
          is core dictation UX; the rest are ordinary preferences. All four were
          admin-gated until 2026-07-22 by one {advancedMenu} FRAGMENT wrapping
          the group — inherited gating, never a per-section decision. */}

      {/* Show run details — the Run Transcript Inspector. When on, a finished/
          running HUD card gets an expand icon that opens the full-screen
          timeline of every tool call, thought, and token usage. Debug surface. */}

      {/* Privacy: incognito (master off switch). When ON, the card flips to an
          amber active state + status badge so the privacy mode is unmistakable. */}

      {/* Permissions moved to the title-bar button (one-time setup; the tray
          also auto-warns when a required permission is missing). */}
    </>
  )
}
