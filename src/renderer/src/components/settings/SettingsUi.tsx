import { JSX } from 'react'
import * as Select from '@radix-ui/react-select'
import type { LocalSetupState, LocalSetupProgress } from '../../../../shared/types'
import { CursorStyleId } from '../../../../shared/cursor-styles'
import { MouseGlyph } from '../../MouseGlyph'
import { GlowDot } from '../GlowDot'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { CopyButton } from '../CopyButton'
import { ProgressBar } from '../ProgressBar'
import { UpdateUiKey, UPDATE_BADGE } from './settings-consts'

export function UpdateBadge({ state }: { state: UpdateUiKey }): JSX.Element {
  const meta = UPDATE_BADGE[state] || UPDATE_BADGE.idle
  return <Badge color={meta.color}>{meta.label}</Badge>
}

/** One-line command a dev pastes into their MCP client config, with a copy
 *  button — the whole "second door" is this one string. */
export function CopySnippet({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 bg-surface2 border border-surface3 rounded-sm px-2.5 py-1.5 text-sm font-mono">
        {text}
      </code>
      <CopyButton label="Copy command" text={text} />
    </div>
  )
}

/**
 * The empty state for a local backend — one button that gets the service running,
 * or a plain sentence when there's genuinely nothing we can do for them.
 *
 * The manual command stays visible in every state. It's the escape hatch for a
 * user whose machine we can't automate, and the thing they'd search for.
 */
export function LocalSetupRow({
  backend,
  state,
  busy,
  error,
  onRun
}: {
  backend: 'local' | 'mlx'
  state: LocalSetupState | null
  busy: LocalSetupProgress | null
  error: string | null
  onRun: () => void
}): JSX.Element {
  const isMlx = backend === 'mlx'
  const pullCmd = isMlx ? 'rapid-mlx pull <model>' : 'ollama pull <model>'

  // A bare spinner on a 60s install reads as "hung". Percent + a running clock
  // is the difference between waiting and wondering whether to force-quit.
  if (busy) {
    const seconds = Math.floor(busy.elapsedMs / 1000)
    const clock = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    return (
      <div className="mt-1 flex flex-col gap-1.5" style={{ maxWidth: 320 }}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">{busy.message}</span>
          <span className="text-muted text-sm font-mono">{busy.percent}%</span>
        </div>
        <div className="flex">
          <ProgressBar pct={busy.percent} height="h-1.5" />
        </div>
        <div className="text-muted text-sm">{clock} elapsed</div>
      </div>
    )
  }

  const label = state?.action === 'start' ? 'Start it for me' : 'Set it up for me'

  return (
    <div className="mt-1 flex flex-col gap-1.5 items-start">
      <div className="text-muted text-sm">
        {state?.detail ?? (isMlx ? 'Rapid-MLX isn’t running yet.' : 'Ollama isn’t running yet.')}
      </div>
      {state?.action && <Button onClick={onRun}>{label}</Button>}
      <div className="text-muted text-sm">
        Or run <code className="font-mono">{pullCmd}</code> in a terminal.
      </div>
      {error && (
        <div className="text-sm" style={{ color: 'var(--yellow)' }}>
          {error}
        </div>
      )}
    </div>
  )
}

export function StorageRow({ label, path }: { label: string; path: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-md font-semibold">{label}</div>
        <div className="text-sm text-muted font-mono truncate" title={path}>
          {path}
        </div>
      </div>
      <Button
        variant="ghost"
        className="bg-transparent border border-surface3 text-muted rounded-sm px-3 text-md font-semibold cursor-pointer transition-colors hover:bg-surface2 hover:text-on-surface shrink-0"
        onClick={() => window.api.openPath(path)}
      >
        Open
      </Button>
    </div>
  )
}

