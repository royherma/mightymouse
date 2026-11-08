import { CONFIG } from '@shared/config'
import { isRemoteSkinId, type InstallableSkin, type PhoneRemoteSkin } from '@shared/types'

/** Skins whose tokens are built over the LIGHT base and have no dark variant
 *  yet, so the pro root pins data-theme='light' regardless of the user's
 *  colour-scheme pref, and Settings hides the theme row for them.
 *
 *  Lives in its own module rather than next to either consumer: TouchpadLayout
 *  imports SettingsBody, so a constant defined in one and imported by the other
 *  is a cycle. Both import it from here instead.
 *
 *  Keep the pinning and the hidden row driven by THIS set, never by an inline
 *  `skin === 'x'` check — a skin listed here but missing from the other
 *  check shows a theme control that silently does nothing. */
export const LIGHT_PINNED_SKINS: ReadonlySet<PhoneRemoteSkin> = new Set<PhoneRemoteSkin>([
  'proII',
  'cap',
  'military',
  'amethyst'
])

/** One entry per skin, in display order. Adding a skin is this entry plus its
 *  CSS block, nothing else — no TypeScript beyond the union member.
 *
 *  `blurb` is the store's one-line pitch. Kept here beside the id rather than
 *  in the sheet's JSX so a skin stays describable in ONE place; the store is
 *  the only reader today, but a future picker elsewhere shouldn't have to
 *  re-invent the copy.
 *
 *  'default' is plain pro wearing only the base cascade, so it carries no
 *  data-skin value; see TouchpadLayout's data-skin attribute. */
export const SKIN_OPTIONS: ReadonlyArray<{
  id: PhoneRemoteSkin
  label: string
  blurb: string
}> = [
  { id: 'proII', label: 'Pro II', blurb: 'Brushed steel and clay. The default.' },
  /* 'cap', 'military' and 'amethyst' are deliberately absent: retired from the
     store, not deleted. The union member, CSS block and LIGHT_PINNED_SKINS entry
     all stay, so anyone already wearing it keeps it and putting the card back is
     one line. 'military' is the OLD v1 hand-sculpted olive skin, superseded by
     the remote image skin 'mil-spec-2' ("Field Unit") in the catalog — pulled
     from the picker so new users only see the new one. */
  /* 'amethyst' is deliberately absent: it is mid-rework, wearing a half-finished
     set of extracted assets, and the store is the only thing that offers a skin
     to a user. Everything else about it stays -- the union member, the CSS
     block, the asset directory, IMAGE_SKINS -- so putting the entry back is a
     one-line change once the art is settled.
     Anyone already wearing it keeps it: the pref still resolves and the CSS
     still applies, this only removes the card that hands it to someone new. */
  { id: 'default', label: 'Plain', blurb: 'No paint. Just the base layout.' }
]

/** Skins that paint surfaces with pictures instead of the token sculpt.
 *
 *  TouchpadLayout stamps `data-img-skin` on the pro root for these, and every
 *  rule in theme.css that REMOVES sculpt — the keycap's ::before top face, the
 *  baked-in glyph, the pad's hint label — hangs off that attribute.
 *
 *  Why a list and not "whichever skin sets a token": an image skin works by
 *  taking sculpt away, and absence cannot be expressed as a token value. The
 *  first version tried anyway, relying on @property to discard declarations
 *  whose token was unset. That works for PAINTING (`background-image:
 *  var(--pro-mic-img)` with no token is dropped by the cascade) and not at all
 *  for `display: none`, which contains no token to be missing. Shipped ungated,
 *  it deleted the keycaps, mic and icon row on every existing skin.
 *
 *  So the gate is explicit. Adding an image skin = one entry here plus its CSS
 *  block; forgetting this entry leaves the skin sculpted with pictures painted
 *  under it, which is visibly wrong on the skin being added rather than
 *  silently wrong on all the others.
 *
 *  BUILT-INS ONLY. A remote skin answers from its manifest instead — see
 *  isImageSkin() below. This set briefly carried a `'remote:<run>'` line per
 *  generated run, which meant editing and rebuilding the client to look at a
 *  skin the packager had already flagged; the manifest now carries it. */
export const IMAGE_SKINS: ReadonlySet<InstallableSkin> = new Set<InstallableSkin>(['amethyst'])

