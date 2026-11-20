import { MIGHTY } from '../store/mighty'
import { devLog } from '../../shared/env'
import { mightyProjectForCwd } from '../../shared/relay-sessions'
import type { ChatProjectWire } from '../../shared/phone-remote-protocol'
import {
  decideTalk,
  talkRankingOf,
  TALK,
  TALK_MODE_CRITERIA,
  TALK_MODE_INSTRUCTIONS,
  type TalkCandidate,
  type TalkDecision
} from '../../shared/talk'
import { rankSinks, JEV_CONFIDENCE_FLOOR } from '../voice-routing/jev-client'
import { collectAgentSinks, type AgentSink } from '../voice-routing/agent-sinks'
import { collectNewAgentSinks, type NewAgentSink } from '../voice-routing/new-agent-sink'
import { readScreenContext, forRanking, forDelivery } from '../voice-routing/screen-context'
import { warmJev, canDecide } from '../actions/decide-transport'
import { projectImageBase64 } from '../ipc/phone-remote-chat'

export type TalkSink = AgentSink | NewAgentSink

export interface TalkRoute extends TalkDecision {
  sinks: ReadonlyMap<string, TalkSink>
  screenHeader: string
}

function projectWire(cwd: string | undefined, fallback: string): ChatProjectWire {
  const project = mightyProjectForCwd(cwd, MIGHTY.listProjects())
  if (!project) return { name: fallback }
  return {
    name: project.name,
    icon: project.icon,
    imageBase64: projectImageBase64(project.imagePath)
  }
}

function agentDetail(sink: AgentSink): string {
  return [sink.branch, sink.activity].filter((part) => part !== '').join(' · ')
}

function candidateOf(sink: TalkSink): TalkCandidate {
  if (sink.kind === 'agent') {
    return {
      id: sink.id,
      kind: 'agent',
      label: sink.label,
      detail: agentDetail(sink),
      project: projectWire(sink.session.cwd, sink.project)
    }
  }
  return {
    id: sink.id,
    kind: 'new-agent',
    label: sink.label,
    detail: 'Starts fresh with just this',
    project: projectWire(sink.cwd, sink.project)
  }
}

function collectTalkSinks(): TalkSink[] {
  const agents = collectAgentSinks()
  const fresh = collectNewAgentSinks(
    collectAgentSinks({ includeStale: true }),
    MIGHTY.listProjects()
  )
  return [...agents, ...fresh]
}

export async function routeTalk(text: string): Promise<TalkRoute> {
  warmJev()
  const sinks = collectTalkSinks()
  const byId = new Map(sinks.map((s) => [s.id, s]))
  const candidates = sinks.map(candidateOf)
  const screen = await readScreenContext().catch(() => null)
  const screenHeader = forDelivery(screen)

  if (candidates.length === 0 || !(await canDecide())) {
    return { ...decideTalk(candidates, null, JEV_CONFIDENCE_FLOOR), sinks: byId, screenHeader }
  }

  const ranking = await rankSinks(text, [], sinks, '', forRanking(screen), {
    state: {},
    questions: {
      [TALK.MODE_QUESTION]: {
        type: 'choice',
        instructions: TALK_MODE_INSTRUCTIONS,
        criteria: TALK_MODE_CRITERIA
      }
    }
  }).catch((err: unknown) => {
    devLog.warn('[talk] ranking failed', err)
    return null
  })
  const decision = decideTalk(candidates, talkRankingOf(ranking), JEV_CONFIDENCE_FLOOR)
  return { ...decision, sinks: byId, screenHeader }
}
