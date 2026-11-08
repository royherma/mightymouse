import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, Mic, MousePointer2, QrCode } from 'lucide-react'
import { Button } from '../components/Button'
import { Kbd } from '../components/Kbd'
import { PairQr, PAIR_QR_SIZE } from '../components/PairQr'
import { CONFIG } from '../../../shared/config'
import { comboGlyphs, getShortcut } from '../../../shared/shortcuts'
import { usePhonePairConfirm } from '../tour/usePhonePairConfirm'

type PhoneState = 'scan' | 'move' | 'talk' | 'done'

const LISTEN = getShortcut('listen')
const FN_GLYPH = LISTEN.solo?.glyph ?? LISTEN.glyph
const LISTEN_COMBO = comboGlyphs(LISTEN)

export function PhonePath({
  path,
  onDone,
  onSkip
}: {
  path: 'phone' | 'talk'
  onDone: () => void
  onSkip: () => void
}): JSX.Element {
  const [state, setState] = useState<PhoneState>(path === 'talk' ? 'talk' : 'scan')
  useEffect(() => {
    void window.api.firstRun.getFirstBootAtMs().then((bootMs) => {
      window.api.track('ftue_step', {
        path,
        step: state,
        ms_since_first_boot: bootMs ? Date.now() - bootMs : 0
      })
    })
  }, [path, state])

  const [paired, setPaired] = useState(false)
  const confirm = usePhonePairConfirm(state === 'scan', () => {
    setPaired(true)
    setState('move')
  })

  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const [allowed, setAllowed] = useState(false)
  useEffect(() => {
    if (state !== 'move' || !allowed) return
    return window.api.firstRun.onPhoneMoved(() => setState('talk'))
  }, [state, allowed])

  const grantStartedRef = useRef(false)
  useEffect(() => {
    if (state !== 'move' || grantStartedRef.current) return
    grantStartedRef.current = true
    void grantAccessibility()

    async function grantAccessibility(): Promise<void> {
      window.api.track('onboarding_grant_attempted', { key: 'accessibility', preview: false })
      const before = await window.api.onboarding.runSelfTest('accessibility')
      if (!before.ok) {
        await window.api.settingsOpenPane('accessibility')
        void window.api.dragCoach.show('accessibility')
      }
      await window.api.settingsRequestPermission('accessibility')
      const startedAt = Date.now()
      let reportedSlow = false
      while (mountedRef.current) {
        await new Promise((r) => setTimeout(r, CONFIG.FIRST_RUN.GRANT_POLL_MS))
        const test = await window.api.onboarding.runSelfTest('accessibility')
        if (test.ok) {
          window.api.track('onboarding_permission_granted', {
            key: 'accessibility',
            preview: false
          })
          void window.api.dragCoach.close()
          setAllowed(true)
          return
        }
        if (!reportedSlow && Date.now() - startedAt > CONFIG.FIRST_RUN.GRANT_SLOW_MS) {
          reportedSlow = true
          window.api.track('onboarding_grant_failed', {
            key: 'accessibility',
            detail: 'timeout',
            preview: false
          })
        }
      }
    }
  }, [state])

  const [modelReady, setModelReady] = useState(false)
  const [modelPct, setModelPct] = useState(0)
  const [transcript, setTranscript] = useState('')
  useEffect(() => {
    if (state !== 'talk') return
    let live = true
    let advanceTimer: ReturnType<typeof setTimeout> | undefined
    void window.api.firstRun.modelReady().then((ready) => {
      if (live) setModelReady(ready)
    })
    const off = window.api.firstRun.onModelProgress((pct) => {
      setModelPct(pct)
      if (pct >= 100) setModelReady(true)
    })
    const offTranscript = window.api.firstRun.onTranscript((text) => {
      if (!text.trim()) return
      setTranscript(text.trim())
      advanceTimer = setTimeout(() => setState('done'), CONFIG.FIRST_RUN.TRANSCRIPT_HOLD_MS)
    })
    return () => {
      live = false
      clearTimeout(advanceTimer)
      off()
      offTranscript()
    }
  }, [state])

  return (
    <div className="fr">
      {state === 'scan' && (
        <>
          <span className="fr-badge">
            <QrCode size={22} />
          </span>
          <span className="fr-title">{CONFIG.FIRST_RUN.scan.title}</span>
          <div className="fr-qr">
            <PairQr qrDataUrl={confirm.qrDataUrl} size={PAIR_QR_SIZE.md} />
          </div>
          <span className="fr-sub">{CONFIG.FIRST_RUN.scan.sub}</span>
          <span className="fr-sub">{CONFIG.FIRST_RUN.scan.wifi}</span>
          <Button variant="bare" className="fr-link" onClick={() => setState('talk')}>
            {CONFIG.FIRST_RUN.scan.talkInstead}
          </Button>
        </>
      )}

      {state === 'move' && (
        <>
          <span className="fr-badge">
            <MousePointer2 size={22} />
          </span>
          <span className="fr-title">
            {allowed ? CONFIG.FIRST_RUN.move.title : CONFIG.FIRST_RUN.move.titleWaiting}
          </span>
          <div className="fr-pad" data-dim={allowed ? undefined : ''}>
            <span className="fr-pad-dot" />
          </div>
          <span className="fr-note">
            {allowed ? CONFIG.FIRST_RUN.move.allowed : CONFIG.FIRST_RUN.move.permHint}
          </span>
          <Button
            variant="bare"
            className="fr-link"
            onClick={() =>
              allowed ? setState('talk') : void window.api.settingsOpenPane('accessibility')
            }
          >
            {allowed ? CONFIG.FIRST_RUN.move.skip : CONFIG.FIRST_RUN.move.openSetting}
          </Button>
        </>
      )}

      {state === 'talk' && (
        <>
          <span className="fr-badge">
            <Mic size={22} />
          </span>
          {!modelReady ? (
            <span className="fr-title">{CONFIG.FIRST_RUN.talk.loadingTitle}</span>
          ) : paired ? (
            <span className="fr-title">{CONFIG.FIRST_RUN.talk.phoneTitle}</span>
          ) : (
            <span className="fr-title">
              {CONFIG.FIRST_RUN.talk.titlePrefix}{' '}
              <span className="fr-key">
                <Kbd glyphs={[FN_GLYPH]} />
              </span>{' '}
              {CONFIG.FIRST_RUN.talk.titleSuffix}
            </span>
          )}
          {!modelReady && (
            <div className="fr-actions">
              <div className="fr-progress">
                <i style={{ width: `${modelPct}%` }} />
              </div>
              <span className="fr-sub">
                {CONFIG.FIRST_RUN.talk.downloading} {modelPct}%
              </span>
              <Button variant="bare" className="fr-link" onClick={onSkip}>
                {CONFIG.FIRST_RUN.talk.skipWait}
              </Button>
            </div>
          )}
          {modelReady && (
            <>
              <div className="fr-field" data-filled={transcript ? '' : undefined}>
                {transcript || (
                  <span className="fr-field-empty">{CONFIG.FIRST_RUN.talk.placeholder}</span>
                )}
                <span className="fr-caret" />
              </div>
              <span className="fr-sub">{CONFIG.FIRST_RUN.talk.sub}</span>
              {!paired && (
                <span className="fr-sub">
                  {CONFIG.FIRST_RUN.talk.orHold}{' '}
                  <span className="fr-key">
                    <Kbd glyphs={LISTEN_COMBO} />
                  </span>{' '}
                  <Button
                    variant="bare"
                    className="fr-link"
                    onClick={() => void window.api.openSettingsWindow()}
                  >
                    {CONFIG.FIRST_RUN.talk.fnHelp}
                  </Button>
                </span>
              )}
            </>
          )}
        </>
      )}

      {state === 'done' && (
        <>
          <span className="fr-badge fr-badge-done">
            <Check size={24} strokeWidth={3} />
          </span>
          <span className="fr-title">{CONFIG.FIRST_RUN.done.title}</span>
          <div className="fr-rows">
            <div className="fr-row">
              <span>{CONFIG.FIRST_RUN.done.rowTalk}</span>
              <Kbd glyphs={[FN_GLYPH]} />
            </div>
            <div className="fr-row">
              <span>{CONFIG.FIRST_RUN.done.rowKept}</span>
              <Button
                variant="bare"
                className="fr-link"
                onClick={() => void window.api.openMediaLibraryWindow()}
              >
                {CONFIG.FIRST_RUN.done.openLibrary}
              </Button>
            </div>
          </div>
          <div className="fr-actions">
            <Button variant="primary" className="fr-primary" onClick={onDone}>
              {CONFIG.FIRST_RUN.done.button}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
