/**
 * Phone Remote — the iOS share-sheet tail (text typed at the cursor, an image
 * pasted from the clipboard) plus the two referral endpoints (code + invite
 * email), both thin Edge-function proxies gated on a live Supabase session.
 */
import { clipboard, nativeImage } from 'electron'
import { resolvePhotoAnswer } from '../agent-relay/photo-search'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { CONFIG } from '../../shared/config'
import { isValidInviteEmail, normalizeInviteEmail } from '../../shared/invite-email'
import { devLog } from '../../shared/env'
import { PATHS } from '../store/paths'
import { input } from '../platform'
import { EVENTS } from '../store/events'
import { getSupabase } from '../supabase'
import { sendToPhone } from '../phone-remote/server'
import { phoneMayControlMac } from './phone-remote'
import { sendClipboardState } from './phone-remote-context'
import { relayRequestStore } from '../agent-relay/store'

export async function handleShareText(text: string, submit: boolean): Promise<void> {
  if (!phoneMayControlMac()) return
  const typed = await input.typeText(text, 'text').catch((err) => {
    devLog.error('Phone Remote: share text failed', err)
    return false
  })
  if (!typed) return
  if (submit) await input.typeText('return', 'key')
  EVENTS.append({
    run_id: `phone-share:${randomUUID().slice(0, 8)}`,
    event: 'phone_share_text',
    chars: text.length,
    submitted: submit
  })
}

/** Puts an image from the phone on the Mac's clipboard and pastes it at the
 *  cursor. Shared by both entry points -- the WS binary frame and the share
 *  extension's POST -- so the two surfaces differ only in transport.
 *
 *  `submit` presses Return after the paste. It is the phone's call, not the
 *  Mac's: pasting into the wrong window is recoverable, sending is not. */
/** An image the user attached to a reply they are still typing, held until the
 *  `relaySessionReply` for that agent arrives. Keyed by session label.
 *
 *  A Map rather than a field on the wire message: the bytes and the text are two
 *  separate messages (the picker fires when they choose the photo, the reply when
 *  they hit send), and only the Mac may hold a filesystem path -- see the
 *  `replyToLabel` note in phone-remote-protocol.ts. Last write wins, so picking a
 *  second photo replaces the first rather than queueing one they forgot about. */
const pendingReplyImages = new Map<string, string>()

/** Takes the path attached to this agent's next reply, if there is one. Reading
 *  it CLEARS it: an image belongs to the one message it was attached to, and a
 *  path left behind would ride the next unrelated reply as well. */
export function takeReplyImagePath(label: string): string | undefined {
  const path = pendingReplyImages.get(label)
  if (path) pendingReplyImages.delete(label)
  return path
}