export function DeviceSelect({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ index: string; name: string }>
}): JSX.Element {
  const names = options.map((o) => o.name)
  // Keep the current value selectable even if the device is currently unplugged.
  const showOrphan = value && !names.includes(value)
  const display = value || 'no devices found'

  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger
        className="mt-1 w-full flex items-center justify-between bg-surface2 border border-surface3 rounded-sm text-on-surface px-2.5 py-1.5 text-md font-sans outline-none transition-colors hover:border-muted-dark focus:border-accent focus:shadow-focus data-[placeholder]:text-muted"
        aria-label="device"
      >
        <Select.Value placeholder={display}>{value || display}</Select.Value>
        <Select.Icon className="text-muted">▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-72 overflow-hidden bg-surface2 border border-surface3 rounded-md shadow-panel"
        >
          <Select.Viewport className="p-1">
            {showOrphan && <SelectItem value={value}>{value} (not connected)</SelectItem>}
            {options.map((o) => (
              <SelectItem key={o.index} value={o.name}>
                [{o.index}] {o.name}
              </SelectItem>
            ))}
            {options.length === 0 && (
              <div className="px-2.5 py-2 text-sm text-muted">no devices found</div>
            )}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

export function SelectItem({
  value,
  children
}: {
  value: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <Select.Item
      value={value}
      className="text-md text-on-surface px-2.5 py-1.5 rounded-sm cursor-pointer outline-none select-none data-[highlighted]:bg-surface3 data-[state=checked]:text-accent-text"
    >
      <Select.ItemText>{children}</Select.ItemText>
    </Select.Item>
  )
}

// A selectable preview card with a small looping animation of the style.
// The preview uses pure CSS keyframes (defined in index.css) so it's cheap and
// doesn't run the real overlay engine — just enough to convey the look.
export function CursorStyleCard({
  meta,
  active,
  onPick
}: {
  meta: { id: CursorStyleId; label: string; description: string }
  active: boolean
  onPick: () => void
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={[
        'flex-shrink-0 w-[168px] text-left rounded-md border p-0 overflow-hidden cursor-pointer transition-all',
        active
          ? 'border-accent shadow-focus bg-surface2'
          : 'border-surface3 bg-surface2 hover:border-muted-dark'
      ].join(' ')}
    >
      {/* Preview stage: dark canvas with the animated companion looping across */}
      <div className="relative h-[88px] w-full overflow-hidden bg-bg-dark">
        <div className={`cursor-preview cursor-preview-${meta.id}`} aria-hidden>
          {meta.id === 'mouseHead' ? (
            <span className="cursor-preview-mouse-wrap">
              <MouseGlyph size={44} showLaser />
            </span>
          ) : (
            <>
              {meta.id === 'comet' && <span className="cursor-preview-tail" aria-hidden />}
              <span className="cursor-preview-orb" aria-hidden />
            </>
          )}
        </div>
      </div>
      <div className="px-2.5 py-2">
        <div className={`text-sm font-semibold ${active ? 'text-accent-text' : 'text-on-surface'}`}>
          {meta.label}
        </div>
        <div className="text-xlg text-muted mt-0.5 leading-tight line-clamp-2">
          {meta.description}
        </div>
      </div>
    </Button>
  )
}

export function BinRow({
  label,
  bin
}: {
  label: string
  bin?: { found: boolean; detail?: string; path?: string }
}): JSX.Element {
  const color = bin?.found ? 'var(--green-light)' : 'var(--red-light)'
  const statusText = bin?.found ? bin.detail || 'found' : 'not found'
  // Reveal the binary in Finder by opening its parent folder.
  const parentDir = bin?.path ? bin.path.replace(/\/[^/]*$/, '') : ''
  return (
    <div className="flex items-center gap-3 min-w-0">
      <span className="font-semibold text-lg shrink-0">{label}</span>
      {/* Dot + status text take the middle and TRUNCATE — a long ffmpeg version
          string must never push the Open Folder button off the card. GlowDot
          carries just the dot; the label truncates separately. */}
      <span className="flex items-center gap-1.5 min-w-0 flex-1">
        <GlowDot color={color} />
        <span className="text-md font-semibold truncate" style={{ color }} title={statusText}>
          {statusText}
        </span>
      </span>
      {bin?.found && parentDir && (
        <Button
          variant="ghost"
          className="bg-transparent border border-surface3 text-muted rounded-sm px-2.5 text-sm font-semibold cursor-pointer transition-colors hover:bg-surface2 hover:text-on-surface shrink-0"
          onClick={() => window.api.openPath(parentDir)}
        >
          Open Folder
        </Button>
      )}
    </div>
  )
}
