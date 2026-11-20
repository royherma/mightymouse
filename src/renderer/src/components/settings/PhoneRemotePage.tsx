import { JSX } from 'react'
import { Switch } from '../Switch'
import { Button } from '../Button'
import { PAIR_QR_SIZE } from '../PairQr'
import { PairingPanel } from '../PairingPanel'
import { SECTIONS, SECTION_ANCHOR_ID } from './registry'
import { Section, SettingRow } from './sections'
import { cardCls } from './settings-consts'
import type { SettingsCtx } from './settings-state'

export function PhoneRemotePage({ s }: { s: SettingsCtx }): JSX.Element {
  const {
    query,
    siriScreenAnswer,
    phoneRemoteEnabled,
    phoneRemoteSupported,
    phoneRemoteStayAwake,
    extendedScreenOn,
    phoneRemoteClamshell,
    clamshellError,
    phoneRemoteAwayMode,
    awayModeError,
    phoneRemoteAwayHeld,
    coverBusy,
    phoneRemoteError,
    tunnelEnabled,
    tunnelStatus,
    collapse,
    clearExtendedScreen,
    toggleClamshell,
    toggleAwayMode,
    toggleSiriScreenAnswer,
    toggleCoverNow,
    toggleStayAwakeWithClamshell,
    togglePhoneRemote,
    fetchPhoneRemoteQr,
    pairing,
    toggleTunnel,
    retryTunnel
  } = s
  return (
    <>
      {/* Phone Remote sits above Essentials — its own top-level block, and the
          longest card on the page once paired (QR + pairing mode + keep-awake +
          clamshell). It collapses like every other section so it can be folded
          away when you're not pairing a phone. */}
      {phoneRemoteSupported && (
        <Section
          sectionKey="phoneRemote"
          title={SECTIONS.phoneRemote.title}
          keywords={SECTIONS.phoneRemote.keywords}
          query={query}
          collapse={collapse}
          anchorId={SECTION_ANCHOR_ID.phoneRemote}
        >
          <div className={cardCls}>
            <SettingRow
              title="Use your phone as a trackpad and mic for your Mac"
              control={<Switch on={phoneRemoteEnabled} onChange={togglePhoneRemote} />}
            />
            {phoneRemoteEnabled && pairing.canRetry && (
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {/* Retry re-runs whichever half is actually failing: the
                    tunnel when it's on (it reaps orphaned cloudflared
                    processes first), otherwise the LAN QR fetch. */}
                <Button
                  variant="ghost"
                  className="px-2 text-sm"
                  onClick={() => (tunnelEnabled ? void retryTunnel() : void fetchPhoneRemoteQr())}
                >
                  Retry
                </Button>
              </div>
            )}
            {phoneRemoteError && (
              <div className="text-red-400 text-sm mt-2">{phoneRemoteError}</div>
            )}

            {/* ONE QR, no mode — stacked QRs hid which to scan. make why Q="two QR" */}
            {phoneRemoteEnabled && (
              <div className="mt-4 pt-4 border-t border-surface3">
                <PairingPanel
                  pairing={pairing}
                  tunnelEnabled={tunnelEnabled}
                  tunnelStatus={tunnelStatus}
                  onTunnelToggle={toggleTunnel}
                  onTunnelRetry={() => void retryTunnel()}
                  onLanRetry={fetchPhoneRemoteQr}
                  qrSize={PAIR_QR_SIZE.sm}
                  dense
                  showCertNote
                  onUpgrade={() => window.api.openUpgradeWindow('phone_remote_minutes')}
                />

                {/* Only rendered while a display actually exists -- a
                    permanent row for something that is usually absent would be
                    dead UI, and this one doubles as the status ("it's still
                    up") the user otherwise has no way to check. */}
                {extendedScreenOn && (
                  <SettingRow
                    className="mt-4 pt-4 border-t border-surface3"
                    title="Extended screen"
                    control={
                      <Button variant="ghost" onClick={clearExtendedScreen}>
                        Clear
                      </Button>
                    }
                  >
                    <div className="text-muted text-sm">
                      Your phone added a second screen, and it stays after the phone disconnects so
                      your windows stay put. Clearing it moves them back.
                    </div>
                  </SettingRow>
                )}

                {/* Keep-awake sits OUTSIDE the pairing panel: it applies to
                    both LAN and off-Wi-Fi sessions, so hiding it in the remote
                    panel would strand LAN users with a sleeping screen. */}
                <SettingRow
                  className="mt-4 pt-4 border-t border-surface3"
                  title="Keep this Mac awake"
                  control={
                    <Switch on={phoneRemoteStayAwake} onChange={toggleStayAwakeWithClamshell} />
                  }
                >
                  <div className="text-muted text-sm">
                    Stops the screen sleeping while Phone Remote is on, so it stays reachable. Uses
                    more battery. Closing the lid still sleeps it.
                  </div>
                </SettingRow>

                {/* Clamshell is nested under keep-awake because it's a strict
                    escalation of it — showing it while the screen can still
                    sleep on idle would promise lid-closed control we can't
                    deliver. */}
                {phoneRemoteStayAwake && (
                  <SettingRow
                    className="mt-3"
                    title="Works with the lid closed"
                    control={<Switch on={phoneRemoteClamshell} onChange={toggleClamshell} />}
                  >
                    <div className="text-muted text-sm">
                      Keeps this Mac reachable after you shut it, and your agents keep working until
                      they finish. Asks for your password, and changes a system setting until you
                      turn it off. Leave it plugged in - a closed Mac gets warm.
                    </div>
                    {clamshellError && (
                      <div className="text-red-400 text-sm mt-1">{clamshellError}</div>
                    )}
                  </SettingRow>
                )}

                {/* Peer of clamshell, not a child of keep-awake: this one is
                    about who can SEE the Mac, not whether it stays powered,
                    and it's just as useful on a Mac that sleeps normally. */}
                <SettingRow
                  className="mt-3"
                  title="Protect this screen while you use your phone"
                  control={<Switch on={phoneRemoteAwayMode} onChange={toggleAwayMode} />}
                >
                  <div className="text-muted text-sm">
                    Nobody near this Mac sees what you're doing. We cover it once you stop using it,
                    while your phone keeps showing the live screen. If someone sits down and touches
                    it, the Mac locks.
                  </div>
                  {awayModeError && (
                    <div className="text-red-400 text-sm mt-1">{awayModeError}</div>
                  )}
                </SettingRow>

                {/* Child of the switch above, not a peer: offering cover
                    under an OFF toggle reads as a second, contradictory
                    switch. The switch off is how the session ends. */}
                {(phoneRemoteAwayMode || phoneRemoteAwayHeld) && (
                  <SettingRow
                    className="mt-3"
                    title="Protect the screen now"
                    control={
                      <Button variant="ghost" disabled={coverBusy} onClick={toggleCoverNow}>
                        Protect
                      </Button>
                    }
                  >
                    <div className="text-muted text-sm">
                      Covers this Mac right now. After that, touching it locks the Mac.
                    </div>
                  </SettingRow>
                )}

                {/* Sits with the other screen-privacy switches, not with the
                    phone pairing rows above: what it governs is who may look
                    at this screen, which is the question this section answers. */}
                <SettingRow
                  className="mt-3"
                  title="Let Siri see this screen"
                  control={<Switch on={siriScreenAnswer} onChange={toggleSiriScreenAnswer} />}
                >
                  <div className="text-muted text-sm">
                    Ask Siri what's on your Mac and get an answer out loud, without touching it.
                    Your screen stays covered while you're away.
                  </div>
                </SettingRow>
              </div>
            )}
          </div>
        </Section>
      )}
    </>
  )
}