export async function handlePhoneImage(
  data: Buffer,
  mime: string,
  name: string,
  submit: boolean,
  requestId?: string,
  replyToLabel?: string
): Promise<void> {
  if (!phoneMayControlMac()) return
  // Decoded before anything is written: a buffer that isn't really an image
  // yields an empty nativeImage, and pasting that clears the user's clipboard
  // for nothing.
  const image = nativeImage.createFromBuffer(data)
  if (image.isEmpty()) {
    sendToPhone({ type: 'imageFailed', reason: "That image couldn't be read" })
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const folder = join(PATHS.CAPTURES, `shot-${stamp}`)
  const ext = mime === 'image/png' ? 'png' : 'jpg'
  const imagePath = join(folder, `image.${ext}`)
  try {
    mkdirSync(folder, { recursive: true })
    writeFileSync(imagePath, data)
  } catch (err) {
    // Kept on disk so a paste that lands nowhere still has a recovery path;
    // failing to save is not a reason to abandon the paste itself.
    devLog.error('Phone Remote: failed to save image', err)
  }

  // Attached to a reply in progress: hold the path for the message that is
  // still being typed. Stops here for the same reason the photos_get branch
  // does -- this picture was aimed at one agent, not at the Mac's cursor.
  if (replyToLabel) {
    pendingReplyImages.set(replyToLabel, imagePath)
    sendToPhone({ type: 'imagePasted', name, submitted: false })
    EVENTS.append({
      run_id: `phone-img:${randomUUID().slice(0, 8)}`,
      event: 'phone_image_attached',
      folder,
      bytes: data.length,
      submitted: false
    })
    return
  }

  // Answering a photos_get: the agent asked for this file, so it resolves that
  // request and stops here. Pasting as well would drop a picture into whatever
  // window happens to be frontmost, which nobody asked for.
  if (requestId) {
    // A photosFetch the agent asked for directly: no card was ever minted, so
    // the broker's waiter is the only thing to answer. Tried FIRST because
    // relayRequestStore would report 'unknown' for these and send the user a
    // failure toast for a transfer that actually worked.
    if (resolvePhotoAnswer(requestId, imagePath, 'fetch')) {
      EVENTS.append({
        run_id: `phone-img:${randomUUID().slice(0, 8)}`,
        event: 'phone_image_pulled',
        folder,
        bytes: data.length,
        submitted: false
      })
      return
    }
    // 'chip', not a new member: `via` names the control that produced the
    // answer, and picking a photo is a tap on the card like any other.
    const settled = relayRequestStore.resolve(requestId, { imagePath }, null, 'chip')
    if (settled === 'unknown' || settled === 'already-resolved') {
      // The card timed out or was answered elsewhere while they were scrolling.
      // Said out loud rather than swallowed: the photo really did arrive, and
      // silence here reads to the user as a failed send.
      sendToPhone({ type: 'imageFailed', reason: 'That photo request already closed' })
      return
    }
    sendToPhone({ type: 'imagePasted', name, submitted: false })
    EVENTS.append({
      run_id: `phone-img:${randomUUID().slice(0, 8)}`,
      event: 'phone_image_pulled',
      folder,
      bytes: data.length,
      submitted: false
    })
    return
  }

  clipboard.writeImage(image)
  // Cmd+V through the same path as the pasteClipboard key, NOT pasteText():
  // that helper writes TEXT to the clipboard first, which would overwrite the
  // image we just put there.
  const pasted = await input.typeText('cmd+v', 'key').catch((err) => {
    devLog.error('Phone Remote: image paste failed', err)
    return false
  })
  if (!pasted) {
    sendToPhone({ type: 'imageFailed', reason: "Couldn't paste on your Mac" })
    return
  }

  // Return rides the same input path as any other key, but only after the paste
  // actually reported success -- submitting into a field that never received
  // the image is the one outcome this flag must not produce.
  if (submit) await input.typeText('return', 'key')

  sendClipboardState()
  sendToPhone({ type: 'imagePasted', name, submitted: submit })
  EVENTS.append({
    run_id: `phone-img:${randomUUID().slice(0, 8)}`,
    event: 'phone_image_pasted',
    folder,
    bytes: data.length,
    submitted: submit
  })
}

export async function sendReferralCode(): Promise<void> {
  try {
    const { data } = await getSupabase().auth.getSession()
    const token = data.session?.access_token
    if (!token) {
      sendToPhone({ type: 'referralCode', error: 'signed_out' })
      return
    }

    const resp = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/referral-code`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    })

    if (!resp.ok) {
      devLog.warn('Phone Remote: referral-code fetch failed', resp.status)
      sendToPhone({ type: 'referralCode', error: 'unavailable' })
      return
    }

    const body = (await resp.json()) as { code?: string; link?: string; referred_count?: number }
    if (!body.code || !body.link) {
      sendToPhone({ type: 'referralCode', error: 'unavailable' })
      return
    }

    sendToPhone({
      type: 'referralCode',
      code: body.code,
      link: body.link,
      referredCount: body.referred_count ?? 0
    })
  } catch (err) {
    devLog.error('Phone Remote: referral-code error', err)
    sendToPhone({ type: 'referralCode', error: 'unavailable' })
  }
}

export async function sendInvite(email: unknown): Promise<void> {
  try {
    // Re-derive from the raw wire value; never trust that the phone validated.
    // This is the boundary guard: everything arriving over WS is
    // attacker-controllable once the tunnel is on.
    if (!isValidInviteEmail(email)) {
      sendToPhone({ type: 'inviteResult', error: 'invalid_email' })
      return
    }
    const recipient = normalizeInviteEmail(email as string)

    const { data } = await getSupabase().auth.getSession()
    const token = data.session?.access_token
    if (!token) {
      sendToPhone({ type: 'inviteResult', error: 'signed_out' })
      return
    }

    const resp = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/referral-invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: recipient })
    })

    // The slug is read off the body rather than mapped from the status code:
    // 400 covers invalid/disposable/self-invite, which need different copy.
    const body = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string }

    if (!resp.ok) {
      devLog.warn('Phone Remote: referral-invite failed', resp.status, body.error)
      sendToPhone({ type: 'inviteResult', error: body.error ?? 'unavailable' })
      return
    }

    // A skipped send (already a member, or unsubscribed) reports success on
    // purpose — see the Edge function. Telling the sender which address is
    // already registered would make this a membership oracle.
    sendToPhone({ type: 'inviteResult', ok: true })
  } catch (err) {
    devLog.error('Phone Remote: referral-invite error', err)
    sendToPhone({ type: 'inviteResult', error: 'unavailable' })
  }
}

export function handleGetReferralCode(): void {
  void sendReferralCode()
}

export function handleSendInvite(msg: { email: unknown }): void {
  // The address is validated inside sendInvite, not here: msg.email is a
  // wire string, and this switch is the boundary it first crosses.
  void sendInvite(msg.email)
}
