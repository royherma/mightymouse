import { JSX } from 'react'
import { CONFIG } from '../../shared/config'
import { LoadingBody } from './WindowFrame'
import { type ChatSettingsHooks } from './mighty/MightySecondaryTabs'
import { Button } from './components/Button'
import {
  SIDEBAR_WIDTH_PX,
  CONTENT_WIDTH_PX,
  BUCKET_TITLES,
  type BucketKey
} from './components/settings/registry'
import { SettingsSidebar, SidebarToggle } from './components/settings/SettingsSidebar'
import { Search, X } from 'lucide-react'
import { useSettingsState, type SettingsCtx } from './components/settings/settings-state'
import { PhoneRemotePage } from './components/settings/PhoneRemotePage'
import { EssentialsPage } from './components/settings/EssentialsPage'
import { ChatPage } from './components/settings/ChatPage'
import { CapturePage } from './components/settings/CapturePage'
import { GeneralPage } from './components/settings/GeneralPage'
import { PrivacyPage } from './components/settings/PrivacyPage'
import { AdvancedPage } from './components/settings/AdvancedPage'

export { MODELS } from './components/settings/settings-consts'

type Page = (props: { s: SettingsCtx }) => JSX.Element
const PAGES: Page[] = [
  PhoneRemotePage,
  EssentialsPage,
  ChatPage,
  CapturePage,
  GeneralPage,
  PrivacyPage,
  AdvancedPage
]
const PAGE_OF: Record<BucketKey, Page> = {
  phoneRemote: PhoneRemotePage,
  essentials: EssentialsPage,
  chat: ChatPage,
  projects: ChatPage,
  capture: CapturePage,
  general: GeneralPage,
  privacy: PrivacyPage,
  advanced: AdvancedPage
}

export default function SettingsApp(props: {
  onBack?: () => void
  chat: ChatSettingsHooks
}): JSX.Element {
  const s = useSettingsState(props)
  if (!s) return <LoadingBody label="Loading settings…" />
  const {
    state,
    query,
    setQuery,
    sidebarShown,
    toggleSidebar,
    scrollRef,
    openPage,
    searchOpen,
    searchInputRef,
    phoneRemoteSupported,
    isAdmin,
    viewAsUser,
    advancedMenu,
    simple,
    shownPage,
    paged,
    account,
    setAccount,
    showDebug,
    setShowDebug,
    jumpToSection,
    openSearch,
    closeSearch,
    anyResults,
    headerLinks,
    sidebarLinks,
    viewAsUserRow
  } = s
  const CurrentPage = PAGE_OF[shownPage]

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
      {sidebarShown && (
        <SettingsSidebar
          query={query}
          page={paged ? shownPage : null}
          onPage={openPage}
          advancedMenu={advancedMenu}
          phoneRemoteSupported={phoneRemoteSupported}
          simple={simple}
          onJump={jumpToSection}
          footer={sidebarLinks}
        />
      )}
      <div
        className="px-6 pb-6 pt-5"
        style={{
          maxWidth: CONTENT_WIDTH_PX,
          marginLeft: sidebarShown
            ? `max(${SIDEBAR_WIDTH_PX}px, calc((100% + ${SIDEBAR_WIDTH_PX - CONTENT_WIDTH_PX}px) / 2))`
            : 'auto',
          marginRight: 'auto'
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1
              className="text-display font-bold mb-1.5 select-none"
              onDoubleClick={() => setShowDebug((v) => !v)}
              title={showDebug ? undefined : 'Double-click for debug info'}
            >
              {paged ? BUCKET_TITLES[shownPage] : CONFIG.UI_LABELS.SETTINGS}
            </h1>
            {state.recording && <p className="text-muted text-md mb-5">🔴 recording in progress</p>}
            {showDebug && (
              <p className="text-muted text-sm mb-5 font-mono">
                Platform: {state.platform} · v{CONFIG.APP_VERSION}
                {account && (
                  <>
                    {' '}
                    · {account.email} · {account.userId}
                  </>
                )}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0 mt-1">
            <SidebarToggle shown={sidebarShown} onToggle={toggleSidebar} />
            <Button
              variant="icon"
              aria-label="Search settings"
              title="Search settings (⌘F)"
              className="flex items-center justify-center bg-transparent border border-surface3 text-muted rounded-sm cursor-pointer transition-colors hover:bg-surface2 hover:text-on-surface"
              onClick={() => (searchOpen ? closeSearch() : openSearch())}
            >
              <Search size={14} strokeWidth={2.25} />
            </Button>
            {!sidebarShown && headerLinks}
          </div>
        </div>

        {/* Search — collapsed to a title-bar icon by default (no vertical space).
            When opened it pins as a sticky bar under the title bar so it stays
            reachable while scrolling. Matches section titles + synonyms. */}
        {searchOpen && (
          <div className="sticky top-0 z-[5] -mx-6 px-6 py-2.5 mb-3 bg-bg/95 backdrop-blur border-b border-surface2">
            <div className="relative">
              <Search
                size={16}
                strokeWidth={2.25}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
              />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings…"
                aria-label="Search settings"
                className="w-full bg-surface2 border border-surface3 rounded-md text-on-surface pl-9 pr-9 py-2 text-md outline-none transition-colors focus:border-accent focus:shadow-focus placeholder:text-muted"
              />
              <Button
                variant="icon"
                aria-label="Close search"
                onClick={closeSearch}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center justify-center text-muted hover:text-on-surface cursor-pointer bg-transparent border-0"
              >
                <X size={15} strokeWidth={2.25} />
              </Button>
            </div>
          </div>
        )}

        {isAdmin && viewAsUser && viewAsUserRow}

        {paged ? <CurrentPage s={s} /> : PAGES.map((Page) => <Page key={Page.name} s={s} />)}

        {/* No-match hint — only when a query is typed and nothing survived the filter. */}
        {query.trim() && !anyResults && (
          <div className="text-center text-muted text-md py-10">
            No settings match “{query.trim()}”.
          </div>
        )}

        {/* Sign out — always pinned at the bottom of the panel (not inside the
            Account section). Only shown when signed in and not searching. */}
        {!query.trim() && account && (!paged || shownPage === 'essentials') && (
          <div className="mt-6">
            <Button
              className="w-full"
              onClick={async () => {
                await window.api.auth.signOut()
                setAccount(null)
              }}
            >
              Sign out
            </Button>
          </div>
        )}

        {/* Version footer */}
        <div className="text-center text-muted text-sm mt-4 pb-2">
          {CONFIG.BRAND_NAME} v{CONFIG.APP_VERSION}
        </div>
      </div>
    </div>
  )
}
