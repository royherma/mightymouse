import { ipcMain, webContents } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import { REPORT_RANGES, type ProjectReport, type ReportRange } from '../../shared/reports'
import { getReport, isStale, refreshReport } from '../reports/runner'

function send(report: ProjectReport): void {
  webContents.getAllWebContents().forEach((wc) => wc.send(CHANNELS.reportsChanged, report))
}

function range(value: unknown): ReportRange {
  return REPORT_RANGES.includes(value as ReportRange) ? (value as ReportRange) : REPORT_RANGES[0]
}

function refresh(projectId: string, days: ReportRange, env?: string): Promise<ProjectReport> {
  return refreshReport(projectId, days, env, send).then((report) => (send(report), report))
}

export function registerReportsHandlers(): void {
  ipcMain.handle(
    CHANNELS.reportsGet,
    async (_, projectId: string, days: unknown, ifStale?: boolean, env?: string) => {
      const report = await getReport(projectId, range(days), env)
      if (!ifStale || report.running || !isStale(report)) return report
      void refresh(projectId, report.range, report.env)
      return { ...report, running: true }
    }
  )

  ipcMain.handle(CHANNELS.reportsRefresh, (_, projectId: string, days: unknown, env?: string) =>
    refresh(projectId, range(days), env)
  )
}
