import type { MightyExportFormat, MightySession } from '../../shared/types'

interface ExportMessage {
  role: 'user' | 'assistant'
  content: string
  ts: string
  model?: string
}

function toMessages(session: MightySession): ExportMessage[] {
  return session.turns.flatMap((t) => [
    { role: 'user' as const, content: t.q, ts: t.ts },
    { role: 'assistant' as const, content: t.a, ts: t.ts, model: t.model }
  ])
}

function toMarkdown(session: MightySession): string {
  const lines = [`# ${session.title || 'Chat'}`, '', `Created: ${session.created}`, '']
  for (const t of session.turns) {
    lines.push(`## ${t.ts}`, '', '**You:**', '', t.q, '', `**${t.model ?? t.backend}:**`, '', t.a, '')
  }
  return lines.join('\n')
}

export function exportSession(session: MightySession, format: MightyExportFormat): string {
  if (format === 'json') {
    return JSON.stringify(
      { title: session.title, created: session.created, messages: toMessages(session) },
      null,
      2
    )
  }
  return toMarkdown(session)
}
