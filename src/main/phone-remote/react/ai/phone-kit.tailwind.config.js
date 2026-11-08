import root from '../../../../../tailwind.config.js'

export default {
  presets: [root],
  important: ':where(body)',
  corePlugins: { preflight: false },
  content: { relative: true, files: ['../../../../shared/ui/**/*.{ts,tsx}', '../../../../shared/session-info.tsx'] }
}
