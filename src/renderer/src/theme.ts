import { CONFIG } from '../../shared/config'

export function injectTheme(): void {
  const root = document.documentElement
  const tokens = CONFIG.THEME_TOKENS

  for (const [key, val] of Object.entries(tokens)) {
    const cssKey = `--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`
    root.style.setProperty(cssKey, val)
  }
}
