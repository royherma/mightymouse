import type { HandsFreeDisplay } from './hands-free-rules'

/** Top-of-screen mode indicator for hands-free dictation. The mic button alone
 *  cannot carry this: press-and-hold and hands-free look identical at a glance,
 *  and hands-free keeps listening after the finger leaves. */
export default function HandsFreePill(props: { state: HandsFreeDisplay }): React.JSX.Element | null {
  const { state } = props
  if (state === 'off') return null
  const starting = state === 'starting'
  return (
    <div className="handsFreePill" data-state={state} role="status" aria-live="polite">
      <span className="handsFreePillDot" />
      <span className="handsFreePillText">
        {starting ? 'Starting hands-free…' : 'Hands-free on - tap mic to stop'}
      </span>
    </div>
  )
}
