import { createHash } from 'crypto'
import { isOwnBundleId } from '../../../shared/app-context'
import { CONFIG } from '../../../shared/config'
import { normalizeLabel } from '../../../shared/rank-options'
import { context } from '../../platform'
import { dumpElements } from '../capabilities/ui-dump'
import {
  isPressable,
  isTextTarget,
  rankElements,
  type AxElement,
  type AxFrame
} from '../capabilities/ui-rank'

export interface ScreenItem {
  key: string
  label: string
  role: string
  frame?: AxFrame
}

export interface Observation {
  bundleId: string
  appName: string
  windowTitle: string
  urlHost: string
  pressables: ScreenItem[]
  fields: ScreenItem[]
  offscreen: ScreenItem[]
  fingerprint: string
  frontIsTarget: boolean
  frontMs: number
  axMs: number
}

const SECURE_ROLE = 'AXSecureTextField'
const PASSWORD_LABEL_RE = /pass(word|code|phrase)|\bpin\b|security code|cvv|cvc/i

const ROLE_WORDS: Record<string, string> = {
  AXButton: 'button',
  AXLink: 'link',
  AXMenuItem: 'menu item',
  AXMenuButton: 'menu',
  AXPopUpButton: 'dropdown',
  AXCheckBox: 'checkbox',
  AXRadioButton: 'option',
  AXTab: 'tab',
  AXTextField: 'text field',
  AXTextArea: 'text area',
  AXSearchField: 'search field',
  AXComboBox: 'search field',
  [SECURE_ROLE]: 'password field'
}

export function isSecretField(item: ScreenItem): boolean {
  return item.role === SECURE_ROLE || PASSWORD_LABEL_RE.test(item.label)
}

export function describeItem(item: ScreenItem): string {
  const label = item.label.slice(0, CONFIG.COMPUTER_USE.MAX_LABEL_CHARS)
  return `${ROLE_WORDS[item.role] ?? 'control'}: ${label}`
}

function isField(el: AxElement): boolean {
  return (isTextTarget(el) || el.role === SECURE_ROLE) && normalizeLabel(el.label) !== ''
}

function urlHostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function toItems(
  elements: readonly AxElement[],
  goal: string,
  prefix: string,
  keep: (el: AxElement) => boolean,
  limit: number
): ScreenItem[] {
  const firstOf = new Map<string, AxElement>()
  for (const el of elements) {
    if (!keep(el)) continue
    const label = normalizeLabel(el.label)
    if (!firstOf.has(label)) firstOf.set(label, el)
  }
  return rankElements(elements, { transcript: goal, limit, keep }).map((option, i) => ({
    key: `${prefix}${i + 1}`,
    label: option.value,
    role: firstOf.get(option.value)?.role ?? '',
    frame: firstOf.get(option.value)?.frame
  }))
}

export async function observeScreen(
  goal: string,
  fallbackBundleIds: readonly string[]
): Promise<Observation> {
  const frontStarted = Date.now()
  const front = await context.readFrontmostScreen().catch(() => null)
  const frontMs = Date.now() - frontStarted

  const frontIsUs = isOwnBundleId(front?.bundleId ?? '')
  const bundleId =
    front && !frontIsUs
      ? front.bundleId
      : (fallbackBundleIds.find((id) => id !== '' && !isOwnBundleId(id)) ?? '')

  const axStarted = Date.now()
  const elements = bundleId === '' ? [] : await dumpElements(bundleId)
  const axMs = Date.now() - axStarted

  const visible = elements.filter((el) => el.offscreen !== true)
  const fieldLimit = Math.floor(CONFIG.COMPUTER_USE.MAX_ITEMS / 4)
  const fields = toItems(visible, goal, 'f', isField, fieldLimit)
  const pressables = toItems(
    visible,
    goal,
    'c',
    isPressable,
    CONFIG.COMPUTER_USE.MAX_ITEMS - fields.length
  )

  const shown = new Set(visible.filter(isPressable).map((el) => normalizeLabel(el.label)))
  const offscreen = toItems(
    elements.filter((el) => el.offscreen === true && !shown.has(normalizeLabel(el.label))),
    goal,
    'o',
    isPressable,
    CONFIG.COMPUTER_USE.MAX_OFFSCREEN_ITEMS
  )

  const windowTitle = frontIsUs ? '' : (front?.title ?? '')
  const fingerprint = createHash('sha1')
    .update(bundleId)
    .update(windowTitle)
    .update(elements.map((el) => `${el.role}:${el.label}`).join('\n'))
    .digest('hex')

  return {
    bundleId,
    appName: frontIsUs ? bundleId : (front?.appName ?? bundleId),
    windowTitle,
    urlHost: frontIsUs ? '' : urlHostOf(front?.url ?? ''),
    pressables,
    fields,
    offscreen,
    fingerprint,
    frontIsTarget: front !== null && !frontIsUs,
    frontMs,
    axMs
  }
}
