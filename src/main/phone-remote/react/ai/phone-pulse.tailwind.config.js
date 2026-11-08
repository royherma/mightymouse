import root from '../../../../../tailwind.config.js'

export default {
  presets: [root],
  important: '.phonePulse',
  corePlugins: { preflight: false },
  content: {
    relative: true,
    files: [
      '../../../../renderer/src/components/session-pulse.tsx',
      '../../../../shared/ui/**/*.{ts,tsx}',
      '../../../../renderer/src/components/Tooltip.tsx'
    ]
  }
}
