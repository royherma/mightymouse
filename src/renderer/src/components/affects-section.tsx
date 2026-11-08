import { useEffect, useState } from 'react'
import {
  AppWindow,
  Box,
  Cloud,
  Eye,
  FlaskConical,
  Laptop,
  Layers,
  PanelsTopLeft,
  Rocket,
  Smartphone,
  Touchpad,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type { AppKind } from '../../../shared/infra'
import { reportEnvLabel } from '../../../shared/reports'
import {
  NO_AFFECTS,
  type AffectedEnv,
  type AffectedSurface,
  type SessionAffects
} from '../../../shared/surfaces'
import { RailSection } from './agent-context-rail'
import { shortWhen } from './session-facts'
import './affects-section.css'

type Tone = 'desktop' | 'mobile' | 'web' | 'cloud' | 'prod' | 'staging' | 'plain'
type Look = [LucideIcon, Tone]

const BY_NAME: ReadonlyArray<[RegExp, Look]> = [
  [/remote|trackpad/i, [Touchpad, 'mobile']],
  [/iphone|ios|android|phone|mobile/i, [Smartphone, 'mobile']],
  [/landing|marketing|site|blog/i, [PanelsTopLeft, 'web']],
  [/cloud|backend|api|server|worker|function/i, [Cloud, 'cloud']],
  [/mac|desktop|windows/i, [Laptop, 'desktop']]
]
const BY_KIND: Record<AppKind, Look> = {
  mobile: [Smartphone, 'mobile'],
  desktop: [Laptop, 'desktop'],
  web: [AppWindow, 'web'],
  worker: [Cloud, 'cloud']
}
const ENVS: Record<string, Look> = {
  prod: [Rocket, 'prod'],
  staging: [FlaskConical, 'staging'],
  preview: [Eye, 'plain'],
  dev: [Wrench, 'plain']
}
const STATED = 'Named by the agent'

function surfaceLook(surface: AffectedSurface): Look {
  const named = BY_NAME.find(([re]) => re.test(surface.name))?.[1]
  return named ?? (surface.kind ? BY_KIND[surface.kind] : [Box, 'plain'])
}

function surfaceMeta(surface: AffectedSurface, now: number): string {
  if (surface.files) {
    return `${surface.files} ${surface.files === 1 ? 'file' : 'files'} · ${shortWhen(surface.lastAt, now)}`
  }
  return surface.reads ? `Reading · ${shortWhen(surface.lastAt, now)}` : STATED
}

function envMeta(env: AffectedEnv, now: number): string {
  if (env.asked) return `Asked for · ${shortWhen(env.lastAt, now)}`
  return env.lastAt ? `Deployed ${shortWhen(env.lastAt, now)}` : STATED
}

function Row(props: {
  look: Look
  name: string
  meta: string
  env?: boolean
  faint?: boolean
}): React.JSX.Element {
  const [Icon, tone] = props.look
  return (
    <li
      className="affects-row"
      data-env={props.env || undefined}
      data-faint={props.faint || undefined}
    >
      <span className="affects-icon" data-tone={tone}>
        <Icon size={14} strokeWidth={2} />
      </span>
      <span className="affects-name">{props.name}</span>
      <span className="affects-meta">{props.meta}</span>
    </li>
  )
}

export function AffectsSection(props: {
  sessionRef: string
  refreshKey: string
  now: number
  open: boolean
  onToggle: () => void
}): React.JSX.Element | null {
  const [state, setState] = useState<{ ref: string; affects: SessionAffects }>({
    ref: props.sessionRef,
    affects: NO_AFFECTS
  })
  useEffect(() => {
    let live = true
    void window.api.agentRelaySessionAffects(props.sessionRef).then(
      (affects) => {
        if (live) setState({ ref: props.sessionRef, affects })
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [props.sessionRef, props.refreshKey])
  const { surfaces, envs } = state.ref === props.sessionRef ? state.affects : NO_AFFECTS
  if (surfaces.length + envs.length === 0) return null
  return (
    <RailSection
      title="Affects"
      icon={Layers}
      open={props.open}
      onToggle={props.onToggle}
      badge={String(surfaces.length + envs.length)}
    >
      <ul className="affects-list">
        {surfaces.map((surface) => (
          <Row
            key={surface.name}
            look={surfaceLook(surface)}
            name={surface.name}
            meta={surfaceMeta(surface, props.now)}
            faint={surface.files === 0 && surface.reads > 0}
          />
        ))}
        {envs.map((env) => (
          <Row
            key={`env:${env.name}`}
            look={ENVS[env.name] ?? [Box, 'plain']}
            name={reportEnvLabel(env.name)}
            meta={envMeta(env, props.now)}
            faint={env.asked}
            env
          />
        ))}
      </ul>
    </RailSection>
  )
}
