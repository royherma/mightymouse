/** @type {import('tailwindcss').Config} */
// Theme values map to the CSS variables injected by injectTheme() (src/renderer/src/theme.ts)
// from CONFIG.THEME_TOKENS (src/shared/config.ts). config.ts stays the single source of truth.
//
// THEME_TOKENS are full `rgba(r, g, b, a)` STRINGS, not bare channels, so
// Tailwind's usual `rgb(var(--x) / <alpha-value>)` trick can't work. Given a
// plain `var(--x)`, Tailwind silently emits NO rule for any opacity modifier:
// `bg-green/12` lands in the DOM and computes to transparent, with a green
// typecheck and green tests. color-mix() composites the alpha at paint time
// instead, so every `/N` modifier resolves. Kept identical to
// portal/tailwind.config.js — the shared dashboard renders in BOTH hosts, and
// a token that's opacity-capable in only one of them is a class that works on
// the web and vanishes in the desktop window.
//
// opacityValue is only a NUMBER for an explicit `/N` modifier. For a solid
// utility Tailwind passes the string `var(--tw-bg-opacity)`, which has no
// numeric value — multiplying it yields `NaN%` and invalidates the whole
// declaration, turning every solid color transparent. Only mix when it's a
// real number; otherwise emit the plain var.
const tok = (name) => ({ opacityValue }) => {
  const alpha = Number(opacityValue)
  return Number.isFinite(alpha)
    ? `color-mix(in srgb, var(${name}) ${alpha * 100}%, transparent)`
    : `var(${name})`
}

export default {
  content: [
    './src/renderer/index.html',
    './src/renderer/src/**/*.{ts,tsx}',
    // The shared admin-dashboards are imported by AdminApp — scan them so their
    // Tailwind classes survive purge in the Electron window too. BOTH globs are
    // required: AdminApp renders v2, and v1 still supplies formatters + charts.
    // Missing the v2 glob silently purges v2-only classes (green typecheck,
    // green tests, broken layout). Adding a v3 dir? Add its glob here too.
    './src/shared/admin-dashboard/**/*.{ts,tsx}',
    './src/shared/admin-dashboard-v2/**/*.{ts,tsx}',
    // New shared folder under src/shared/ needs its glob in all three Tailwind configs, or its classes purge.
    './src/shared/ui/**/*.{ts,tsx}',
    './src/shared/support/**/*.{ts,tsx}'
  ],
  theme: {
    // Replace the default palette so only brand tokens are reachable.
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      white: '#fff',
      black: '#000',
      bg: tok('--bg'),
      'bg-hover': tok('--bg-hover'),
      'bg-dark': tok('--bg-dark'),
      orange: tok('--orange'),
      surface1: tok('--surface1'),
      surface2: tok('--surface2'),
      surface3: tok('--surface3'),
      accent: tok('--accent'),
      'accent-wash': tok('--accent-wash'),
      'accent-text': tok('--accent-text'),
      'accent-brand': tok('--accent-brand'),
      'on-accent': tok('--on-accent'),
      'border-subtle': tok('--border-subtle'),
      violet: tok('--violet'),
      cyan: tok('--cyan'),
      blue: tok('--blue'),
      magenta: tok('--magenta'),
      green: tok('--green'),
      'green-light': tok('--green-light'),
      red: tok('--red'),
      'red-light': tok('--red-light'),
      amber: tok('--amber'),
      yellow: tok('--yellow'),
      'on-surface': tok('--on-surface'),
      muted: tok('--muted'),
      'muted-dark': tok('--text-muted-dark')
    },
    borderRadius: {
      none: '0',
      xs: 'var(--radius-xs)',
      sm: 'var(--radius-sm)',
      md: 'var(--radius-md)',
      lg: 'var(--radius-lg)',
      xl: 'var(--radius-lg)', // 21 call sites use rounded-xl; without this it emits nothing and renders square
      full: '9999px'
    },
    extend: {
      // Spacing intentionally NOT overridden — Tailwind's default 4px scale already
      // matches our --space-* tokens (1=4px … 6=24px) and keeps fractional steps
      // (1.5, 2.5, 3.5) which the components rely on.
      // The shared dashboard shell's nav-change transition. Duplicated in
      // portal/tailwind.config.js: the shell is shared but each host generates
      // its own CSS, so defining it once means the other host silently gets no
      // animation. Keep the two in sync.
      keyframes: {
        'page-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'none' }
        }
      },
      animation: {
        'page-in': 'page-in 180ms ease-out both'
      },
      fontSize: {
        micro: 'var(--font-micro)',
        xs: 'var(--font-xs)',
        sm: 'var(--font-sm)',
        md: 'var(--font-md)',
        mlg: 'var(--font-mlg)',
        lg: 'var(--font-lg)',
        xlg: 'var(--font-xlg)',
        xl: 'var(--font-xl)',
        display: 'var(--font-display)'
      },
      fontFamily: {
        sans: ['-apple-system', 'SF Pro Display', 'system-ui', 'sans-serif', 'Apple Color Emoji'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
      },
      boxShadow: {
        panel: 'var(--shadow-panel)',
        popover: 'var(--shadow-popover)',
        card: 'var(--shadow-card)',
        bubble: 'var(--shadow-bubble)',
        focus: 'var(--focus-ring)',
        inset: 'var(--shadow-inset)'
      }
    }
  },
  plugins: []
}
