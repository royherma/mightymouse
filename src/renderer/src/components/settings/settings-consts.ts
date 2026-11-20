import type { BackendId } from '../../../../shared/types'
import { CONFIG } from '../../../../shared/config'
import { type MultiSelectOption } from '../MultiSelectDropdown'
import { type ProviderIconId } from '../ProviderIcon'
import { CARD_CLS, SECTION_HEADER_CLS } from '../Card'

// Card + section-header classes now live in components/Card.tsx so every
// window shares one definition. Local aliases keep the 30+ usage sites terse.
export const cardCls = CARD_CLS
export const sectionCls = SECTION_HEADER_CLS
export const inputCls =
  'flex-1 w-full bg-surface2 border border-surface3 rounded-sm text-on-surface px-2.5 py-1.5 text-md font-mono outline-none transition-colors focus:border-accent focus:shadow-focus'
// Ghost text for a blank binary-path override input — shown when nothing is typed.
export const OVERRIDE_PATH_PLACEHOLDER = 'Override path (auto-detected)'
// Top-level grouping header (Essentials / Capture / Advanced). Heavier than the
// per-section sectionCls so the three buckets read as the primary structure.
export const bucketCls =
  'text-sm uppercase text-on-surface font-bold tracking-[0.12em] mt-8 mb-1 pb-1.5 border-b border-surface3'

// Auto-update status → human copy + a Badge color family. `idle`/`not-available`
// read as "up to date"; `available` is the actionable state.
export type UpdateUiKey =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'download-progress'
  | 'downloaded'
  | 'error'

export const UPDATE_STATUS_TEXT: Record<UpdateUiKey, string> = {
  idle: 'Up to date',
  checking: 'Checking for updates…',
  available: 'A newer version is ready to install',
  'not-available': 'Up to date',
  'download-progress': 'Downloading update…',
  downloaded: 'Update downloaded. Restart to install.',
  error: 'Update check failed'
}

export const UPDATE_BADGE: Record<UpdateUiKey, { color: string; label: string }> = {
  idle: { color: 'green', label: 'Up to date' },
  checking: { color: 'accent', label: 'Checking' },
  available: { color: 'amber', label: 'Update available' },
  'not-available': { color: 'green', label: 'Up to date' },
  'download-progress': { color: 'accent', label: 'Downloading' },
  downloaded: { color: 'amber', label: 'Ready' },
  error: { color: 'red', label: 'Error' }
}

export const SETUP_COPY = CONFIG.LOCAL_SETUP_COPY

// Why a setup run stopped, in the user's words. Keyed by the machine-readable
// reason main returns, so the renderer never parses tool output.
export const SETUP_FAIL_COPY: Record<string, string> = {
  'no-brew': SETUP_COPY.noBrew,
  'install-failed': SETUP_COPY.installFailed,
  'start-failed': SETUP_COPY.startFailed,
  'no-models': SETUP_COPY.noModels,
  'unsupported-arch': SETUP_COPY.unsupportedArch
}

// The 4 modes custom instructions can apply to — checklist items in the
// Instructions section's multi-select dropdown.
export const INSTRUCTIONS_MODE_OPTIONS: MultiSelectOption[] = [
  { value: 'rewrite', label: 'Rewrite' },
  { value: 'ask', label: 'Ask' },
  { value: 'act', label: 'Act' },
  { value: 'mighty', label: 'Mighty' }
]

export const MODELS: Array<{
  value: BackendId
  label: string
  description: string
  icon: ProviderIconId
  badge?: string
  // adminOnly providers are hidden from regular users' picker until someone
  // asks for them. Admins (advancedMenu) still see the full list.
  adminOnly?: boolean
}> = [
  {
    value: 'mightymouse',
    label: CONFIG.PRODUCT_NAME,
    icon: 'mightymouse',
    badge: 'Recommended',
    description: 'Just works. No account to connect.'
  },
  {
    value: 'claude',
    label: 'Claude',
    icon: 'claude',
    description: 'Use your existing Claude subscription.'
  },
  {
    value: 'codex',
    label: 'OpenAI Codex',
    icon: 'codex',
    description: 'Use your existing ChatGPT subscription.'
  },
  {
    value: 'opencode',
    label: 'OpenCode',
    icon: 'opencode',
    adminOnly: true,
    description: 'Use your existing OpenCode / OpenRouter account.'
  },
  {
    value: 'gemini',
    label: 'Gemini',
    icon: 'gemini',
    adminOnly: true,
    description: 'Use your existing Gemini CLI login.'
  },
  {
    value: 'local',
    label: 'Local',
    icon: 'local',
    adminOnly: true,
    description: 'Runs fully offline via Ollama. Nothing leaves your computer.'
  },
  {
    value: 'mlx',
    label: 'Rapid-MLX',
    icon: 'mlx',
    adminOnly: true,
    description:
      'Runs fully offline via Rapid-MLX. Fast Apple Silicon models, nothing leaves your Mac.'
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    icon: 'openrouter',
    adminOnly: true,
    description: 'Use your own OpenRouter key. Hundreds of models, billed by OpenRouter.'
  }
]
