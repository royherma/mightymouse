import { PHONE_AUDIO_TO, type PhoneAudioDestination } from '@shared/types'

/** Identity of the mounted mic buttons, so a bind effect can key on the nodes
 *  themselves rather than on a proxy for them. See docs/gotchas.md. */

/** `.proMicBtn` is TouchpadLayout's mic button. */
export const THOUGHT_MIC_CLASS = 'aiThoughtMic'
export const MIC_SELECTOR = `.proMicBtn, .${THOUGHT_MIC_CLASS}`

/** Mic plus Cancel/Stop — leftover iOS pointerdown after latch hits any of these. */
export const MIC_CHROME_SELECTOR = `${MIC_SELECTOR}, .micSideBtn`

/** Array, not the live NodeList — cleanup must unbind what it bound. */
export function findMicNodes(root: ParentNode): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(MIC_SELECTOR))
}

/** Order counts: the split deck's two mics swapping means a rebind. */
export function sameMicNodes(a: readonly Element[], b: readonly Element[]): boolean {
  return a.length === b.length && a.every((el, i) => el === b[i])
}

export function micDestinationOf(el: Element): PhoneAudioDestination {
  return el.classList.contains(THOUGHT_MIC_CLASS) ? PHONE_AUDIO_TO.note : PHONE_AUDIO_TO.paste
}
