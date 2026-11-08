import { shell } from 'electron'
import { input, captureSelection } from '../../platform'
import { devLog } from '../../../shared/env'
import { fastRewriteErrorText, runFastRewriteAndPaste } from '../../fast-rewrite'
import type {
  ActionContextSnapshot,
  ActionDefinition,
  ActionRunInput,
  ActionRunResult,
  ActionSlotOption,
  Capability
} from '../../../shared/action-engine'

// Jev picks a friendly name, never a raw combo — the closed list is what keeps
// it from synthesising a keystroke nobody offered.
export const KEY_COMBOS: readonly { value: string; label: string; combo: string; confirm?: true }[] = [
  { value: 'save', label: 'Save', combo: 'cmd+s' },
  { value: 'copy', label: 'Copy', combo: 'cmd+c' },
  { value: 'paste', label: 'Paste', combo: 'cmd+v' },
  { value: 'cut', label: 'Cut', combo: 'cmd+x' },
  { value: 'undo', label: 'Undo', combo: 'cmd+z' },
  { value: 'redo', label: 'Redo', combo: 'cmd+shift+z' },
  { value: 'selectAll', label: 'Select all', combo: 'cmd+a' },
  { value: 'find', label: 'Find', combo: 'cmd+f' },
  { value: 'newTab', label: 'New tab', combo: 'cmd+t' },
  { value: 'reopenTab', label: 'Reopen closed tab', combo: 'cmd+shift+t' },
  { value: 'back', label: 'Go back', combo: 'cmd+[' },
  { value: 'forward', label: 'Go forward', combo: 'cmd+]' },
  { value: 'refresh', label: 'Refresh', combo: 'cmd+r' },
  { value: 'enter', label: 'Press Return', combo: 'return' },
  { value: 'escape', label: 'Press Escape', combo: 'escape' },
  { value: 'tab', label: 'Press Tab', combo: 'tab' },
  { value: 'closeTab', label: 'Close tab', combo: 'cmd+w', confirm: true },
  { value: 'closeWindow', label: 'Close window', combo: 'cmd+shift+w', confirm: true },
  { value: 'delete', label: 'Delete', combo: 'delete', confirm: true }
]

const SCROLL_STEPS: readonly { value: string; label: string; dy: number; repeat: number }[] = [
  { value: 'down', label: 'Down', dy: -8, repeat: 1 },
  { value: 'up', label: 'Up', dy: 8, repeat: 1 },
  { value: 'pageDown', label: 'Down a lot', dy: -8, repeat: 6 },
  { value: 'pageUp', label: 'Up a lot', dy: 8, repeat: 6 },
  { value: 'bottom', label: 'To the bottom', dy: -8, repeat: 40 },
  { value: 'top', label: 'To the top', dy: 8, repeat: 40 }
]

export const SITES: readonly { value: string; label: string; url: string }[] = [
  { value: 'gmail', label: 'Gmail', url: 'https://mail.google.com' },
  { value: 'calendar', label: 'Google Calendar', url: 'https://calendar.google.com' },
  { value: 'drive', label: 'Google Drive', url: 'https://drive.google.com' },
  { value: 'github', label: 'GitHub', url: 'https://github.com' },
  { value: 'youtube', label: 'YouTube', url: 'https://youtube.com' },
  { value: 'maps', label: 'Google Maps', url: 'https://maps.google.com' },
  { value: 'chatgpt', label: 'ChatGPT', url: 'https://chatgpt.com' },
  { value: 'claude', label: 'Claude', url: 'https://claude.ai' },
  { value: 'linkedin', label: 'LinkedIn', url: 'https://linkedin.com' },
  { value: 'x', label: 'X', url: 'https://x.com' },
  { value: 'reddit', label: 'Reddit', url: 'https://reddit.com' },
  { value: 'amazon', label: 'Amazon', url: 'https://amazon.com' }
]

// Between repeats: the scroll is a CGEvent per tick and a tight loop lands them
// faster than a view can redraw, which reads as one jump instead of a scroll.
const SCROLL_GAP_MS = 16

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function typeAction(): ActionDefinition {
  return {
    id: 'input.type',
    capabilityId: 'input',
    title: 'Type what you said',
    when:
      'The user wants words typed into whatever field is focused right now — dictating a ' +
      'reply, filling in a box, writing a message. Not for a command telling the computer ' +
      'to do something.',
    icon: 'file-text',
    runKind: 'builtin',
    safety: 'safe',
    triggers: ['voice', 'phone'],
    slots: [{ kind: 'transcript', key: 'text', label: 'Text' }],
    async run(runInput: ActionRunInput): Promise<ActionRunResult> {
      const text = runInput.transcript.trim()
      if (text === '') return { ok: false, line: 'Nothing to type.' }

      const ok = await input.typeText(text)
      devLog.log('[input.type]', text.length, 'chars', ok)
      if (!ok) return { ok: false, line: 'Could not type that.' }
      return { ok: true, line: `Typed "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}".` }
    }
  }
}

