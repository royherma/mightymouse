export const VK = {
  shift: 0x10,
  ctrl: 0x11,
  alt: 0x12,
  lwin: 0x5b,
  back: 0x08,
  tab: 0x09,
  enter: 0x0d
} as const

export interface KeyStroke {
  vk: number
  extended: boolean
}

export interface Chord {
  modifiers: number[]
  key: KeyStroke
}

const NAMED: Record<string, KeyStroke> = {
  return: { vk: 0x0d, extended: false },
  tab: { vk: 0x09, extended: false },
  space: { vk: 0x20, extended: false },
  delete: { vk: 0x08, extended: false },
  escape: { vk: 0x1b, extended: false },
  pageup: { vk: 0x21, extended: true },
  pagedown: { vk: 0x22, extended: true },
  end: { vk: 0x23, extended: true },
  home: { vk: 0x24, extended: true },
  left: { vk: 0x25, extended: true },
  up: { vk: 0x26, extended: true },
  right: { vk: 0x27, extended: true },
  down: { vk: 0x28, extended: true },
  f4: { vk: 0x73, extended: false }
}

const MODIFIER_NAMES: Record<string, 'ctrl' | 'alt' | 'shift' | 'win' | 'cmd' | 'fn'> = {
  cmd: 'cmd',
  command: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  option: 'alt',
  alt: 'alt',
  shift: 'shift',
  win: 'win',
  fn: 'fn'
}

function namedKey(name: string): KeyStroke | null {
  if (NAMED[name]) return NAMED[name]
  const f = /^f([1-9]|1[0-2])$/.exec(name)
  return f ? { vk: 0x70 + Number(f[1]) - 1, extended: false } : null
}

export function chordFor(combo: string, vkOfChar: (ch: string) => number | null): Chord | null {
  const parts = combo.toLowerCase().split('+')
  const baseName = parts.pop() ?? ''
  if (!baseName) return null
  const held = new Set<'ctrl' | 'alt' | 'shift' | 'win' | 'cmd'>()
  for (const p of parts) {
    const m = MODIFIER_NAMES[p]
    if (!m) return null
    if (m !== 'fn') held.add(m)
  }

  const bareModifier = MODIFIER_NAMES[baseName]
  if (bareModifier) {
    if (bareModifier === 'fn') return null
    const vk = { ctrl: VK.ctrl, cmd: VK.ctrl, alt: VK.alt, shift: VK.shift, win: VK.lwin }[
      bareModifier
    ]
    return { modifiers: [], key: { vk, extended: false } }
  }

  let key = namedKey(baseName)
  if (!key && baseName.length === 1) {
    const vk = vkOfChar(baseName)
    if (vk !== null) key = { vk, extended: false }
  }
  if (!key) return null

  if (held.has('cmd')) {
    held.delete('cmd')
    if (baseName === 'tab') held.add('alt')
    else if (baseName === 'q') {
      held.add('alt')
      key = NAMED.f4
    } else if (baseName === 'space') {
      held.add('win')
      key = vkOfChar('s') !== null ? { vk: vkOfChar('s') as number, extended: false } : null
    } else if (baseName === 'left') key = NAMED.home
    else if (baseName === 'right') key = NAMED.end
    else {
      held.add('ctrl')
      if (baseName === 'up') key = NAMED.home
      else if (baseName === 'down') key = NAMED.end
    }
    if (!key) return null
  } else if (
    held.has('alt') &&
    (baseName === 'left' || baseName === 'right' || baseName === 'delete')
  ) {
    held.delete('alt')
    held.add('ctrl')
  }

  const modifiers: number[] = []
  if (held.has('ctrl')) modifiers.push(VK.ctrl)
  if (held.has('alt')) modifiers.push(VK.alt)
  if (held.has('shift')) modifiers.push(VK.shift)
  if (held.has('win')) modifiers.push(VK.lwin)
  return { modifiers, key }
}
