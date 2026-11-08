// The colour/spacing tokens every surface reads (DESIGN.md rule 12 — nothing
// hardcodes a colour). Split out of config.ts as a self-contained 128 lines.

export const THEME_TOKENS = {
  // Surfaces — neutral glass (cool white base, less mocha)
  bg: 'rgba(246, 245, 243, 0.96)',
  surface1: 'rgba(255, 255, 255, 0.90)',
  // Fully opaque surface1. Modals on the transparent panel window must NOT let
  // the desktop bleed through the card (the glass tokens all carry alpha).
  surfaceSolid: 'rgba(255, 255, 255, 1.00)',
  surface2: 'rgba(239, 237, 234, 0.92)',
  surface3: 'rgba(231, 228, 224, 1.00)',
  accentWash: 'rgba(252, 239, 228, 1.00)',
  onSurface: 'rgba(28, 26, 24, 1.00)',
  muted: 'rgba(104, 99, 92, 1.00)',
  textMutedDark: 'rgba(85, 80, 74, 1.00)',
  textMutedMedium: 'rgba(104, 99, 92, 1.00)',
  textMutedLight: 'rgba(104, 99, 92, 1.00)',

  // accent = filled controls + selection only; accentText for orange text; accentBrand never as text
  accent: 'rgba(194, 80, 26, 1.00)',
  accentBgSubtle: 'rgba(252, 239, 228, 1.00)',
  accentBorderSubtle: 'rgba(194, 80, 26, 0.30)',
  accentRgb: '194, 80, 26',
  onAccent: 'rgba(255, 255, 255, 1.00)',
  accentText: 'rgba(169, 72, 22, 1.00)',
  accentBrand: 'rgba(242, 140, 63, 1.00)',
  accentBrandRgb: '242, 140, 63',
  // Smart-dictation accent (screen-aware, double-tap): blue/violet so the
  // waveform reads as clearly different from plain-dictation orange. Consumed
  // as the `--accent-rgb` CSS var by WaveformViz in the smartListen HUD branch.
  accentSmartRgb: '120, 130, 255',

  // Signal colors
  green: 'rgba(26, 120, 66, 1.00)',
  greenBgSubtle: 'rgba(231, 243, 236, 1.00)',
  greenBgSubtleAlt: 'rgba(218, 237, 226, 1.00)',
  greenBorderSubtle: 'rgba(26, 120, 66, 0.30)',
  greenLight: 'rgba(46, 158, 92, 1.00)',
  greenRgb: '26, 120, 66',

  red: 'rgba(192, 53, 43, 1.00)',
  redBgSubtle: 'rgba(251, 234, 232, 1.00)',
  redBgSubtleActive: 'rgba(247, 220, 217, 1.00)',
  redBgSubtleAlt: 'rgba(249, 227, 224, 1.00)',
  redBorderSubtle: 'rgba(192, 53, 43, 0.30)',
  redLight: 'rgba(214, 69, 58, 1.00)',
  redRgb: '192, 53, 43',

  violet: 'rgba(111, 76, 201, 1.00)',
  violetBgSubtle: 'rgba(240, 236, 252, 1.00)',
  violetBorderSubtle: 'rgba(111, 76, 201, 0.30)',

  cyan: 'rgba(14, 122, 110, 1.00)',
  cyanBgSubtle: 'rgba(226, 244, 241, 1.00)',
  cyanBorderSubtle: 'rgba(14, 122, 110, 0.30)',

  amber: 'rgba(154, 91, 0, 1.00)',
  amberBgSubtle: 'rgba(251, 241, 223, 1.00)',
  amberBorderSubtle: 'rgba(154, 91, 0, 0.30)',

  // Cool blue — the only true blue. Used by Switch (on), spinners, and the
  // `write` mode badge (distinct from the warm accent).
  blue: 'rgba(43, 102, 204, 1.00)',
  blueBgSubtle: 'rgba(230, 238, 251, 1.00)',
  blueBorderSubtle: 'rgba(43, 102, 204, 0.30)',
  blueRgb: '43, 102, 204',

  rose: 'rgba(190, 50, 110, 1.00)',
  roseBgSubtle: 'rgba(251, 232, 240, 1.00)',
  roseBorderSubtle: 'rgba(190, 50, 110, 0.30)',
  roseRgb: '190, 50, 110',

  yellow: 'rgba(224, 178, 40, 1.00)',

  // Error/destructive accent. Shares red's hue (errors read as red) but kept a
  // distinct token so error surfaces can diverge later without touching `red`.
  magenta: 'rgba(192, 53, 43, 1.00)',
  magentaBgSubtle: 'rgba(251, 234, 232, 1.00)',
  magentaBorderSubtle: 'rgba(192, 53, 43, 0.30)',
  grayMuted: 'rgba(104, 99, 92, 1.00)',

  // Explicit orange alias (playground swatches + direct future use)
  orange: 'rgba(242, 140, 63, 1.00)',
  orangeBgSubtle: 'rgba(252, 239, 228, 1.00)',
  orangeBorderSubtle: 'rgba(242, 140, 63, 0.40)',
  orangeRgb: '242, 140, 63',

  // Hideout: its own dark full-screen palette
  hideoutVoid: 'rgba(3, 6, 11, 1.00)',
  hideoutField: 'rgba(4, 8, 14, 1.00)',
  hideoutInk: 'rgba(238, 246, 250, 1.00)',
  hideoutInk2: 'rgba(222, 238, 246, 0.66)',
  hideoutInk3: 'rgba(200, 224, 238, 0.40)',
  hideoutHairRgb: '170, 215, 240',
  hideoutGlowRgb: '16, 48, 72',
  hideoutScrimRgb: '3, 7, 13',
  hideoutOnCyanRgb: '4, 16, 24',
  hideoutTileInk: 'rgba(233, 241, 247, 1.00)',
  hideoutTileBg: 'rgba(11, 22, 32, 1.00)',
  hideoutCyan: 'rgba(95, 212, 240, 1.00)',
  hideoutCyanRgb: '95, 212, 240',
  hideoutOrange: 'rgba(255, 160, 80, 1.00)',
  hideoutViolet: 'rgba(180, 150, 255, 1.00)',
  hideoutGreen: 'rgba(77, 187, 122, 1.00)',
  hideoutGreenRgb: '77, 187, 122',
  hideoutAmber: 'rgba(242, 178, 74, 1.00)',
  hideoutAmberRgb: '242, 178, 74',
  hideoutRed: 'rgba(255, 120, 110, 1.00)',
  hideoutRedRgb: '255, 120, 110',

  // Derived surfaces
  bgDark: 'rgba(231, 228, 224, 1.00)',
  curtainBlack: '#000000',
  windowBg: 'rgba(246, 245, 243, 1.00)',
  terminalBg: 'rgba(24, 24, 24, 1.00)',
  terminalFg: 'rgba(214, 214, 214, 1.00)',
  borderDark: 'rgba(218, 214, 209, 1.00)',
  borderSubtle: 'rgba(231, 228, 224, 1.00)',
  surface1Hover: 'rgba(246, 245, 243, 0.95)',
  surface1Alt: 'rgba(239, 237, 234, 0.92)',
  surfaceBorderAlt: 'rgba(218, 214, 209, 1.00)',
  bgHover: 'rgba(239, 237, 234, 0.97)',

  // RGB triplets
  bgRgb: '246, 245, 243',
  shadowRgb: '28, 26, 24', // near-black neutral
  whiteRgb: '255, 255, 255',

  // --space1 … --space8 (no dash before the digit)
  spaceXxs: '2px',
  spaceXs: '6px',
  space1: '4px',
  space2: '8px',
  space3: '12px',
  space4: '16px',
  space5: '20px',
  space6: '24px',
  space7: '32px',
  space8: '48px',

  radiusXs: '4px',
  radiusSm: '6px',
  radiusMd: '10px',
  radiusLg: '14px',
  radiusFull: '999px',

  fontMicro: '11px',
  fontXs: '11px',
  fontSm: '12px',
  fontMd: '13px',
  // fontMlg is the chat-body size: one notch above fontMd so the conversation
  // outweighs the chrome around it. Bumped 13→14 (2026-07-17) — 13/400 on the warm
  // surface read as the thinnest thing on screen despite being the content.
  fontMlg: '14px',
  fontLg: '16px',
  fontXlg: '16px',
  fontXl: '20px',
  fontDisplay: '28px',
  desktopFontMicro: '12px',
  desktopFontSecondary: '14px',
  desktopFontLabel: '15px',
  desktopFontBody: '16px',
  desktopGutter: '32px',
  desktopReadingWidth: '760px',

  shadowPopover: '0 4px 12px rgba(28, 26, 24, 0.08), 0 1px 3px rgba(28, 26, 24, 0.06)',
  shadowPanel: '0 24px 60px rgba(28, 26, 24, 0.18), 0 8px 20px rgba(28, 26, 24, 0.08)',
  shadowCard: '0 0 0 1px rgba(28, 26, 24, 0.06), 0 1px 2px rgba(28, 26, 24, 0.05)',
  shadowBubble: '0 1px 3px rgba(28, 26, 24, 0.06), 0 4px 12px rgba(28, 26, 24, 0.05)',
  shadowInset: 'inset 0 1px 2px rgba(28, 26, 24, 0.06)',
  focusRing: '0 0 0 2px rgba(246, 245, 243, 1.00), 0 0 0 4px rgba(194, 80, 26, 0.90)'
}
