/**
 * The module is plain JS in a TS include; this adjacent declaration types it.
 * Importing it defines <mm-pairing-explainer>; the one typed surface is the
 * deck-CSS hand-off.
 */
export class MMPairingExplainer extends HTMLElement {
  /** The app's real stylesheet text (theme.css + skin css), or a promise of
   *  it — boot() awaits either. Set before the element boots. */
  static deckCss: string | Promise<string>
  /** CONFIG.THEME_TOKENS — the bundle injects these as CSS vars at runtime,
   *  so the panel needs them too. */
  static themeTokens: Record<string, string> | Promise<Record<string, string>> | null
}
