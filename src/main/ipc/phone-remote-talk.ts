import { RUN_EVENT } from '../../shared/types'
import type { PhoneRemoteMessage } from '../../shared/phone-remote-protocol'
import { TALK, TALK_LABELS, talkId, talkText } from '../../shared/talk'
import { basename } from '../../shared/attachments'
import { sendToPhone } from '../phone-remote/server'
import { cancelTalk, findTalkSession, goTalk, offerTalk } from '../talk/talk-turn'
import platform from '../platform'
import { collectAgentSinks } from '../voice-routing/agent-sinks'
import { takeReplyImagePath } from './phone-remote-share'

type Msg<T extends PhoneRemoteMessage['type']> = Extract<PhoneRemoteMessage, { type: T }>

export async function handleTalkText(rawId: unknown, rawText: unknown, image?: string): Promise<void> {
  const id = talkId(rawId)
  const text = talkText(rawText) || (image ? TALK_LABELS.photoOnly : '')
  if (id === '' || text === '') return
  await offerTalk(id, text, {
    source: 'talk',
    attachments: image ? [{ path: image, kind: 'image', name: basename(image) }] : [],
    events: {
      offered: (decision) =>
        sendToPhone({ type: 'talkRoute', id, auto: decision.auto, pick: decision.pick, options: decision.options }),
      onPhase: (phase, detail) => sendToPhone({ type: 'talkStep', id, phase, detail }),
      onEvent: (event) => {
        if (event.kind === RUN_EVENT.text && event.text !== '')
          sendToPhone({ type: 'talkStep', id, chunk: event.text })
      }
    }
  })
}

export async function handleTalkGo(msg: Msg<'talkGo'>): Promise<void> {
  if (typeof msg.target !== 'string') return
  const id = talkId(msg.id)
  const outcome = await goTalk(id, msg.target)
  if (!outcome) return
  const { ok, reply, target, openLabel, media } = outcome
  sendToPhone({ type: 'talkDone', id, ok, reply, target, openLabel, media })
}

export function handleTalkSend(msg: Msg<'talkSend'>): void {
  const label = typeof msg.attachLabel === 'string' ? msg.attachLabel : ''
  const image = label.startsWith(TALK.ATTACH_PREFIX) ? takeReplyImagePath(label) : undefined
  void handleTalkText(msg.id, msg.text, image)
}

function recentAsks(): string[] {
  return [...(findTalkSession()?.turns ?? [])].reverse().map((t) => t.q.trim())
}

export function handleTalkIdeas(): void {
  const agent = collectAgentSinks()[0]
  const candidates = [
    ...recentAsks().slice(0, 1),
    ...(agent ? [TALK_LABELS.agentIdea.replace('{project}', agent.project)] : []),
    ...platform.context.listSwitchableApps().flatMap((app) => TALK_LABELS.appIdeas[app.bundleId] ?? []),
    ...TALK_LABELS.ideas
  ]
  const ideas = [...new Set(candidates.filter((idea) => idea !== '' && idea.length <= 60))]
  sendToPhone({ type: 'talkIdeas', ideas: ideas.slice(0, TALK.IDEAS_MAX) })
}

export function handleTalkCancel(msg: Msg<'talkCancel'>): void {
  cancelTalk(talkId(msg.id))
}
