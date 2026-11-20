import { Fragment, JSX } from 'react'
import { CONFIG } from '../../../../shared/config'
import { parakeetCanTranscribe } from '../../../../shared/whisper-languages'
import {
  RELAY_PUSH_VERBS,
  RELAY_PUSH_LABELS,
  RELAY_PUSH_FOOTNOTE,
  RELAY_NOTIFY_LEVEL_LABEL,
  RELAY_NOTIFY_LEVEL_HINT,
  RELAY_TURN_END_LABEL,
  RELAY_TURN_END_HINT
} from '../../../../shared/relay-push-filter'
import { Switch } from '../Switch'
import { Button } from '../Button'
import { ProgressBar } from '../ProgressBar'
import { SECTIONS, BUCKETS, SECTION_ANCHOR_ID } from './registry'
import { Section, SettingRow } from './sections'
import { relayStatusLine, listNames } from '../../../../shared/relay-status'
import { UpdateBadge, CopySnippet, StorageRow, DeviceSelect, BinRow } from './SettingsUi'
import {
  cardCls,
  inputCls,
  OVERRIDE_PATH_PLACEHOLDER,
  bucketCls,
  UPDATE_STATUS_TEXT
} from './settings-consts'
import type { SettingsCtx } from './settings-state'

export function AdvancedPage({ s }: { s: SettingsCtx }): JSX.Element {
  const {
    state,
    ffmpegInstallHint,
    query,
    showNotes,
    setShowNotes,
    busy,
    dlPct,
    installLine,
    msg,
    ffmpeg,
    setFfmpeg,
    whisper,
    setWhisper,
    whisperModel,
    setWhisperModel,
    videoDevice,
    setVideoDevice,
    audioDevice,
    setAudioDevice,
    smallPanel,
    advancedMode,
    maxRecMin,
    setMaxRecMin,
    captureHud,
    contextLog,
    runTranscript,
    showTiming,
    agentRelay,
    relayPush,
    agentRelayTestState,
    mcpClients,
    mcpClientError,
    showManualSnippet,
    setShowManualSnippet,
    isAdmin,
    viewAsUser,
    advancedMenu,
    shownPage,
    paged,
    collapse,
    showBucketHeader,
    update,
    checking,
    refresh,
    checkForUpdates,
    commitMaxRec,
    toggleCaptureHud,
    toggleSmallPanel,
    toggleAgentRelay,
    toggleRelayPush,
    setRelayNotifyLevel,
    setRelayTurnEndPing,
    sendAgentRelayTest,
    setUpMcpClient,
    toggleShowTiming,
    toggleContextLog,
    toggleRunTranscript,
    save,
    downloadModel,
    installWhisper,
    installFfmpeg,
    ffmpegBin,
    whisperBin,
    modelBin,
    parakeetBin,
    anyResults,
    viewAsUserRow
  } = s
  return (
    <>
      {showBucketHeader(BUCKETS.advanced) && <div className={bucketCls}>Advanced</div>}
      {isAdmin &&
        !viewAsUser &&
        !query.trim() &&
        (!paged || shownPage === 'advanced') &&
        viewAsUserRow}

      {/* Recording */}
      <Section
        sectionKey="recording"
        title={SECTIONS.recording.title}
        keywords={SECTIONS.recording.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title={CONFIG.UI_LABELS.SCREEN_RECORDING_MAX}
            control={
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0.1}
                  step={0.5}
                  className={`${inputCls} w-20 text-right`}
                  value={maxRecMin}
                  onChange={(e) => setMaxRecMin(Number(e.target.value))}
                  onBlur={(e) => commitMaxRec(Number(e.target.value))}
                />
                <span className="text-muted text-sm">min</span>
              </div>
            }
          >
            <div className="text-muted text-sm">{CONFIG.UI_LABELS.SCREEN_RECORDING_MAX_HINT}</div>
          </SettingRow>
        </div>
      </Section>

      <Section
        sectionKey="captureHud"
        title={SECTIONS.captureHud.title}
        keywords={SECTIONS.captureHud.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title={CONFIG.UI_LABELS.CAPTURE_HUD}
            control={<Switch on={captureHud} onChange={toggleCaptureHud} />}
          >
            <div className="text-muted text-sm">{CONFIG.UI_LABELS.CAPTURE_HUD_HINT}</div>
          </SettingRow>
        </div>
      </Section>

      <Section
        sectionKey="showTiming"
        title={SECTIONS.showTiming.title}
        keywords={SECTIONS.showTiming.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title={CONFIG.UI_LABELS.SHOW_TIMING}
            control={<Switch on={showTiming} onChange={toggleShowTiming} />}
          >
            <div className="text-muted text-sm">{CONFIG.UI_LABELS.SHOW_TIMING_HINT}</div>
          </SettingRow>
        </div>
      </Section>

      {/* Ambient context log */}
      <Section
        sectionKey="contextLog"
        title={SECTIONS.contextLog.title}
        keywords={SECTIONS.contextLog.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title={CONFIG.UI_LABELS.CONTEXT_LOG}
            control={<Switch on={contextLog} onChange={toggleContextLog} />}
          >
            <div className="text-muted text-sm">{CONFIG.UI_LABELS.CONTEXT_LOG_HINT}</div>
          </SettingRow>
        </div>
      </Section>

      <Section
        sectionKey="runTranscript"
        title={SECTIONS.runTranscript.title}
        keywords={SECTIONS.runTranscript.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title={CONFIG.UI_LABELS.RUN_DETAILS}
            control={<Switch on={runTranscript} onChange={toggleRunTranscript} />}
          >
            <div className="text-muted text-sm">{CONFIG.UI_LABELS.RUN_DETAILS_HINT}</div>
          </SettingRow>
        </div>
      </Section>

      {/* Whisper / capture binaries */}
      <Section
        sectionKey="binaries"
        title={SECTIONS.binaries.title}
        keywords={SECTIONS.binaries.keywords}
        query={query}
        collapse={collapse}
        anchorId={SECTION_ANCHOR_ID.binaries}
      >
        <div className={cardCls}>
          <BinRow label="ffmpeg" bin={ffmpegBin} />
          {/* Recording is dead without ffmpeg, so a missing one gets a real
            one-click fix here — this is where the HUD's capture error sends
            the user. Homebrew absent = explain that instead of a dead button. */}
          {!ffmpegBin?.found && (
            <div className="mt-2">
              {state.hasHomebrew ? (
                <Button disabled={busy === 'ffmpeg'} onClick={installFfmpeg}>
                  {busy === 'ffmpeg'
                    ? CONFIG.CAPTURE_ERROR.installing
                    : CONFIG.CAPTURE_ERROR.installAction}
                </Button>
              ) : (
                <div className="text-xs text-muted">
                  {ffmpegInstallHint}{' '}
                  <a
                    href={CONFIG.BREW_INSTALL_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    {CONFIG.BREW_INSTALL_URL.replace('https://', '')}
                  </a>
                </div>
              )}
              {busy === 'ffmpeg' && installLine && (
                <div className="text-xs text-muted mt-1 truncate">{installLine}</div>
              )}
            </div>
          )}
          {/* Manual path override — advanced only; saved by the Advanced bucket's
            button. Simple mode just shows status + Open Folder. */}
          {advancedMenu && (
            <div className="flex gap-2 mt-2">
              <input
                className={inputCls}
                value={ffmpeg}
                placeholder={ffmpegBin?.path || OVERRIDE_PATH_PLACEHOLDER}
                onChange={(e) => setFfmpeg(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className={cardCls}>
          <BinRow label="whisper-cli" bin={whisperBin} />
          {(advancedMenu || !whisperBin?.found) && (
            <div className="flex gap-2 mt-2">
              {advancedMenu && (
                <input
                  className={inputCls}
                  value={whisper}
                  placeholder={whisperBin?.path || OVERRIDE_PATH_PLACEHOLDER}
                  onChange={(e) => setWhisper(e.target.value)}
                />
              )}
              {!whisperBin?.found && (
                <Button disabled={busy === 'whisper'} onClick={installWhisper}>
                  {busy === 'whisper' ? 'Installing…' : 'Install via brew'}
                </Button>
              )}
            </div>
          )}
        </div>

        <div className={cardCls}>
          <BinRow label="Whisper model" bin={modelBin} />
          {(advancedMenu || !modelBin?.found) && (
            <div className="flex gap-2 mt-2">
              {advancedMenu && (
                <input
                  className={inputCls}
                  value={whisperModel}
                  placeholder={modelBin?.path || OVERRIDE_PATH_PLACEHOLDER}
                  onChange={(e) => setWhisperModel(e.target.value)}
                />
              )}
              {!modelBin?.found && (
                <Button disabled={busy === 'model'} onClick={downloadModel}>
                  {busy === 'model' ? `${dlPct ?? 0}%` : 'Download base.en'}
                </Button>
              )}
            </div>
          )}
          {dlPct !== null && (
            <div className="h-1 bg-surface3 rounded-full mt-2 overflow-hidden">
              <div
                className="h-1 bg-cyan rounded-full transition-all"
                style={{ width: `${dlPct}%` }}
              />
            </div>
          )}
        </div>

        {/* Only for languages it can transcribe: on Hebrew or auto-detect this
            row would sit there red and "not found" for something the user does
            not need and cannot use. */}
        {parakeetCanTranscribe(state.whisperLang) && (
          <div className={cardCls}>
            <BinRow label="Fast transcription" bin={parakeetBin} />
            <div className="mt-2 text-sm text-muted">
              {parakeetBin?.found
                ? 'Your voice becomes text about three times faster.'
                : 'Dictation works the usual way until this finishes downloading.'}
            </div>
          </div>
        )}
      </Section>

      {/* Advanced bucket — power-user knobs. Hidden in Simple mode (the tray
          owns the toggle). AV device selection, manual paths, storage roots. */}
      {advancedMenu && (
        <>
          {/* AV devices */}
          <Section
            sectionKey="devices"
            title={SECTIONS.devices.title}
            keywords={SECTIONS.devices.keywords}
            query={query}
            collapse={collapse}
          >
            <div className={cardCls}>
              <p className="text-muted text-sm mb-2.5">
                Stored by name so the choice survives device reshuffles. Refresh detects newly
                plugged-in devices.
              </p>
              <div className="flex gap-3">
                <label className="flex-1 text-md text-muted">
                  Video (screen)
                  <DeviceSelect
                    value={videoDevice}
                    onChange={setVideoDevice}
                    options={state.available.video}
                  />
                </label>
                <label className="flex-1 text-md text-muted">
                  Audio (mic)
                  <DeviceSelect
                    value={audioDevice}
                    onChange={setAudioDevice}
                    options={state.available.audio}
                  />
                </label>
              </div>
              <Button variant="ghost" className="mt-2.5" onClick={refresh}>
                Refresh device list
              </Button>
            </div>
          </Section>

          {/* Saves both AV device picks (above) and the ffmpeg/whisper path
          overrides (Binaries, above that) — kept outside both Sections so
          it's never hidden by either one's collapse state, but still hidden
          when a search filtered every section away. */}
          {anyResults && (!paged || shownPage === 'advanced') && advancedMode && (
            <div className="flex items-center gap-3 mt-2">
              <Button disabled={busy === 'save'} onClick={save}>
                {busy === 'save' ? 'Saving…' : 'Save paths & devices'}
              </Button>
              {msg && <span className="text-cyan text-md">{msg}</span>}
            </div>
          )}

          {/* Storage — read-only; open in Finder */}
          <Section
            sectionKey="storage"
            title={SECTIONS.storage.title}
            keywords={SECTIONS.storage.keywords}
            query={query}
            collapse={collapse}
          >
            <div className={cardCls}>
              <p className="text-muted text-sm mb-2.5">
                Where every run is saved. Read-only for now.
              </p>
              <StorageRow
                label="Captures (screenshots + recordings)"
                path={state.storage.captures}
              />
              <StorageRow label="ACT runs" path={state.storage.acts} />
              <StorageRow
                label={CONFIG.UI_LABELS.CONTEXT_LOG}
                path={`${state.storage.root}/context-log`}
              />
              <StorageRow label="App root" path={state.storage.root} />
            </div>
          </Section>

          <Section
            sectionKey="smallPanel"
            title={SECTIONS.smallPanel.title}
            keywords={SECTIONS.smallPanel.keywords}
            query={query}
            collapse={collapse}
          >
            <div className={cardCls}>
              <SettingRow
                title="Open the small panel"
                control={<Switch on={smallPanel} onChange={toggleSmallPanel} />}
              >
                <div className="text-muted text-sm">
                  Off: the hotkey, menu bar and Dock open the main window, on Chat or Code -
                  wherever you left it.
                </div>
              </SettingRow>
            </div>
          </Section>
        </>
      )}

      {/* Updates — auto-update status + manual check (electron-updater) */}
      <Section
        sectionKey="updates"
        title={SECTIONS.updates.title}
        keywords={SECTIONS.updates.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-md font-semibold">
                {update.state === 'available'
                  ? `Version ${update.version} available`
                  : `You're on v${CONFIG.APP_VERSION}`}
              </div>
              <div className="text-sm text-muted">{UPDATE_STATUS_TEXT[update.state]}</div>
            </div>
            <UpdateBadge state={checking ? 'checking' : update.state} />
          </div>
          {update.state === 'download-progress' && (
            <div className="flex items-center gap-3 mt-3">
              <ProgressBar pct={update.percent ?? 0} />
              <span className="text-sm text-muted tabular-nums">
                {Math.round(update.percent ?? 0)}%
              </span>
            </div>
          )}
          <div className="flex items-center gap-2 mt-3">
            <Button variant="ghost" disabled={checking} onClick={checkForUpdates}>
              {checking ? 'Checking…' : 'Check for updates'}
            </Button>
            {update.state === 'available' && (
              <Button variant="ghost" onClick={() => window.api.update.openReleasePage()}>
                Get update manually
              </Button>
            )}
            {update.state === 'downloaded' && (
              <Button onClick={() => window.api.update.install()}>Restart to update</Button>
            )}
          </div>
          {update.state === 'error' && update.message && (
            <div className="text-sm text-red-light mt-2">{update.message}</div>
          )}
        </div>
      </Section>

      {/* Code agent relay — its own "Developer" bucket, gated the same way as
          Advanced. kept off the main flow so
          it never adds a noun ("MCP", "agent") to consumer onboarding. */}
      {advancedMenu && (
        <>
          <Section
            sectionKey="agentRelay"
            anchorId={SECTION_ANCHOR_ID.agentRelay}
            title={SECTIONS.agentRelay.title}
            keywords={SECTIONS.agentRelay.keywords}
            query={query}
            collapse={collapse}
          >
            <div className={cardCls}>
              <SettingRow
                title="Let agents reach your phone"
                control={<Switch on={agentRelay.enabled} onChange={toggleAgentRelay} />}
              >
                <div className="text-muted text-sm">
                  Your coding agents buzz your phone when they need you, and hand you the live
                  screen when you tap in.
                </div>
              </SettingRow>

              {agentRelay.enabled && (
                <div className="mt-4 pt-4 border-t border-surface3 flex flex-col gap-3">
                  {/* Same derivation the Code tab's strip uses, so the two
                      surfaces can never disagree about how many are connected. */}
                  {(() => {
                    const line = relayStatusLine(agentRelay, mcpClients)
                    const open = line.names.filter((s) => !s.stale)
                    return (
                      <div
                        className="code-status"
                        data-health={line.health}
                        data-sessions={open.length > 0 ? '' : undefined}
                        tabIndex={open.length > 0 ? 0 : undefined}
                      >
                        <span className="code-status-dot" aria-hidden="true" />
                        <span className="text-sm" aria-live="polite">
                          {line.text}
                        </span>
                        {open.length > 0 && (
                          <div className="code-status-sessions" role="list">
                            {open.map((s, i) => (
                              <div
                                className="code-status-session"
                                role="listitem"
                                key={`${s.label}-${i}`}
                              >
                                <span className="code-status-session-name">{s.label}</span>
                                {s.cwd && (
                                  <span className="code-status-session-where">{s.cwd}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  {/* Setup is done the moment an agent has connected, so the
                      whole block collapses rather than nagging forever. */}
                  {relayStatusLine(agentRelay, mcpClients).health === 'no-agent' && (
                    <div>
                      <div className="text-sm text-muted mb-1">
                        {mcpClients.length > 0
                          ? 'Connect the coding apps on this Mac'
                          : 'Point any MCP client at this Mac'}
                      </div>

                      {mcpClients.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                          {mcpClients.map((client) => (
                            <Button
                              key={client.id}
                              variant="ghost"
                              disabled={client.configured}
                              onClick={() => setUpMcpClient(client.id)}
                            >
                              {client.configured ? `${client.label} ✓` : `Set up ${client.label}`}
                            </Button>
                          ))}
                        </div>
                      )}

                      {mcpClientError && (
                        <div className="text-sm text-red-light mb-2">{mcpClientError}</div>
                      )}

                      {mcpClients.some((c) => c.configured) && (
                        <div className="text-sm text-muted mb-2">
                          Quit and reopen{' '}
                          {listNames(mcpClients.filter((c) => c.configured).map((c) => c.label))} —
                          it reads this setting when it starts.
                        </div>
                      )}

                      {mcpClients.length > 0 && !showManualSnippet ? (
                        <Button
                          variant="ghost"
                          type="button"
                          className="text-sm text-muted underline"
                          onClick={() => setShowManualSnippet(true)}
                        >
                          or set it up manually
                        </Button>
                      ) : (
                        <CopySnippet text="npx mightymouse-code" />
                      )}
                    </div>
                  )}

                  {/* Gates the buzz only -- every card still arrives in the
                      app, which is what makes muting a question safe enough
                      to offer. The footnote says so out loud. */}
                  <div className="pt-3 border-t border-surface3">
                    <div className="text-sm text-muted mb-2">What buzzes your phone</div>
                    {RELAY_PUSH_VERBS.map((verb) => (
                      <Fragment key={verb}>
                        <SettingRow
                          title={RELAY_PUSH_LABELS[verb]}
                          control={
                            <Switch
                              on={relayPush.filter[verb]}
                              onChange={(next) => toggleRelayPush(verb, next)}
                            />
                          }
                        />
                        {/* Indented under its parent switch, and hidden when that
                            switch is off -- a floor on a muted verb does nothing. */}
                        {verb === 'notify' && relayPush.filter.notify && (
                          <div className="pl-4">
                            <SettingRow
                              title={RELAY_NOTIFY_LEVEL_LABEL}
                              control={
                                <Switch
                                  on={relayPush.notifyLevel === 'problems'}
                                  onChange={(next) =>
                                    setRelayNotifyLevel(next ? 'problems' : 'all')
                                  }
                                />
                              }
                            >
                              <div className="text-muted text-sm">{RELAY_NOTIFY_LEVEL_HINT}</div>
                            </SettingRow>
                            {/* Opt-in, and off by default: it fires every time
                                any agent finishes anything. */}
                            <SettingRow
                              title={RELAY_TURN_END_LABEL}
                              control={
                                <Switch
                                  on={relayPush.turnEndPing}
                                  onChange={(next) => setRelayTurnEndPing(next)}
                                />
                              }
                            >
                              <div className="text-muted text-sm">{RELAY_TURN_END_HINT}</div>
                            </SettingRow>
                          </div>
                        )}
                      </Fragment>
                    ))}
                    <div className="text-sm text-muted mt-2">{RELAY_PUSH_FOOTNOTE}</div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      disabled={agentRelayTestState === 'sending'}
                      onClick={sendAgentRelayTest}
                    >
                      {agentRelayTestState === 'sending' ? 'Sending…' : 'Send test notification'}
                    </Button>
                    {agentRelayTestState === 'sent' && (
                      <span className="text-sm text-green-light">Sent — check your phone.</span>
                    )}
                    {typeof agentRelayTestState === 'object' && (
                      <span className="text-sm text-red-light">{agentRelayTestState.error}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </Section>
        </>
      )}

      {/* What's new / release notes — hidden while searching (it's notes, not a
          setting), so a query only ever surfaces real settings. */}
      {!query.trim() && (!paged || shownPage === 'advanced') && (
        <>
          <div className={bucketCls}>Release notes</div>
          <Button
            variant="bare"
            className="flex items-center gap-2 w-full text-left bg-transparent border-0 cursor-pointer mt-4 mb-2 p-0"
            onClick={() => setShowNotes((v) => !v)}
            aria-expanded={showNotes}
          >
            <span className="text-md uppercase text-muted font-bold tracking-wider">
              What's new
            </span>
            <span className="text-muted text-sm">{showNotes ? '▾' : '▸'}</span>
          </Button>
          {showNotes && (
            <div className={cardCls}>
              {CONFIG.RELEASE_NOTES.map((rel) => (
                <div key={rel.version} className="mb-4 last:mb-0">
                  <div className="flex items-baseline gap-2 mb-1.5">
                    <span className="text-md font-bold text-accent-text">v{rel.version}</span>
                    <span className="text-sm text-muted">{rel.date}</span>
                  </div>
                  <ul className="flex flex-col gap-2">
                    {rel.changes.map((c, i) => (
                      // Icon is its own flex column so a wrapping title stays aligned
                      // instead of flowing back under the emoji. Older entries have no
                      // icon; the column collapses and the row reads as it always did.
                      <li key={i} className="leading-snug flex gap-2">
                        {'icon' in c && c.icon && (
                          <span className="text-md shrink-0" aria-hidden="true">
                            {c.icon}
                          </span>
                        )}
                        <div className="min-w-0">
                          <div className="text-md font-semibold">{c.title}</div>
                          <div className="text-sm text-muted">{c.detail}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}