/** The nine elements an image skin can replace, in DOM order.
 *
 *  Each value is the `data-img` attribute the markup stamps, and it names
 *  WHICH token that button paints from (theme.css "IMAGE SKINS" relays
 *  `data-img='esc'` → `--pro-key-esc-img`). It does NOT say whether an image
 *  exists — within an image skin that is still decided per region by whether
 *  the CSS block sets the token, and @property registration keeps an unset one
 *  from blanking the surface.
 *
 *  The attribute is stamped unconditionally on every skin because on its own it
 *  is inert: it names a token and nothing more. What is NOT inert is the
 *  teardown, and that is gated by IMAGE_SKINS above. */
export const IMAGE_BUTTON_REGIONS = [
  'mic',
  'esc',
  'tab',
  'enter',
  'keyboard',
  'prev',
  'switcher',
  'settings',
  /* Not a button: the brand mark top-left, which is a bare emoji on the deck
     with no plate behind it. It is in this list because it paints the same way
     (one token, one relay), but its CSS differs -- it needs an explicit box,
     having no keycap geometry to inherit one from. On a skin with a stone deck
     and painted caps an unchanged 🐭 is the last thing still looking default. */
  'mark'
] as const
export type ImageButtonRegion = (typeof IMAGE_BUTTON_REGIONS)[number]

/** The skin Settings shows inline, without opening the store. Everything else
 *  lives behind the store button.
 *
 *  Why a set and not "SKIN_OPTIONS[0]": which skins are promoted is a product
 *  call, and encoding it as "whatever happens to be first" makes reordering
 *  the store silently change what Settings shows. */
export const INLINE_SKINS: ReadonlySet<PhoneRemoteSkin> = new Set<PhoneRemoteSkin>(['proII'])

/** One card in the store. Built-ins come from SKIN_OPTIONS; remote ones arrive
 *  from the local server's /_skins route, already installed and sanitised. */
export interface StoreSkinOption {
  id: InstallableSkin
  label: string
  blurb: string
  /** True for a remote skin — the store labels these so it's clear the range
   *  can grow without an app update. */
  remote: boolean
  lightOnly: boolean
  /** Paints pictures rather than the token sculpt, so its card must stamp
   *  data-img-skin to look like what tapping it gives you. Server-supplied for
   *  a remote skin; derived from IMAGE_SKINS for a built-in. */
  imageSkin: boolean
}

/** Next skin `steps` away from `current`, wrapping both directions.
 *
 *  The ring is the built-ins (SKIN_OPTIONS) followed by `installedRemote` — the
 *  remote skins ALREADY on the phone. That list is free to know: the page links
 *  /_skins.css on every load, so every installed remote skin is present at first
 *  paint with no catalog-host call. The corner tap does NOT fetch the catalog
 *  (/_skins), which is gated to a deliberate store open for privacy; it only
 *  cycles what is already installed.
 *
 *  `current` is force-included when it is not already in the ring, so stepping
 *  off a skin the caller didn't list (a just-installed one, or a stale inline
 *  snapshot) can never strand you with no way back to it. */
export function stepSkin(
  current: InstallableSkin,
  steps: number,
  installedRemote: readonly InstallableSkin[] = []
): InstallableSkin {
  const base: InstallableSkin[] = [...SKIN_OPTIONS.map((o) => o.id), ...installedRemote]
  const ring = base.includes(current) ? base : [current, ...base]
  const from = ring.indexOf(current)
  // +ring.length before the modulo: JS keeps the sign of the dividend, so a
  // backward step from index 0 would answer -1 without it.
  return ring[(from + steps + ring.length) % ring.length]
}

/** The buttons the inline Skin row renders: the promoted skin(s), plus whatever
 *  is currently WORN when that isn't already among them.
 *
 *  Pure and named because the worn half is the whole bug this fixes. It used to
 *  be a filter over SKIN_OPTIONS, which holds BUILT-INS ONLY — so `id === skin`
 *  could never be true for a `remote:` skin, and the row silently collapsed to
 *  an unselected "Pro II". A row that shows one unselected option reads as the
 *  current state, and tapping it wrote proII over the real choice, which is why
 *  this surfaced as the skin changing by itself rather than as a missing button.
 *
 *  `wornLabel` names a remote skin (its label lives in the Mac's manifest, not
 *  in this bundle). Falling back to the raw id keeps the button tappable for a
 *  skin that has since been uninstalled, rather than rendering a blank. */
export function inlineSkinRow(
  skin: InstallableSkin,
  wornLabel?: string
): Array<{ id: InstallableSkin; label: string }> {
  const promoted = SKIN_OPTIONS.filter((o) => INLINE_SKINS.has(o.id) || o.id === skin)
  if (promoted.some((o) => o.id === skin)) return promoted
  return [...promoted, { id: skin, label: wornLabel ?? skin }]
}

