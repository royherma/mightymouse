import { JSX } from 'react'
import { CONFIG } from '../../../../shared/config'
import { Switch } from '../Switch'
import { Button } from '../Button'
import { SECTIONS, BUCKETS } from './registry'
import { Section, SettingRow } from './sections'
import { EyeOff } from 'lucide-react'
import { cardCls, bucketCls } from './settings-consts'
import type { SettingsCtx } from './settings-state'

export function PrivacyPage({ s }: { s: SettingsCtx }): JSX.Element {
  const {
    query,
    feedbackEnabled,
    agentPhotos,
    decisionCards,
    historyEncryption,
    incognito,
    collapse,
    showBucketHeader,
    toggleFeedback,
    toggleAgentPhotos,
    toggleDecisionCards,
    toggleIncognito,
    toggleHistoryEncryption,
    clearHistory
  } = s
  return (
    <>
      {showBucketHeader(BUCKETS.privacy) && <div className={bucketCls}>Privacy & data</div>}

      {/* Feedback & learning */}
      <Section
        sectionKey="feedback"
        title={SECTIONS.feedback.title}
        keywords={SECTIONS.feedback.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title={CONFIG.UI_LABELS.FEEDBACK_LEARNING}
            control={<Switch on={feedbackEnabled} onChange={toggleFeedback} />}
          >
            <div className="text-muted text-sm">{CONFIG.UI_LABELS.FEEDBACK_LEARNING_HINT}</div>
          </SettingRow>
        </div>
      </Section>

      {/* Photo access for agents */}
      <Section
        sectionKey="agentPhotos"
        title={SECTIONS.agentPhotos.title}
        keywords={SECTIONS.agentPhotos.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title={CONFIG.UI_LABELS.AGENT_PHOTOS}
            control={<Switch on={agentPhotos} onChange={toggleAgentPhotos} />}
          >
            <div className="text-muted text-sm">{CONFIG.UI_LABELS.AGENT_PHOTOS_HINT}</div>
          </SettingRow>
        </div>
      </Section>

      <Section
        sectionKey="decisionCards"
        title={SECTIONS.decisionCards.title}
        keywords={SECTIONS.decisionCards.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title={CONFIG.UI_LABELS.DECISION_CARDS}
            control={<Switch on={decisionCards} onChange={toggleDecisionCards} />}
          >
            <div className="text-muted text-sm">{CONFIG.UI_LABELS.DECISION_CARDS_HINT}</div>
          </SettingRow>
        </div>
      </Section>

      <Section
        sectionKey="incognito"
        title={SECTIONS.incognito.title}
        keywords={SECTIONS.incognito.keywords}
        query={query}
        collapse={collapse}
      >
        <div
          className={cardCls}
          style={
            incognito
              ? {
                  borderColor: 'var(--amber-border-subtle)',
                  background: 'var(--amber-bg-subtle)'
                }
              : undefined
          }
        >
          <SettingRow
            title={
              <div className="flex items-center gap-2">
                <div className="font-semibold text-lg">Incognito mode</div>
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide"
                  style={
                    incognito
                      ? {
                          color: 'var(--amber)',
                          background: 'var(--amber-bg-subtle)',
                          border: '1px solid var(--amber-border-subtle)'
                        }
                      : {
                          color: 'var(--muted)',
                          background: 'var(--surface2)',
                          border: '1px solid var(--surface3)'
                        }
                  }
                >
                  {incognito ? <EyeOff size={11} strokeWidth={2.5} /> : null}
                  {incognito ? 'On · not logging' : 'Off'}
                </span>
              </div>
            }
            control={<Switch on={incognito} onChange={toggleIncognito} />}
          >
            <div className="text-muted text-sm">
              Stop saving everything. While this is on, nothing you do is written to your history,
              logs, or the cloud. Your existing history stays put. Turn it off to start saving
              again.
            </div>
          </SettingRow>
        </div>
      </Section>

      {/* Privacy: encrypt history + clear history */}
      <Section
        sectionKey="privacy"
        title={SECTIONS.privacy.title}
        keywords={SECTIONS.privacy.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title={<>Encrypt &amp; clear history</>}
            control={<Switch on={historyEncryption} onChange={toggleHistoryEncryption} />}
          >
            <div className="text-muted text-sm">
              Lock your saved history on this Mac so backups and other apps can not read it. We save
              a copy first, so turning this on or off never loses anything.
            </div>
          </SettingRow>
          <div className="mt-4 pt-4 border-t border-surface3">
            <SettingRow
              title="Clear history"
              control={
                <Button variant="ghost" onClick={clearHistory}>
                  Clear
                </Button>
              }
            >
              <div className="text-muted text-sm">
                Delete everything you have asked and gotten back. A backup is saved first.
              </div>
            </SettingRow>
          </div>
        </div>
      </Section>
    </>
  )
}
