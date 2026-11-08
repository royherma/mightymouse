import { ipcMain, webContents } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import { infraKind, infraProvider, type ProjectInfra, type TagField } from '../../shared/infra'
import { probeKeysFor } from '../keys/probes'
import { scanScope } from '../keys/scanner'
import { publishKeys } from './keys'
import {
  changeInfra,
  checkInfra,
  draftInfraBrief,
  listInfra,
  setInfraBrief,
  setInfraTags
} from '../infra/scan'
import { onInfraTracked, withLive } from '../infra/track'
import { getSite, publishSite, unpublishSite } from '../publish'
import { MIGHTY } from '../store/mighty'

function send(infra: ProjectInfra): void {
  webContents.getAllWebContents().forEach((wc) => wc.send(CHANNELS.infraChanged, infra))
}

function publish(infra: ProjectInfra): ProjectInfra {
  const live = withLive(infra)
  send(live)
  return live
}

export function registerInfraHandlers(): void {
  onInfraTracked(send)

  ipcMain.handle(CHANNELS.infraList, async () => (await listInfra()).map(withLive))

  ipcMain.handle(CHANNELS.infraCheck, async (_, projectId: string) => {
    const infra = await checkInfra(projectId)
    const providers = Object.entries(infra.record?.services ?? {}).flatMap(([kindId, entries]) =>
      entries.flatMap((e) => {
        const p = infraProvider(kindId, e.provider)
        return p?.keyProvider && !p.noKey ? [p.keyProvider] : []
      })
    )
    void Promise.all([scanScope(projectId), scanScope('global')])
      .catch(() => null)
      .then(() => probeKeysFor(projectId, providers))
      .then((n) => n && publishKeys(null))
    return publish(infra)
  })

  ipcMain.handle(CHANNELS.infraAdd, async (_, projectId: string, kindId: string, name: string) => {
    const label = name.trim().slice(0, 60)
    const known = infraKind(kindId)?.providers.find(
      (p) => p.id === label || p.label.toLowerCase() === label.toLowerCase()
    )
    const provider = known?.id ?? label.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    return publish(
      await changeInfra(projectId, (record) => {
        const list = record.services[kindId] ?? []
        if (!provider || list.some((e) => e.provider === provider)) return record
        record.services[kindId] = [...list, { provider, manual: true, ...(known ? {} : { label }) }]
        return record
      })
    )
  })

  ipcMain.handle(
    CHANNELS.infraRemove,
    async (_, projectId: string, kindId: string, provider: string) =>
      publish(
        await changeInfra(projectId, (record) => {
          record.services[kindId] = (record.services[kindId] ?? []).filter(
            (e) => !(e.manual && e.provider === provider)
          )
          return record
        })
      )
  )

  ipcMain.handle(
    CHANNELS.infraTags,
    async (_, projectId: string, field: TagField, values: string[] | null) =>
      publish(await setInfraTags(projectId, field === 'business' ? 'business' : 'appKinds', values))
  )

  ipcMain.handle(CHANNELS.infraBrief, async (_, projectId: string, brief: unknown) => {
    const result = await setInfraBrief(projectId, brief)
    const project = MIGHTY.getProject(projectId)
    // The bump is what makes the account copy take this edit; the brief lives in the repo folder, not on the project.
    if (result.record && project) MIGHTY.upsertProject({ ...project, updated: new Date().toISOString() })
    return publish(result)
  })

  ipcMain.handle(CHANNELS.infraBriefDraft, (_, projectId: string) => draftInfraBrief(projectId))

  ipcMain.handle(CHANNELS.infraSkip, async (_, projectId: string, kindId: string, skip: boolean) =>
    publish(
      await changeInfra(projectId, (record) => {
        record.skip = skip
          ? [...new Set([...record.skip, kindId])]
          : record.skip.filter((k) => k !== kindId)
        if (skip) record.want = (record.want ?? []).filter((k) => k !== kindId)
        return record
      })
    )
  )

  ipcMain.handle(CHANNELS.infraWant, async (_, projectId: string, kindId: string) =>
    publish(
      await changeInfra(projectId, (record) => {
        if (!infraKind(kindId)) return record
        record.want = [...new Set([...(record.want ?? []), kindId])]
        record.skip = record.skip.filter((k) => k !== kindId)
        return record
      })
    )
  )

  ipcMain.handle(CHANNELS.siteGet, (_, projectId: string) => getSite(projectId))
  ipcMain.handle(CHANNELS.sitePublish, (event, projectId: string, name: string) =>
    publishSite(projectId, name, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.siteProgress, progress)
    })
  )
  ipcMain.handle(CHANNELS.siteUnpublish, (_, projectId: string) => unpublishSite(projectId))

  ipcMain.handle(
    CHANNELS.infraSetup,
    async (
      _,
      projectId: string,
      kindId: string,
      setup: { provider: string; pane?: string } | null
    ) =>
      publish(
        await changeInfra(projectId, (record) => {
          const rest = { ...record.setups }
          delete rest[kindId]
          if (!setup) return { ...record, setups: rest }
          const had = (record.services[kindId] ?? []).map((e) => e.provider)
          const started = {
            provider: setup.provider,
            pane: setup.pane,
            startedAt: new Date().toISOString(),
            had
          }
          return { ...record, setups: { ...rest, [kindId]: started } }
        })
      )
  )
}
