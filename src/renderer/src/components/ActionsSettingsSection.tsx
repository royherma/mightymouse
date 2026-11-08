import { useCallback, useEffect, useState, type JSX } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'
import { Badge } from './Badge'
import { Switch } from './Switch'
import { CARD_CLS as cardCls } from './Card'
import { ActionIcon } from './ActionRows'
import type {
  ActionsConfig,
  ActionsConfigPatch,
  CapabilityInfo
} from '../../../shared/action-engine'
import { Button } from './Button'

export function ActionsSettingsSection({ bare = false }: { bare?: boolean } = {}): JSX.Element {
  const [config, setConfig] = useState<ActionsConfig | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setConfig(await window.api.actionsConfigGet())
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load actions.')
    }
  }, [])

  useEffect(() => {
    let live = true
    window.api
      .actionsConfigGet()
      .then((c) => {
        if (live) setConfig(c)
      })
      .catch((e: unknown) => {
        if (live) setErr(e instanceof Error ? e.message : 'Could not load actions.')
      })
    return () => {
      live = false
    }
  }, [])

  const patch = useCallback(async (next: ActionsConfigPatch) => {
    setBusy(true)
    try {
      setConfig(await window.api.actionsConfigSet(next))
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save that change.')
    } finally {
      setBusy(false)
    }
  }, [])

  if (!config) {
    return (
      <div className={bare ? '' : cardCls}>
        <div className="text-muted text-sm">{err || 'Loading…'}</div>
      </div>
    )
  }

  const builtins = config.capabilities.filter((c) => c.source === 'builtin')
  const plugins = config.capabilities.filter((c) => c.source === 'plugin')

  return (
    <div className={bare ? '' : cardCls}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-lg">
            Actions <Badge color="blue">Experimental</Badge>
          </div>
          <div className="text-muted text-sm mt-0.5">
            Say what you want and MightyMouse offers to do it — open an app, set the volume, answer
            about your screen.
          </div>
        </div>
        <Switch on={config.enabled} onChange={(on) => void patch({ enabled: on })} />
      </div>

      {config.enabled && (
        <>
          <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-surface3">
            <div>
              <div className="font-medium">Offer without asking</div>
              <div className="text-muted text-sm mt-0.5">
                When you pause with text selected, quietly suggest what to do with it.
              </div>
            </div>
            <Switch on={config.idleEnabled} onChange={(on) => void patch({ idleEnabled: on })} />
          </div>

          <div className="mt-4 text-xs uppercase tracking-wide text-muted">What it can do</div>
          {builtins.map((c) => (
            <CapabilityRow key={c.id} capability={c} busy={busy} onToggle={patch} />
          ))}

          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="text-xs uppercase tracking-wide text-muted">Your own actions</div>
            <div className="flex items-center gap-2">
              <Button
                variant="bare"
                onClick={() => void load()}
                className="text-xs text-muted hover:text-on-surface flex items-center gap-1"
              >
                <RefreshCw size={12} />
                Reload
              </Button>
              <Button
                variant="bare"
                onClick={() => void window.api.actionsOpenPluginsFolder()}
                className="text-xs text-muted hover:text-on-surface flex items-center gap-1"
              >
                <FolderOpen size={12} />
                Open folder
              </Button>
            </div>
          </div>

          {plugins.length === 0 ? (
            <div className="text-muted text-sm mt-1">
              None yet. Drop a file in the folder above to add your own, then hit Reload.
            </div>
          ) : (
            plugins.map((c) => (
              <CapabilityRow key={c.id} capability={c} busy={busy} onToggle={patch} />
            ))
          )}
        </>
      )}

      {err && (
        <div className="text-sm mt-2" style={{ color: 'var(--red-light)' }}>
          {err}
        </div>
      )}
    </div>
  )
}

function CapabilityRow({
  capability,
  busy,
  onToggle
}: {
  capability: CapabilityInfo
  busy: boolean
  onToggle: (patch: ActionsConfigPatch) => Promise<void>
}): JSX.Element {
  const { id, title, blurb, icon, enabled, actionCount, error } = capability
  return (
    <div className="flex items-start justify-between gap-3 mt-2.5">
      <div className="flex items-start gap-2.5 min-w-0">
        <div className="mt-0.5 text-muted shrink-0">
          <ActionIcon name={icon} />
        </div>
        <div className="min-w-0">
          <div className="font-medium flex items-center gap-1.5">
            {title}
            {error ? (
              <Badge color="amber">Not working</Badge>
            ) : (
              <span className="text-muted text-xs font-normal">
                {actionCount} {actionCount === 1 ? 'thing' : 'things'}
              </span>
            )}
          </div>
          <div className="text-muted text-sm mt-0.5">{error || blurb}</div>
        </div>
      </div>
      <Switch
        on={enabled}
        onChange={(on) => {
          if (!busy) void onToggle({ capability: { id, enabled: on } })
        }}
      />
    </div>
  )
}
