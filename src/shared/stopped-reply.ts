// Mirrored byte-for-byte at supabase/functions/_shared/stopped-reply.ts (stopped-reply.test.ts fails on drift).
export const STOPPED_MARK = '[Stopped before it finished]'

export function partialWorthKeeping(text: string): boolean {
  return text.trim().length > 0
}

export function stoppedReply(partial: string, fallback: string): string {
  return partialWorthKeeping(partial) ? `${partial.trimEnd()}\n\n${STOPPED_MARK}` : fallback
}
