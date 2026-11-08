/** The one piece of keyboard state. `none` is a real state, not an absence. */
export type KeyboardMode = 'none' | 'native' | 'virtual'

export function pillTarget(mode: KeyboardMode, prefersVirtual: boolean): KeyboardMode {
  const wanted: KeyboardMode = prefersVirtual ? 'virtual' : 'native'
  return mode === wanted ? 'none' : wanted
}

export function resolveSwitchToNative(focusTook: boolean): KeyboardMode {
  return focusTook ? 'native' : 'virtual'
}

export function reconcileNative(state: {
  mode: KeyboardMode
  occludedPx: number
  minOcclusionPx: number
  sheetOpen: boolean
}): KeyboardMode {
  if (state.mode !== 'native') return state.mode
  if (state.sheetOpen) return state.mode
  return state.occludedPx <= state.minOcclusionPx ? 'none' : state.mode
}

export function keyboardInputFocusable(mode: KeyboardMode): boolean {
  return mode !== 'virtual'
}

export function barHostVisible(mode: KeyboardMode, host: 'native' | 'virtual'): boolean {
  return mode === host
}

export function floatingBarVisible(mode: KeyboardMode, adapterId: string | null): boolean {
  return mode === 'none' && adapterId != null
}
