import { JSX } from 'react'
import { CONFIG } from '../../../../shared/config'
import { Switch } from '../Switch'
import { SegmentedControl } from '../SegmentedControl'
import { Button } from '../Button'
import { KokoroVoiceCard } from '../KokoroVoiceCard'
import { SECTIONS, BUCKETS, SECTION_ANCHOR_ID } from './registry'
import { Section, SettingRow } from './sections'
import { TRANSCRIPT_FORMATS } from '../../../../shared/transcript-format'
import { cardCls, bucketCls } from './settings-consts'
import type { SettingsCtx } from './settings-state'

export function GeneralPage({ s }: { s: SettingsCtx }): JSX.Element {
  const {
    query,
    soundEnabled,
    dynamicIsland,
    selectionBar,
    liveCompanion,
    liveActs,
    companionQuiet,
    companionModel,
    dockIcon,
    fnListenEnabled,
    listenAutoPaste,
    transcriptFormats,
    advancedMenu,
    collapse,
    showBucketHeader,
    toggleSound,
    toggleDynamicIsland,
    toggleSelectionBar,
    toggleLiveCompanion,
    toggleLiveActs,
    toggleCompanionQuiet,
    chooseCompanionModel,
    toggleDockIcon,
    toggleFnListen,
    toggleTranscriptFormat,
    toggleListenAutoPaste
  } = s
  return (
    <>
      {showBucketHeader(BUCKETS.general) && <div className={bucketCls}>General</div>}

      <Section
        sectionKey="sound"
        title={SECTIONS.sound.title}
        keywords={SECTIONS.sound.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title="Sound effects"
            control={<Switch on={soundEnabled} onChange={toggleSound} />}
          >
            <div className="text-muted text-sm">A soft chime when things finish.</div>
          </SettingRow>
        </div>
      </Section>

      {/* Dynamic Island */}
      <Section
        sectionKey="island"
        title={SECTIONS.island.title}
        keywords={SECTIONS.island.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title="Dynamic Island"
            control={<Switch on={dynamicIsland} onChange={toggleDynamicIsland} />}
          >
            <div className="text-muted text-sm">{CONFIG.UI_LABELS.DYNAMIC_ISLAND_HINT}</div>
          </SettingRow>
        </div>
      </Section>

      {CONFIG.SELECTION_BAR.ENABLED && (
        <Section
          sectionKey="selectionBar"
          title={SECTIONS.selectionBar.title}
          keywords={SECTIONS.selectionBar.keywords}
          query={query}
          collapse={collapse}
          anchorId={SECTION_ANCHOR_ID.selectionBar}
        >
          <div className={cardCls}>
            <SettingRow
              title={CONFIG.UI_LABELS.SELECTION_BAR}
              control={<Switch on={selectionBar} onChange={toggleSelectionBar} />}
            >
              <div className="text-muted text-sm">{CONFIG.UI_LABELS.SELECTION_BAR_HINT}</div>
            </SettingRow>
          </div>
        </Section>
      )}

      {/* `|| liveCompanion` so a conversation already running keeps its End
          button — hiding the card mid-conversation strands it. */}
      {(advancedMenu || liveCompanion) && (
        <Section
          sectionKey="voice"
          title={SECTIONS.voice.title}
          keywords={SECTIONS.voice.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            {/* Not a preference toggle: a conversation is a thing you START and
            END, so the control says so. There is no "voice mode is on" state
            to sit in — either you are talking to it or you are not. */}
            <SettingRow
              title={SECTIONS.voice.title}
              control={
                <Button
                  variant={liveCompanion ? 'ghost' : 'primary'}
                  onClick={() => toggleLiveCompanion(!liveCompanion)}
                >
                  {liveCompanion ? 'End' : 'Start'}
                </Button>
              }
            >
              <div className="text-muted text-sm">{CONFIG.UI_LABELS.LIVE_COMPANION_HINT}</div>
            </SettingRow>

            {/* The one thing worth deciding BEFORE you start talking: whether it
            may touch your Mac. Shown whether or not a conversation is running,
            because it is the answer to "is this safe to try?" — the question
            people have before they press Start, not after. */}
            <div className="mt-4 pt-4 border-t border-surface3">
              <SettingRow
                title="Let it use your Mac"
                control={<Switch on={liveActs} onChange={toggleLiveActs} />}
              >
                <div className="text-muted text-sm">
                  It can click and type for you to get things done. Turn this off and it only
                  answers out loud, and never touches anything.
                </div>
              </SettingRow>
            </div>

            <div className="mt-4 pt-4 border-t border-surface3">
              <SettingRow
                title="Hide until you say &quot;Hey Mighty&quot;"
                control={<Switch on={companionQuiet} onChange={toggleCompanionQuiet} />}
              >
                <div className="text-muted text-sm">
                  Always ready while {CONFIG.PRODUCT_NAME} is open. Nothing on screen until you
                  call it.
                </div>
              </SettingRow>
            </div>

            <div className="mt-4 pt-4 border-t border-surface3">
              <SettingRow
                title="Brain"
                control={
                  <SegmentedControl<string>
                    items={CONFIG.VOICE_MODELS.map((m) => ({ id: m.id, label: m.label }))}
                    active={companionModel}
                    onChange={chooseCompanionModel}
                    textSize="text-xs"
                  />
                }
              >
                <div className="text-muted text-sm">
                  Which Claude answers when you talk. Opus clicks in the right place most often.
                </div>
              </SettingRow>
            </div>

            {/* Voice picker only matters once the loop is on — it has nothing to
            say about a companion that never speaks. */}
            {liveCompanion && (
              <div className="mt-4 pt-4 border-t border-surface3">
                <KokoroVoiceCard />
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Show in Dock */}
      <Section
        sectionKey="dockIcon"
        title={SECTIONS.dockIcon.title}
        keywords={SECTIONS.dockIcon.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title="Show in Dock"
            control={<Switch on={dockIcon} onChange={toggleDockIcon} />}
          >
            <div className="text-muted text-sm">
              Add a Dock icon so you can click to open. Also puts {CONFIG.PRODUCT_NAME} in the app
              switcher. The menu bar icon stays either way.
            </div>
          </SettingRow>
        </div>
      </Section>

      <Section
        sectionKey="fnListen"
        title={SECTIONS.fnListen.title}
        keywords={SECTIONS.fnListen.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title={CONFIG.UI_LABELS.FN_LISTEN}
            control={<Switch on={fnListenEnabled} onChange={toggleFnListen} />}
          >
            <div className="text-muted text-sm">{CONFIG.UI_LABELS.FN_LISTEN_HINT}</div>
          </SettingRow>
        </div>
      </Section>

      <Section
        sectionKey="autoPaste"
        title={SECTIONS.autoPaste.title}
        keywords={SECTIONS.autoPaste.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title={CONFIG.UI_LABELS.AUTO_PASTE}
            control={<Switch on={listenAutoPaste} onChange={toggleListenAutoPaste} />}
          >
            <div className="text-muted text-sm">{CONFIG.UI_LABELS.AUTO_PASTE_HINT}</div>
          </SettingRow>
          {TRANSCRIPT_FORMATS.map((f) => (
            <SettingRow
              key={f.id}
              title={f.title}
              control={
                <Switch
                  on={transcriptFormats[f.id] ?? f.defaultOn}
                  onChange={(next) => void toggleTranscriptFormat(f.id, next)}
                />
              }
            >
              <div className="text-muted text-sm">{f.hint}</div>
            </SettingRow>
          ))}
        </div>
      </Section>
    </>
  )
}
