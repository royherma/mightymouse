import { BrowserWindow, Notification, ipcMain } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { chrome } from './platform'
import { getSupabase } from './supabase'
import { CONFIG } from '../shared/config'
import { CHANNELS } from '../shared/ipc'
import { SUPPORT_FN, type SupportContext, type SupportState } from '../shared/support/types'

const WINDOW_ROUTE = 'specialist'
let win: BrowserWindow | null = null
let channel: RealtimeChannel | null = null

async function call(body: Record<string, unknown>): Promise<SupportState> {
  const { data } = await getSupabase().auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('not_signed_in')
  const resp = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/${SUPPORT_FN.send}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!resp.ok) throw new Error(`support-send ${resp.status}`)
  return (await resp.json()) as SupportState
}

async function watchReplies(knownUserId?: string): Promise<void> {
  const userId = knownUserId ?? (await getSupabase().auth.getSession()).data.session?.user.id
  if (!userId || channel) return
  channel = getSupabase()
    .channel(`support-${userId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'support_messages',
        filter: `user_id=eq.${userId}`
      },
      (change) => {
        if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.specialistChanged)
        else if ((change.new as { sender?: string }).sender === 'staff') {
          notifyStaffMessage(String((change.new as { body?: string }).body ?? ''))
        }
      }
    )
    .subscribe()
}

function notifyStaffMessage(body: string): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: 'Message from your Specialist',
    body: body.slice(0, 180)
  })
  notification.on('click', () => showSpecialistWindow())
  notification.show()
}

function stopWatching(): void {
  void channel?.unsubscribe()
  channel = null
}

export function showSpecialistWindow(): void {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return
  }
  win = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 360,
    minHeight: 420,
    title: `Ask a Specialist - ${CONFIG.APP_NAME}`,
    ...chrome.windowOptions('inset'),
    resizable: true,
    maximizable: false,
    show: false,
    backgroundColor: CONFIG.THEME_TOKENS.windowBg,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=${WINDOW_ROUTE}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: WINDOW_ROUTE } })
  }
  win.on('ready-to-show', () => {
    win?.show()
    win?.focus()
  })
  win.on('closed', () => {
    win = null
  })
  void watchReplies()
}

export function registerSpecialistHandlers(): void {
  getSupabase().auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || !session) stopWatching()
    else if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN')
      void watchReplies(session.user.id)
  })
  ipcMain.on(CHANNELS.specialistOpen, () => showSpecialistWindow())
  ipcMain.handle(CHANNELS.specialistLoad, () => call({ action: 'get' }))
  ipcMain.handle(CHANNELS.specialistSend, (_, body: string) => {
    const context: SupportContext = {
      surface: 'mac',
      appVersion: CONFIG.APP_VERSION,
      platform: process.platform
    }
    return call({ action: 'send', body, context })
  })
}
