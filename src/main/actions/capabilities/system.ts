import { execFile } from 'child_process'
import { warmAppIcons } from '../../capture/app-icon'
import { VERBS } from '../../intent-router'
import type {
  ActionDefinition,
  ActionRunInput,
  ActionRunResult,
  ActionSlotOption,
  Capability
} from '../../../shared/action-engine'

const INSTALLED_APPS_CACHE_MS = 60_000
const MDFIND_TIMEOUT_MS = 1_200

let appsCache: ActionSlotOption[] = []
let appsCacheAt = 0

function mdfindApps(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'mdfind',
      ["kMDItemContentType == 'com.apple.application-bundle'"],
      { timeout: MDFIND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : stdout.split('\n').filter((l) => l.trim() !== ''))
    )
  })
}

function appNameFromPath(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.app$/, '')
}

async function installedAppOptions(): Promise<ActionSlotOption[]> {
  const now = Date.now()
  if (now - appsCacheAt < INSTALLED_APPS_CACHE_MS && appsCache.length > 0) return appsCache

  const paths = await mdfindApps()
  const topLevel = paths.filter(
    (p) =>
      /^\/(Applications|System\/Applications)\/[^/]+\.app$/.test(p) ||
      /^\/Users\/[^/]+\/Applications\/[^/]+\.app$/.test(p)
  )
  // Not truncated here: decide.ts ranks the full list against what was said, so
  // cutting it early hides the app the user actually named behind the alphabet.
  const names = [...new Set(topLevel.map(appNameFromPath))].sort((a, b) => a.localeCompare(b))

  const options = names.map((name) => ({ value: name, label: name }))
  void warmAppIcons(names)
  appsCache = options
  appsCacheAt = now
  return options
}

const QUICK_OPEN = /^(?:(?:hey|hi|ok|okay)[\s,]+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:open|launch|start|switch to|bring up)\s+(?:up\s+)?(?:the\s+)?(.+?)(?:\s+app)?[\s.!?]*$/i
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

// "open <installed app>" runs with no model call; anything else returns null for decide.
export async function quickOpenApp(said: string): Promise<{ app: string; run: () => Promise<ActionRunResult> } | null> {
  const named = said.trim().match(QUICK_OPEN)?.[1]
  if (!named || named.split(/\s+/).length > 3) return null
  const want = squash(named)
  const app = (await installedAppOptions()).find((o) => squash(o.value) === want)?.value
  return app ? { app, run: () => runVerb('openApp', app) } : null
}

function verbResult(spoken: string, ok: boolean, line: string): ActionRunResult {
  return { ok, line: ok ? spoken || line : line }
}

async function runVerb(name: keyof typeof VERBS, arg: string): Promise<ActionRunResult> {
  const result = await VERBS[name].run(arg)
  if (result.ok) return verbResult(result.spoken, true, result.spoken)
  return verbResult('', false, `Could not run ${String(name)}.`)
}

function openApp(): ActionDefinition {
  return {
    id: 'system.openApp',
    capabilityId: 'system',
    title: 'Open app',
    when: 'The user names a Mac app they want opened, launched or switched to, and asks for nothing after that.',
    icon: 'app-window',
    runKind: 'builtin',
    safety: 'safe',
    triggers: ['voice', 'idle', 'phone'],
    slots: [
      {
        kind: 'choice',
        key: 'app',
        label: 'App',
        ask: 'Which app should open?',
        options: []
      }
    ],
    async run(input: ActionRunInput): Promise<ActionRunResult> {
      const app = String(input.slots.app ?? '')
      if (!app) return { ok: false, line: 'No app chosen.' }
      return runVerb('openApp', app)
    }
  }
}

function setVolume(): ActionDefinition {
  return {
    id: 'system.setVolume',
    capabilityId: 'system',
    title: 'Set volume',
    when: 'The user wants the Mac volume changed, raised, lowered or muted.',
    icon: 'volume-2',
    runKind: 'builtin',
    safety: 'safe',
    triggers: ['voice', 'idle', 'phone'],
    slots: [
      {
        kind: 'score',
        key: 'level',
        label: 'Volume',
        ask: 'What volume, 0 to 100?',
        min: 0,
        max: 100,
        unit: '%'
      }
    ],
    async run(input: ActionRunInput): Promise<ActionRunResult> {
      return runVerb('setVolume', String(input.slots.level ?? '50'))
    }
  }
}

function sleepMac(): ActionDefinition {
  return {
    id: 'system.sleep',
    capabilityId: 'system',
    title: 'Sleep Mac',
    when: 'The user wants the Mac put to sleep or locked.',
    icon: 'moon',
    runKind: 'builtin',
    safety: 'confirm',
    triggers: ['voice', 'phone'],
    slots: [],
    async run(): Promise<ActionRunResult> {
      return runVerb('sleep', '')
    }
  }
}

function startVoiceChat(): ActionDefinition {
  return {
    id: 'system.startChatGptVoice',
    capabilityId: 'system',
    title: 'Start ChatGPT voice',
    when: 'The user wants to start, open or begin a ChatGPT voice mode call.',
    icon: 'mic',
    runKind: 'builtin',
    safety: 'safe',
    triggers: ['voice', 'idle', 'phone'],
    slots: [],
    async run(): Promise<ActionRunResult> {
      return runVerb('startChatGptVoice', '')
    }
  }
}

function stopVoiceChat(): ActionDefinition {
  return {
    id: 'system.stopChatGptVoice',
    capabilityId: 'system',
    title: 'Stop ChatGPT voice',
    when: 'The user wants to stop, end or hang up ChatGPT voice mode.',
    icon: 'mic-off',
    runKind: 'builtin',
    safety: 'safe',
    triggers: ['voice', 'phone'],
    slots: [],
    async run(): Promise<ActionRunResult> {
      return runVerb('stopChatGptVoice', '')
    }
  }
}

export const SCREEN_ACTION_ID = 'system.screen'

function screenAnswer(): ActionDefinition {
  return {
    id: SCREEN_ACTION_ID,
    capabilityId: 'system',
    title: 'Answer about screen',
    when: 'The user asks to read, look at, describe or answer a question about what is on screen.',
    icon: 'camera',
    runKind: 'builtin',
    safety: 'safe',
    triggers: ['voice', 'phone'],
    slots: [{ kind: 'transcript', key: 'question', label: 'Question' }],
    async run(input: ActionRunInput): Promise<ActionRunResult> {
      return runVerb('screen', input.transcript)
    }
  }
}

export const systemCapability: Capability = {
  id: 'system',
  title: 'System',
  blurb: 'Open apps, change volume, sleep the Mac, ChatGPT voice, screen questions.',
  icon: 'zap',
  source: 'builtin',
  async listActions(): Promise<ActionDefinition[]> {
    const apps = await installedAppOptions()
    const openAppAction = openApp()
    openAppAction.slots = [
      { ...openAppAction.slots[0], options: apps } as (typeof openAppAction.slots)[0]
    ]
    return [
      openAppAction,
      setVolume(),
      sleepMac(),
      startVoiceChat(),
      stopVoiceChat(),
      screenAnswer()
    ]
  }
}
