// Mirrors supabase/functions/_shared/support.ts (separate Deno bundle).
export const SUPPORT_LIMITS = { BODY_MAX: 4000 } as const

export const SUPPORT_FN = { send: 'support-send', admin: 'support-admin' } as const

export const OPEN_SPECIALIST_EVENT = 'mm:open-specialist'

export type SupportSender = 'user' | 'staff'
export type SupportThreadStatus = 'open' | 'waiting_on_user' | 'closed'

export interface SupportSpecialist {
  name: string
  photoUrl: string | null
  online: boolean
}

export interface SupportMessage {
  id: number
  sender: SupportSender
  staffName: string | null
  body: string
  createdAt: string
  receipt?: SupportReceipt
}

export type SupportEmailReceipt = 'sent' | 'failed' | 'opened' | 'clicked'

export interface SupportReceipt {
  seenInChat: boolean
  email: SupportEmailReceipt | null
}

export interface SupportState {
  specialist: SupportSpecialist
  threadId: number | null
  messages: SupportMessage[]
}

export interface SupportContext {
  surface: 'web' | 'mac'
  appVersion?: string
  platform?: string
  page?: string
  lastError?: string
}

export interface SupportClient {
  load(): Promise<SupportState>
  send(body: string): Promise<SupportState>
  /** Fires when a message lands for this user; returns the unsubscribe. */
  subscribe(onChange: () => void): () => void
  markSeen?(): Promise<unknown>
}

export interface SupportInboxThread {
  id: number
  email: string | null
  status: SupportThreadStatus
  subject: string
  lastMessage: string
  lastSender: SupportSender
  lastMessageAt: string
  unread: boolean
  plan: string
  receipt: SupportReceipt | null
}

export interface SupportInboxList {
  threads: SupportInboxThread[]
  medianFirstReplyMs: number | null
}

export interface SupportInboxThreadDetail {
  id: number
  email: string | null
  status: SupportThreadStatus
  signedUpAt: string | null
  plan: string
  creditsCents: number | null
  context: Partial<SupportContext>
  userLastSeenAt: string | null
  messages: SupportMessage[]
}

export interface SupportInboxPerson {
  userId: string
  email: string
  lastSignInAt: string
}

export type SupportAdminCall = <T>(body: Record<string, unknown>) => Promise<T>

export async function callSupportFn<T>(
  url: string,
  authHeader: string,
  body: Record<string, unknown>
): Promise<T> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify(body)
  })
  if (!resp.ok) throw new Error(`${resp.status}`)
  return (await resp.json()) as T
}
