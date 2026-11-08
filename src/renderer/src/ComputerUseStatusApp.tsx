import { useEffect, useState, type CSSProperties, type JSX } from 'react'
import { X } from 'lucide-react'
import { Button } from './components/Button'
import type { ComputerUseCommand, ComputerUseStatus } from '../../shared/types'

const DRAG = { WebkitAppRegion: 'drag' } as CSSProperties
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties
const ESC_HINT = 'Esc also stops it'
const COMPACT = 'px-2.5 py-1 text-sm'

export default function ComputerUseStatusApp(): JSX.Element {
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)

  useEffect(() => window.api.onComputerUseStatus(setStatus), [])

  if (!status) return <div />

  const send = (command: ComputerUseCommand) => (): void => window.api.computerUseControl(command)
  const live = status.state !== 'ended'
  const second = status.detail ? status.detail : live ? ESC_HINT : ''

  return (
    <div className="fixed inset-0 p-2" style={DRAG}>
      <div
        className={`relative flex h-full flex-col gap-1.5 ${live ? 'justify-between' : 'justify-start'} rounded-md border border-surface3 bg-surface1 px-3 py-2 shadow-bubble`}
      >
        <Button
          variant="bare"
          title={live ? 'Stop and close' : 'Close'}
          aria-label={live ? 'Stop and close' : 'Close'}
          onClick={send('close')}
          style={NO_DRAG}
          className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-sm   text-muted transition-colors hover:bg-surface3 hover:text-on-surface"
        >
          <X size={13} strokeWidth={2.25} />
        </Button>

        <div className="flex min-w-0 items-center gap-2 pr-6">
          {live && (
            <span
              className={`h-2 w-2 shrink-0 rounded-full bg-accent ${status.state === 'running' ? 'animate-pulse' : 'opacity-50'}`}
            />
          )}
          <span
            className={`min-w-0 flex-1 text-md font-semibold text-on-surface ${live ? 'truncate' : 'line-clamp-2'}`}
            title={status.line}
          >
            {status.line}
          </span>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`min-w-0 flex-1 text-xs text-muted ${live ? 'truncate' : 'line-clamp-4'}`}
            title={second}
          >
            {second}
          </span>
          {live && (
            <div className="flex shrink-0 gap-1.5" style={NO_DRAG}>
              {status.state === 'running' ? (
                <Button variant="ghost" className={COMPACT} onClick={send('pause')}>
                  Pause
                </Button>
              ) : (
                <Button variant="ghost" className={COMPACT} onClick={send('resume')}>
                  Resume
                </Button>
              )}
              <Button variant="primary" className={COMPACT} onClick={send('stop')}>
                Stop
              </Button>
            </div>
          )}
        </div>
        {!live && status.canRetry && (
          <div className="flex shrink-0 justify-end" style={NO_DRAG}>
            <Button variant="ghost" className={COMPACT} onClick={send('retry')}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
