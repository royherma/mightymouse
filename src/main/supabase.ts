import { existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync } from 'fs';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CONFIG } from '../shared/config';
import { PATHS } from './store/paths';
import { encryptLine, decryptLine, isEncryptedLine, isEncryptionAvailable } from './store/safe-storage';
import { logStorageKey } from './auth-diagnostic';

/**
 * The Supabase client lives ONLY in the main process. The renderer never sees
 * the anon key; it reaches auth + analytics through IPC (window.api.auth / .track).
 *
 * Supabase's JS auth machinery assumes a browser-style localStorage. In Electron
 * main (Node) there is none, so we give it a tiny fs-backed adapter that persists
 * the session to ~/MightyMouse/auth-session.json. This lets the SDK auto-refresh
 * tokens and keep the user signed in across app restarts with no browser.
 */
// The session file holds a live Supabase JWT — higher-value than history, so it's
// ALWAYS encrypted via safeStorage (not behind the dev toggle) when the OS supports
// it. Stored as a single encrypted-envelope line; a legacy plaintext file is read
// transparently and re-encrypted (after a one-time backup) on the next write.
const fsStorage = {
  getItem(_key: string): string | null {
    try {
      if (!existsSync(PATHS.AUTH_SESSION)) {
        logStorageKey('get', _key, false);
        return null;
      }
      const raw = readFileSync(PATHS.AUTH_SESSION, 'utf-8');
      // decryptLine returns legacy plaintext as-is, decrypts envelopes, null on fail.
      const val = decryptLine(raw);
      logStorageKey('get', _key, val !== null);
      return val;
    } catch {
      logStorageKey('get', _key, false);
      return null;
    }
  },
  setItem(_key: string, value: string): void {
    try {
      // One-time backup before overwriting a still-plaintext session file.
      if (
        isEncryptionAvailable() &&
        existsSync(PATHS.AUTH_SESSION) &&
        !isEncryptedLine(readFileSync(PATHS.AUTH_SESSION, 'utf-8'))
      ) {
        try {
          copyFileSync(PATHS.AUTH_SESSION, PATHS.AUTH_SESSION + '.plaintext.bak');
        } catch {
          // best-effort backup; don't block the write
        }
      }
      writeFileSync(PATHS.AUTH_SESSION, encryptLine(value), 'utf-8');
    } catch (err) {
      console.error('Failed to persist auth session:', err);
    }
  },
  removeItem(_key: string): void {
    try {
      if (existsSync(PATHS.AUTH_SESSION)) unlinkSync(PATHS.AUTH_SESSION);
    } catch (err) {
      console.error('Failed to clear auth session:', err);
    }
  }
};

let client: SupabaseClient | null = null;

// Offline-quiet fetch. GoTrue's background token-refresh timer fires `fetch` on its
// own schedule; when a DNS/network blip hits, undici rejects with a verbose multi-
// line `TypeError: fetch failed` + `[cause] ENOTFOUND` dump that GoTrue logs raw —
// pure noise, since GoTrue retries next tick and the session stays valid. We can't
// stop GoTrue from logging, but we can hand it a compact one-line error instead of
// undici's stack, so the console stays readable. Non-network failures (HTTP 4xx/5xx
// come back as a real Response, not a throw) are untouched and surface normally.
const N_NET = ['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN'];
const quietFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch (err) {
    const cause = (err as { cause?: { code?: string } })?.cause;
    const code = cause?.code ?? '';
    if (N_NET.includes(code)) {
      // Compact, single-line — no undici stack, no nested [cause] dump.
      throw new Error(`supabase offline (${code})`);
    }
    throw err;
  }
};

export function getSupabase(): SupabaseClient {
  if (client) return client;
  client = createClient(CONFIG.SUPABASE.URL, CONFIG.SUPABASE.ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: fsStorage,
      // Single fixed key — our adapter ignores the key and stores one session.
      storageKey: 'mightymouse-auth'
    },
    global: { fetch: quietFetch }
  });
  return client;
}