function rewriteAction(): ActionDefinition {
  return {
    id: 'input.rewrite',
    capabilityId: 'input',
    title: 'Rewrite the selected text',
    when:
      'The user asks for text to be changed in place — rewrite, reword, ' +
      'shorten, fix, translate, or give other versions of it. Not for a question about the text.',
    icon: 'sparkles',
    runKind: 'builtin',
    safety: 'safe',
    triggers: ['voice', 'phone'],
    slots: [{ kind: 'transcript', key: 'instruction', label: 'Instruction' }],
    async run(runInput: ActionRunInput): Promise<ActionRunResult> {
      const instruction = runInput.transcript.trim()
      // Apps that hide their selection from Accessibility (Claude, other Electron) only give it up to a real ⌘C.
      const selection = runInput.selection.trim() !== '' ? runInput.selection : await captureSelection()
      if (selection.trim() === '') return { ok: false, line: 'Select the text first, then ask again.' }
      if (instruction === '') return { ok: false, line: 'No instruction to rewrite with.' }

      const result = await runFastRewriteAndPaste(instruction, selection)
      devLog.log('[input.rewrite]', instruction.length, 'chars', result.ok)
      return result.ok
        ? { ok: true, line: 'Rewrote the selected text.' }
        : { ok: false, line: fastRewriteErrorText(result) }
    }
  }
}

function keyAction(confirm: boolean): ActionDefinition {
  const combos = KEY_COMBOS.filter((k) => Boolean(k.confirm) === confirm)
  const options: ActionSlotOption[] = combos.map((k) => ({ value: k.value, label: k.label }))
  return {
    id: confirm ? 'input.keyRisky' : 'input.key',
    capabilityId: 'input',
    title: confirm ? 'Close or delete' : 'Press a keyboard shortcut',
    when: confirm
      ? 'The user wants to close a tab or window, or delete something, using the keyboard.'
      : 'The user names a standard editing or browsing shortcut — save, copy, paste, undo, ' +
        'select all, find, refresh, go back, new tab, or pressing Return, Escape or Tab.',
    icon: 'zap',
    runKind: 'builtin',
    safety: confirm ? 'confirm' : 'safe',
    triggers: ['voice', 'phone'],
    slots: [{ kind: 'choice', key: 'combo', label: 'Shortcut', ask: 'Which shortcut?', options }],
    async run(runInput: ActionRunInput): Promise<ActionRunResult> {
      const value = String(runInput.slots.combo ?? '')
      const entry = combos.find((k) => k.value === value)
      if (!entry) return { ok: false, line: 'No shortcut chosen.' }

      const ok = await input.pressKeys([entry.combo])
      devLog.log('[input.key]', entry.combo, ok)
      return ok
        ? { ok: true, line: `${entry.label}.` }
        : { ok: false, line: `Could not press ${entry.label}.` }
    }
  }
}

function scrollAction(): ActionDefinition {
  const options: ActionSlotOption[] = SCROLL_STEPS.map((s) => ({ value: s.value, label: s.label }))
  return {
    id: 'input.scroll',
    capabilityId: 'input',
    title: 'Scroll',
    when:
      'The user wants the current window scrolled — up, down, to the top or to the bottom, ' +
      'or asks to see more of what is below or above.',
    icon: 'app-window',
    runKind: 'builtin',
    safety: 'safe',
    triggers: ['voice', 'phone'],
    slots: [
      { kind: 'choice', key: 'direction', label: 'Direction', ask: 'Scroll which way?', options }
    ],
    async run(runInput: ActionRunInput): Promise<ActionRunResult> {
      const value = String(runInput.slots.direction ?? '')
      const step = SCROLL_STEPS.find((s) => s.value === value)
      if (!step) return { ok: false, line: 'No direction chosen.' }

      // scrollFast returns void — there is no success to await, so the honest
      // report is that we sent it, not that anything moved.
      for (let i = 0; i < step.repeat; i++) {
        input.scrollFast(step.dy, 0)
        if (i < step.repeat - 1) await wait(SCROLL_GAP_MS)
      }
      devLog.log('[input.scroll]', step.value, step.repeat)
      return { ok: true, line: `Scrolled ${step.label.toLowerCase()}.` }
    }
  }
}

function navigateAction(): ActionDefinition {
  const options: ActionSlotOption[] = SITES.map((s) => ({ value: s.value, label: s.label }))
  return {
    id: 'input.navigate',
    capabilityId: 'input',
    title: 'Open a website',
    when: 'The user names a website or web app they want opened in their browser.',
    icon: 'globe',
    runKind: 'url',
    safety: 'safe',
    triggers: ['voice', 'phone'],
    slots: [{ kind: 'choice', key: 'site', label: 'Site', ask: 'Which site?', options }],
    async run(runInput: ActionRunInput): Promise<ActionRunResult> {
      const value = String(runInput.slots.site ?? '')
      const site = SITES.find((s) => s.value === value)
      if (!site) return { ok: false, line: 'No site chosen.' }

      try {
        await shell.openExternal(site.url)
      } catch {
        return { ok: false, line: `Could not open ${site.label}.` }
      }
      return { ok: true, line: `Opened ${site.label}.` }
    }
  }
}

export const inputCapability: Capability = {
  id: 'input',
  title: 'Typing and scrolling',
  blurb: 'Type what you say, rewrite the selected text, press a shortcut, scroll the window, or open a site.',
  icon: 'zap',
  source: 'builtin',
  async listActions(ctx: ActionContextSnapshot): Promise<ActionDefinition[]> {
    // No front app means no window to type into or scroll; only navigate still
    // makes sense, and it opens a browser of its own accord.
    if (ctx.bundleId === '') return [rewriteAction(), navigateAction()]
    return [typeAction(), rewriteAction(), keyAction(false), keyAction(true), scrollAction(), navigateAction()]
  }
}
