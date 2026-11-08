import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['heroicons', '@heroicons/*', 'react-icons', 'react-icons/*', '@tabler/icons*', 'phosphor-react', '@radix-ui/react-icons'],
              message: 'lucide-react only (docs/conventions.md:130)'
            },
            {
              group: ['**/panel-window', '**/onboarding-window', '**/tour-window', '**/setup-window'],
              importNames: [
                'showPanelWindow',
                'showOnboardingWindow',
                'showTourWindow',
                'showSetupWindow'
              ],
              message:
                'Open a surface via route() in src/main/routing.ts — a direct show*Window() skips the signed-out gate (prds/active/*routing-chokepoint.md)'
            },
            {
              group: [
                '**/platform/macos',
                '**/platform/macos/*',
                '**/platform/macos/**',
                '**/platform/windows',
                '**/platform/windows/*',
                '**/platform/windows/**',
                '**/macos/*',
                '**/macos/**'
              ],
              message:
                'Import from src/main/platform (the OS boundary), never an OS dir directly — prds/active/*windows-feature-parity.md §4'
            }
          ]
        }
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "LogicalExpression[left.type='Identifier'][left.name='loading'][right.type='UnaryExpression'][right.operator='!']",
          message: 'gate on loading, not loading && !data (DESIGN.md rule 11)'
        }
      ]
    }
  },
  {
    // Routing IS the window boundary, so it must import the window modules the
    // rule above hides from everyone else. The window modules and their tests
    // are exempt too: they import each other's non-`show*` helpers (geometry,
    // reseed, visibility), which were never the thing being gated.
    files: [
      'src/main/routing.ts',
      'src/main/panel-window.ts',
      'src/main/onboarding-window.ts',
      'src/main/tour-window.ts',
      'src/main/setup-window.ts',
      'src/main/**/__tests__/**'
    ],
    rules: {
      'no-restricted-imports': 'off'
    }
  },
  {
    // The boundary itself must import its own OS impls — the restriction above
    // exists to stop everything OUTSIDE this dir from reaching in directly.
    files: ['src/main/platform/**'],
    rules: {
      'no-restricted-imports': 'off'
    }
  },
  eslintConfigPrettier
)
