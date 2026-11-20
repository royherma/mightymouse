import { JSX } from 'react'
import * as Select from '@radix-ui/react-select'
import type { GlobalInstructionsSettings } from '../../../../shared/types'
import { UsageMeterView } from '../../../../shared/usage-meter'
import { CONFIG } from '../../../../shared/config'
import { BackendConnections } from './BackendConnections'
import { PlanLogins } from './PlanLogins'
import { OpenRouterKey } from './OpenRouterKey'
import { Switch } from '../Switch'
import { Button } from '../Button'
import { SegmentedControl } from '../SegmentedControl'
import { MultiSelectDropdown } from '../MultiSelectDropdown'
import { ProviderIcon } from '../ProviderIcon'
import { UsageHistory } from '../UsageHistory'
import { SECTIONS, BUCKETS, SECTION_ANCHOR_ID } from './registry'
import { Section, SettingRow } from './sections'
import { prettyOllamaModel } from '../../../../shared/model-label'
import { LocalSetupRow, SelectItem } from './SettingsUi'
import {
  cardCls,
  sectionCls,
  inputCls,
  bucketCls,
  INSTRUCTIONS_MODE_OPTIONS,
  MODELS
} from './settings-consts'
import type { SettingsCtx } from './settings-state'

export function EssentialsPage({ s }: { s: SettingsCtx }): JSX.Element {
  const {
    query,
    advancedMode,
    webAccess,
    backend,
    ollamaModel,
    mlxModel,
    thinkingEnabled,
    localModels,
    localModelsLoading,
    setupState,
    setupBusy,
    setupError,
    globalInstructions,
    advancedMenu,
    collapse,
    showBucketHeader,
    account,
    deleteArmed,
    setDeleteArmed,
    deleting,
    setDeleting,
    deleteError,
    setDeleteError,
    balanceCents,
    usage,
    topupPending,
    topupMsg,
    creditsTab,
    setCreditsTab,
    subscription,
    lifetime,
    testing,
    testResult,
    attachBackendRow,
    openCheckout,
    openPortal,
    chooseBackend,
    chooseOllamaModel,
    chooseMlxModel,
    runLocalSetup,
    testBackend,
    toggleThinking,
    toggleAdvancedMode,
    toggleWebAccess,
    onToggleInstructionsMode,
    onInstructionsTextChange
  } = s
  return (
    <>
      {showBucketHeader(BUCKETS.essentials) && <div className={bucketCls}>Essentials</div>}

      {/* Account */}
      <Section
        sectionKey="account"
        title={SECTIONS.account.title}
        keywords={SECTIONS.account.keywords}
        query={query}
        className={sectionCls + ' mt-3'}
        collapse={collapse}
      >
        <div className={cardCls}>
          <div className="font-semibold text-lg">{account ? account.email : 'Not signed in'}</div>
          <div className="text-muted text-sm mt-1">
            {account ? `Signed in to ${CONFIG.BRAND_NAME}` : 'Sign in to sync your usage'}
          </div>

          {account && (
            <SettingRow
              className="mt-4"
              title="Use my Mac from the web"
              control={<Switch on={webAccess} onChange={toggleWebAccess} />}
            >
              <div className="text-muted text-sm">
                Your chats follow you to the web and back, and you can pick up where you left off
                from any browser.
              </div>
            </SettingRow>
          )}

          {/* Two taps, never one: this cannot be undone and there is no
            recovery flow to send anyone to afterwards. Arming also survives
            nothing -- closing Settings resets it, so a stray click days later
            can't land on a primed button. */}
          {account && (
            <div className="mt-4">
              <Button
                variant="ghost"
                onClick={() => {
                  if (!deleteArmed) {
                    setDeleteArmed(true)
                    return
                  }
                  setDeleting(true)
                  setDeleteError(null)
                  void window.api.auth.deleteAccount().then((result) => {
                    setDeleting(false)
                    if (!result.ok) {
                      setDeleteError(result.error || 'Could not delete your account.')
                      setDeleteArmed(false)
                    }
                    // On success the auth broadcast clears `account`, which
                    // unmounts this whole block -- nothing to reset here.
                  })
                }}
                disabled={deleting}
                className="text-sm text-muted hover:underline disabled:opacity-50"
              >
                {deleting
                  ? 'Deleting…'
                  : deleteArmed
                    ? 'Click again to delete everything - this cannot be undone'
                    : 'Delete my account'}
              </Button>
              {deleteArmed && !deleting && (
                <div className="text-muted text-sm mt-2">
                  Deletes your account, your usage history, and cancels any subscription.
                </div>
              )}
              {deleteError && <div className="text-muted text-sm mt-2">{deleteError}</div>}
            </div>
          )}
        </div>
      </Section>

      {/* Instructions — one text block, applied wherever its toggle is on */}
      <Section
        sectionKey="instructions"
        title={SECTIONS.instructions.title}
        keywords={SECTIONS.instructions.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <p className="text-muted text-sm mb-3">{CONFIG.UI_LABELS.CUSTOM_INSTRUCTIONS_HINT}</p>
          <textarea
            value={globalInstructions.text}
            onChange={(e) => onInstructionsTextChange(e.target.value)}
            rows={4}
            placeholder={CONFIG.UI_LABELS.CUSTOM_INSTRUCTIONS_PLACEHOLDER}
            className="w-full resize-none bg-surface2 rounded-lg px-3 py-2 text-md outline-none focus:shadow-focus mb-3"
          />
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">Applies to</span>
            <MultiSelectDropdown
              options={INSTRUCTIONS_MODE_OPTIONS}
              selected={
                new Set(
                  INSTRUCTIONS_MODE_OPTIONS.map((o) => o.value).filter(
                    (m) =>
                      globalInstructions.appliesTo[
                        m as keyof GlobalInstructionsSettings['appliesTo']
                      ]
                  )
                )
              }
              onChange={onToggleInstructionsMode}
              summary={
                Object.values(globalInstructions.appliesTo).every(Boolean)
                  ? 'All'
                  : Object.values(globalInstructions.appliesTo).some(Boolean)
                    ? `${Object.values(globalInstructions.appliesTo).filter(Boolean).length} selected`
                    : 'None'
              }
            />
          </div>
        </div>
      </Section>

      {/* AI Model */}
      <Section
        sectionKey="aiModel"
        title={SECTIONS.aiModel.title}
        keywords={SECTIONS.aiModel.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <p className="text-muted text-sm mb-3">
            Choose who answers when you ask {CONFIG.PRODUCT_NAME} for help. Only extra AI features
            cost, and only when you use them.
          </p>
          <div
            ref={attachBackendRow}
            className="flex gap-2.5 overflow-x-auto pb-1 -mx-0.5 px-0.5 cursor-style-row"
          >
            {MODELS.filter((m) => advancedMenu || !m.adminOnly || backend === m.value).map((m) => {
              const active = backend === m.value
              return (
                <Button
                  variant="ghost"
                  key={m.value}
                  onClick={() => chooseBackend(m.value)}
                  aria-pressed={active}
                  style={{ width: '168px' }}
                  className={
                    'relative shrink-0 text-left cursor-pointer rounded-lg px-3.5 py-3 text-on-surface border transition-[color,background-color,border-color,transform] duration-150 outline-none focus-visible:shadow-focus active:scale-[0.98] active:duration-75 ' +
                    (active
                      ? 'bg-surface2 border-accent shadow-focus'
                      : 'bg-transparent border-surface3 hover:border-muted-dark')
                  }
                >
                  {m.badge && (
                    <span
                      className="absolute top-2 right-2 rounded-full font-semibold uppercase whitespace-nowrap leading-none"
                      style={{
                        fontSize: '9px',
                        letterSpacing: '0.04em',
                        padding: '3px 7px',
                        background: 'var(--amber-bg-subtle)',
                        border: '1px solid var(--amber-border-subtle)',
                        color: 'var(--amber)'
                      }}
                    >
                      {m.badge}
                    </span>
                  )}
                  <span
                    className="flex items-center justify-center w-9 h-9 rounded-lg bg-surface2 border border-surface3 shrink-0"
                    aria-hidden
                  >
                    <ProviderIcon id={m.icon} size={22} />
                  </span>
                  <div className="font-semibold text-lg mt-2.5">{m.label}</div>
                  <div className="text-muted text-sm mt-1 leading-snug">{m.description}</div>
                </Button>
              )
            })}
          </div>
          {backend === 'openrouter' && <OpenRouterKey inputCls={inputCls} />}
          {backend === 'local' && (
            <div className="mt-3">
              <div className="text-md font-semibold">Model</div>
              {localModelsLoading ? (
                <div className="text-muted text-sm mt-1">Looking for pulled models…</div>
              ) : localModels.length === 0 ? (
                <LocalSetupRow
                  backend="local"
                  state={setupState}
                  busy={setupBusy}
                  error={setupError}
                  onRun={runLocalSetup}
                />
              ) : (
                <Select.Root value={ollamaModel} onValueChange={chooseOllamaModel}>
                  <Select.Trigger
                    className="mt-1 w-full flex items-center justify-between bg-surface2 border border-surface3 rounded-sm text-on-surface px-2.5 py-1.5 text-md font-sans outline-none transition-colors hover:border-muted-dark focus:border-accent focus:shadow-focus data-[placeholder]:text-muted"
                    aria-label="ollama model"
                  >
                    <Select.Value placeholder="Pick a model">
                      {ollamaModel ? prettyOllamaModel(ollamaModel) : 'Pick a model'}
                    </Select.Value>
                    <Select.Icon className="text-muted">▾</Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content
                      position="popper"
                      sideOffset={4}
                      className="z-50 max-h-72 overflow-hidden bg-surface2 border border-surface3 rounded-md shadow-panel"
                    >
                      <Select.Viewport className="p-1">
                        {localModels.map((m) => (
                          <SelectItem key={m.name} value={m.name}>
                            {prettyOllamaModel(m.name)} ({(m.sizeBytes / 1e9).toFixed(1)} GB
                            {m.vision ? ', vision' : ''}
                            {m.tools ? ', tools' : ''})
                          </SelectItem>
                        ))}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              )}
              {/* Admin-only capability detail for the currently-selected model, so we
                can eyeball how the panel reads before shipping it to everyone. The
                dropdown rows already tag (vision, tools) compactly; this is the
                fuller, persistent view of what the model you're ON can actually do. */}
              {advancedMenu &&
                ollamaModel !== '' &&
                (() => {
                  const m = localModels.find((lm) => lm.name === ollamaModel)
                  if (!m) return null
                  const caps: Array<{ label: string; ok: boolean }> = [
                    { label: 'Vision (screenshots)', ok: m.vision },
                    { label: 'Tool calling (act)', ok: m.tools },
                    { label: 'Think before answering', ok: m.thinking }
                  ]
                  return (
                    <div className="mt-2 bg-surface2 border border-surface3 rounded-md p-2.5 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-on-surface">{m.name}</span>
                        <span className="text-muted">{(m.sizeBytes / 1e9).toFixed(1)} GB</span>
                      </div>
                      <div className="mt-2 flex flex-col gap-1">
                        {caps.map((c) => {
                          const color = c.ok ? 'var(--green-light)' : 'var(--red-light)'
                          return (
                            <div key={c.label} className="flex items-center gap-2">
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ background: color, boxShadow: `0 0 6px ${color}` }}
                              />
                              <span className="text-muted">{c.label}</span>
                            </div>
                          )
                        })}
                      </div>
                      <div className="mt-2 text-muted text-xs leading-snug">
                        Admin-only preview. Rewrite &amp; ask always work locally; act needs tool
                        calling.
                      </div>
                      {/* Only rendered for a model that declares it — Ollama hard-errors
                        on a think request to a model without the capability. */}
                      {m.thinking && (
                        <div className="mt-2 pt-2 border-t border-surface3">
                          <SettingRow
                            title="Think before answering"
                            control={<Switch on={thinkingEnabled} onChange={toggleThinking} />}
                          >
                            <div className="text-muted text-sm">
                              Slower, but better for hard multi-step questions. Off is faster for
                              most things. Chat only.
                            </div>
                          </SettingRow>
                        </div>
                      )}
                    </div>
                  )
                })()}
            </div>
          )}
          {backend === 'mlx' && (
            <div className="mt-3">
              <div className="text-md font-semibold">Model</div>
              {localModelsLoading ? (
                <div className="text-muted text-sm mt-1">Looking for served models…</div>
              ) : localModels.length === 0 ? (
                <LocalSetupRow
                  backend="mlx"
                  state={setupState}
                  busy={setupBusy}
                  error={setupError}
                  onRun={runLocalSetup}
                />
              ) : (
                <Select.Root value={mlxModel} onValueChange={chooseMlxModel}>
                  <Select.Trigger
                    className="mt-1 w-full flex items-center justify-between bg-surface2 border border-surface3 rounded-sm text-on-surface px-2.5 py-1.5 text-md font-sans outline-none transition-colors hover:border-muted-dark focus:border-accent focus:shadow-focus data-[placeholder]:text-muted"
                    aria-label="rapid-mlx model"
                  >
                    <Select.Value placeholder="Pick a model">
                      {mlxModel || 'Pick a model'}
                    </Select.Value>
                    <Select.Icon className="text-muted">▾</Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content
                      position="popper"
                      sideOffset={4}
                      className="z-50 max-h-72 overflow-hidden bg-surface2 border border-surface3 rounded-md shadow-panel"
                    >
                      <Select.Viewport className="p-1">
                        {localModels.map((m) => (
                          <SelectItem key={m.name} value={m.name}>
                            {m.name}
                            {m.vision ? ' (vision)' : m.tools ? ' (tools)' : ''}
                          </SelectItem>
                        ))}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              )}
            </div>
          )}
          <div className="mt-3">
            <Button variant="ghost" disabled={testing} onClick={testBackend}>
              {testing ? 'Checking…' : 'Check it works'}
            </Button>
            {testResult && testResult.backend === backend && (
              <div className="mt-2.5 flex flex-col gap-1.5">
                {testResult.checks.map((c) => {
                  const color = c.ok ? 'var(--green-light)' : 'var(--red-light)'
                  return (
                    <div key={c.label} className="flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ background: color, boxShadow: `0 0 8px ${color}` }}
                      />
                      <span className="text-md font-semibold" style={{ color }}>
                        {c.label}
                      </span>
                      <span className="text-muted text-sm">{c.detail}</span>
                    </div>
                  )
                })}
                {testResult.advice && (
                  <div className="text-sm mt-0.5" style={{ color: 'var(--yellow)' }}>
                    {testResult.advice}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </Section>

      {/* Credits — usage-based balance + a Monthly (subscribe) / One-time (packs)
          toggle for the mightymouse backend. Monthly is the growth goal, so it's
          the default tab; One-time is one click away and behaves exactly as
          before. Whichever tab is active, its buttons are the only checkout
          entry points — no mixing recurring and one-time in the same list. */}
      <Section
        sectionKey="credits"
        title={SECTIONS.credits.title}
        keywords={SECTIONS.credits.keywords}
        query={query}
        collapse={collapse}
        anchorId={SECTION_ANCHOR_ID.credits}
      >
        <div className={cardCls}>
          {usage ? (
            <div className="mb-2">
              <UsageMeterView meter={usage} />
            </div>
          ) : (
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-muted text-sm">Your balance</span>
              <span className="font-bold text-2xl leading-none">
                {balanceCents === null ? '—' : `$${(balanceCents / 100).toFixed(2)}`}
              </span>
            </div>
          )}
          <p className="text-muted text-sm mb-3">
            {subscription?.status === 'active'
              ? CONFIG.BILLING.CREDITS_BLURB.subscribed
              : CONFIG.BILLING.CREDITS_BLURB.unsubscribed}
          </p>

          {/* Already bought — a quiet confirmation line, not a badge. Lifetime is
            no longer sold (see migration 0102); existing owners still see this. */}
          {lifetime?.alreadyOwned && (
            <div className="rounded-md border border-surface3 bg-surface2 px-3 py-2.5 mb-3 text-on-surface text-sm font-semibold">
              {CONFIG.BILLING.LIFETIME.owned_label}
            </div>
          )}

          {subscription?.status === 'active' ? (
            <div className="rounded-md border border-surface3 bg-surface2 px-3 py-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-on-surface font-semibold text-md">Subscribed</div>
                <div className="text-muted text-sm mt-0.5">
                  {subscription.currentPeriodEnd
                    ? `Renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
                    : 'Renews automatically'}
                </div>
              </div>
              <Button variant="ghost" disabled={topupPending === 'portal'} onClick={openPortal}>
                {topupPending === 'portal' ? 'Opening…' : 'Manage'}
              </Button>
            </div>
          ) : (
            <SegmentedControl
              items={[
                { id: 'monthly', label: 'Monthly' },
                { id: 'onetime', label: 'One-time' }
              ]}
              active={creditsTab}
              onChange={setCreditsTab}
              className="mb-3"
            />
          )}

          {/* Subscriptions and Lifetime live in the upgrade window now — one
            paywall for the whole app, so pricing copy has a single home. Packs
            stay here: a top-up is account maintenance, not an upgrade decision. */}
          {subscription?.status !== 'active' && creditsTab === 'monthly' && (
            <Button
              variant="ghost"
              onClick={() => window.api.openUpgradeWindow('settings')}
              className="w-full flex items-center justify-between gap-3 rounded-md border border-surface3 bg-surface2 px-3 py-3 cursor-pointer transition-all hover:border-accent hover:shadow-focus"
            >
              <span className="text-on-surface font-bold text-xl leading-none">Monthly plans</span>
              <span className="text-green-light text-sm font-semibold">
                From {CONFIG.BILLING.PLANS[0].label} - every model, resets monthly
              </span>
            </Button>
          )}

          {subscription?.status !== 'active' && creditsTab === 'onetime' && (
            <div className="grid grid-cols-3 gap-2">
              {CONFIG.BILLING.PACKS.map((pack) => {
                const pending = topupPending === pack.id
                return (
                  <Button
                    variant="ghost"
                    key={pack.id}
                    onClick={() => openCheckout(pack.id)}
                    disabled={topupPending !== null}
                    className="flex flex-col items-center gap-0.5 rounded-md border border-surface3 bg-surface2 px-2 py-3 cursor-pointer transition-all hover:border-accent hover:shadow-focus disabled:opacity-50 disabled:cursor-default disabled:hover:border-surface3 disabled:hover:shadow-none"
                  >
                    <span className="text-on-surface font-bold text-xl leading-none">
                      {pending ? '…' : pack.label}
                    </span>
                    {pack.bonus_label && (
                      <span className="text-green-light text-xlg font-semibold mt-0.5">
                        {pack.bonus_label}
                      </span>
                    )}
                  </Button>
                )
              })}
            </div>
          )}

          {topupMsg && (
            <div
              className="text-sm mt-2.5"
              style={{ color: topupMsg.kind === 'ok' ? 'var(--cyan)' : 'var(--red-light)' }}
            >
              {topupMsg.text}
            </div>
          )}
        </div>
      </Section>

      <Section
        sectionKey="aiPlans"
        title={SECTIONS.aiPlans.title}
        keywords={SECTIONS.aiPlans.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <BackendConnections
            rows={MODELS.filter(
              (m) =>
                m.value !== 'mightymouse' && (advancedMenu || !m.adminOnly || backend === m.value)
            )}
          />
          <PlanLogins />
        </div>
      </Section>

      {/* Usage — per-call charge history for the mightymouse backend. Shows the
          user exactly what they were charged for, grouped by day. RLS-backed. */}
      <Section
        sectionKey="usage"
        title={SECTIONS.usage.title}
        keywords={SECTIONS.usage.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <UsageHistory compact />
        </div>
      </Section>

      <Section
        sectionKey="advancedMode"
        title={SECTIONS.advancedMode.title}
        keywords={SECTIONS.advancedMode.keywords}
        query={query}
        collapse={collapse}
      >
        <div className={cardCls}>
          <SettingRow
            title={CONFIG.UI_LABELS.SIMPLE_CODE_PROMPT}
            control={<Switch on={advancedMode} onChange={toggleAdvancedMode} />}
          >
            <div className="text-muted text-sm">
              {CONFIG.UI_LABELS.SIMPLE_CODE_DETAIL}. {CONFIG.UI_LABELS.SIMPLE_CODE_OFF_NOTE}.
            </div>
          </SettingRow>
        </div>
      </Section>
    </>
  )
}