/** Whether a skin pins data-theme='light'.
 *
 *  Built-ins answer from LIGHT_PINNED_SKINS; remote skins carry `lightOnly` in
 *  their manifest, so the caller passes the ids it learned from /_skins. A
 *  single helper because the pinning and the hidden Settings theme row MUST
 *  agree — the comment on LIGHT_PINNED_SKINS warns that a skin in one check but
 *  not the other shows a theme control that silently does nothing, and adding a
 *  second (remote) source of truth is exactly how that would happen again. */
export function isLightPinnedSkin(
  skin: InstallableSkin,
  remoteLightOnly?: ReadonlySet<string>
): boolean {
  if (isRemoteSkinId(skin)) return remoteLightOnly?.has(skin) ?? false
  return LIGHT_PINNED_SKINS.has(skin as PhoneRemoteSkin)
}

/** Whether a skin paints pictures and therefore needs `data-img-skin`.
 *
 *  Same shape as isLightPinnedSkin above, for the same reason: built-ins answer
 *  from a compiled-in set, remote skins from ids the caller learned at runtime
 *  off /_skins. Both stampers must agree, so both go through this one helper.
 *
 *  This replaced a hardcoded `'remote:<run>'` entry in IMAGE_SKINS — one line
 *  edited and rebuilt per generated run, for a fact the packager already wrote
 *  into the manifest. The server only reports the flag for LOCAL skins, so a
 *  fetched skin can't opt in and lose its sculpt to the sanitiser. */
export function isImageSkin(
  skin: InstallableSkin,
  remoteImageSkins?: ReadonlySet<string>
): boolean {
  if (isRemoteSkinId(skin)) return remoteImageSkins?.has(skin) ?? false
  return IMAGE_SKINS.has(skin)
}

/** The token a locally-installed image skin sets on its own selector, appended
 *  to its block by the /_skins.css handler. Read off computed style rather than
 *  fetched, so the LIVE deck can answer at first paint — the JSON catalog is
 *  only fetched when the store is deliberately opened, which would leave a
 *  phone still wearing a remote image skin sculpted until someone opened it. */
export const IMAGE_SKIN_TOKEN = '--pro-is-image-skin'

/** Whether the skin currently applied to `el` declared itself an image skin.
 *
 *  Returns false for a built-in — those answer from IMAGE_SKINS, which is
 *  compiled in and needs no lookup. Guarded for SSR/tests where getComputedStyle
 *  may be absent; a false answer means "sculpted", which is the safe default
 *  (the teardown rules are what an image skin ADDS). */
export function readsAsImageSkin(el: Element | null): boolean {
  if (!el || typeof getComputedStyle !== 'function') return false
  return getComputedStyle(el).getPropertyValue(IMAGE_SKIN_TOKEN).trim() === '1'
}

/** Re-pull /_skins.css so a JUST-INSTALLED skin can actually paint.
 *
 *  The stylesheet is linked once at first paint (main.tsx) and built from the
 *  skins installed AT THAT MOMENT. Opening the store installs whatever the
 *  catalog offers, which happens strictly after — so selecting a brand-new skin
 *  stamped a data-skin no rule in the document matched, and the deck showed
 *  fallback colours and the bare sculpt until a full app reload rebuilt the
 *  page. That's the bug this fixes; the route was already `no-store`, so only
 *  the missing refetch was left.
 *
 *  Swaps in a NEW link and drops the old one only once the replacement has
 *  loaded: removing first would leave every installed skin unstyled for a frame,
 *  flashing the base cascade on a phone already wearing one. The cache-busting
 *  query is what makes this reach the server at all through Safari's memory
 *  cache, which ignores no-store for a same-URL subresource. */
export function refreshRemoteSkinStyles(): void {
  if (typeof document === 'undefined') return
  const prev = document.head.querySelector('link[data-remote-skins]')
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `${CONFIG.PHONE_REMOTE.REMOTE_SKIN_CSS_ROUTE}?r=${Date.now()}`
  link.dataset.remoteSkins = ''
  link.addEventListener('load', () => prev?.remove(), { once: true })
  // A failed refetch keeps the old sheet: worse than fresh, far better than none.
  link.addEventListener('error', () => link.remove(), { once: true })
  document.head.appendChild(link)
}

/* No STORE_SKINS constant: the store shows SKIN_OPTIONS in full. It used to
 * carry only the un-promoted skins, which made sense when its rows were text —
 * repeating the inline skin as a second text row was noise. Now that the rows
 * are preview cards, the store is where you SEE the range, and omitting the
 * skin you happen to be wearing reads as a missing card rather than a tidy
 * de-duplication. INLINE_SKINS still governs the Settings row only. */
