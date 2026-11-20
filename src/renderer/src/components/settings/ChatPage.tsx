import { JSX } from 'react'
import { CONFIG } from '../../../../shared/config'
import { ChatPrefs } from '../../mighty/MightySecondaryTabs'
import { MightyMacAlerts } from '../../mighty/MightyMacAlerts'
import { PulseSetting } from '../session-pulse-mac'
import { AllProjectsModal } from '../../mighty/AllProjectsModal'
import { Switch } from '../Switch'
import { Button } from '../Button'
import { SECTIONS, BUCKETS } from './registry'
import { Section, SettingRow } from './sections'
import { cardCls, bucketCls } from './settings-consts'
import type { SettingsCtx } from './settings-state'

export function ChatPage({ s }: { s: SettingsCtx }): JSX.Element {
  const {
    query,
    projectsOpen,
    setProjectsOpen,
    codeOwnCopy,
    collapse,
    showBucketHeader,
    toggleCodeOwnCopy,
    chat
  } = s
  return (
    <>
      {showBucketHeader(BUCKETS.chat) && <div className={bucketCls}>Chat</div>}

      <Section
        sectionKey="chat"
        title={SECTIONS.chat.title}
        keywords={SECTIONS.chat.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <ChatPrefs
            onNameChange={chat.onNameChange}
            onTabNameFormatChange={chat.onTabNameFormatChange}
          />
        </div>
      </Section>

      <Section
        sectionKey="projects"
        title={SECTIONS.projects.title}
        keywords={SECTIONS.projects.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <Button variant="ghost" onClick={() => setProjectsOpen(true)}>
            {CONFIG.UI_LABELS.SETTINGS_OPEN_PROJECTS}
          </Button>
        </div>
        <div className={cardCls}>
          <SettingRow
            title="Give each new Code conversation its own copy"
            control={<Switch on={codeOwnCopy} onChange={toggleCodeOwnCopy} />}
          >
            <div className="text-muted text-sm">
              Agents working on the same project at once never overwrite each other&apos;s files.
              Each copy starts from your last commit, on its own branch.
            </div>
          </SettingRow>
        </div>
        {projectsOpen && (
          <AllProjectsModal
            onClose={() => setProjectsOpen(false)}
            onChanged={chat.onProjectsChanged}
          />
        )}
      </Section>

      <Section
        sectionKey="alerts"
        title={SECTIONS.alerts.title}
        keywords={SECTIONS.alerts.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <MightyMacAlerts />
          <PulseSetting />
        </div>
      </Section>
    </>
  )
}
