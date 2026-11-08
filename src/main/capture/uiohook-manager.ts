// Single owner of the uiohook-napi global hook.
//
// uiohook is a process-wide singleton: there is exactly one OS event tap. The
// capture hotkey needs it running continuously; the event logger needs it only
// during a recording. Both go through this manager so start()/stop() is
// refcounted and listeners never clobber each other.
import { IS_DEVTEST } from '../../shared/env'
type Listener = (e: AnyEvent) => void
export interface AnyEvent {
  keycode: number
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  metaKey: boolean
  x: number
  y: number
  clicks: number
  button: number
  rotation: number
  direction: number
}

type Hook = {
  on: (event: string, cb: Listener) => void
  removeListener?: (event: string, cb: Listener) => void
  start: () => void
  stop: () => void
}

let hook: Hook | null = null
let loadAttempted = false
let refs = 0

function load(): Hook | null {
  if (loadAttempted) return hook
  loadAttempted = true
  if (IS_DEVTEST) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    hook = require('uiohook-napi').uIOhook as Hook
    // Log which native module actually loaded. A degraded uiohook tap throttles
    // system-wide typing (see prds/shipped/…uiohook-typing-swallow-bug.md) and the
    // one confirmed cause was a stray native binary copied in from another worktree.
    // That degraded state loads fine — there's no JS probe for it — so the actionable
    // signal is this line: if typing lag ever recurs, the log shows the resolved
    // binary path, making a wrong/mismatched copy obvious instead of a mystery.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const resolved = require.resolve('uiohook-napi')
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const version = require('uiohook-napi/package.json').version
      console.log(`uiohook loaded: v${version} from ${resolved}`)
    } catch {
      // Version/path introspection is best-effort; never block the hook on it.
    }
  } catch (err) {
    console.error('uiohook load failed; capture hotkey + event logging disabled:', err)
    hook = null
  }
  return hook
}

export function isAvailable(): boolean {
  return load() !== null
}

const registered: Array<{ event: string; cb: Listener }> = []

export function on(event: string, cb: Listener): () => void {
  const k = load()
  if (!k) return () => {}
  k.on(event, cb)
  registered.push({ event, cb })
  return () => {
    if (k.removeListener) k.removeListener(event, cb)
    const i = registered.findIndex((r) => r.event === event && r.cb === cb)
    if (i !== -1) registered.splice(i, 1)
  }
}

/** Acquire a reference to the running hook. Returns a release fn. */
export function acquire(): () => void {
  const k = load()
  if (!k) return () => {}
  refs++
  if (refs === 1) {
    try {
      k.start()
    } catch (err) {
      console.error('uiohook start failed:', err)
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    refs = Math.max(0, refs - 1)
    if (refs === 0) {
      try {
        k.stop()
      } catch (err) {
        console.error('uiohook stop failed:', err)
      }
    }
  }
}
