# Phone Remote — how to author a skin

A skin is **one CSS block**. It overrides `--pro-*` tokens on `.proRoot[data-skin='<id>']`
and inherits every layout rule, every keycap sculpt, and every press animation from the base
cascade. You should not need to touch geometry, JSX, or gesture code.

Read this before writing one. It is short on purpose; the long-form rationale for each
decision lives in the comments at the matching line in `theme.css`.

## Two ways to ship a skin — pick the remote one

**Remote (default).** Append an entry to `SKINS` in
`supabase/functions/phone-remote-skins/index.ts`, run `supabase/scripts/deploy.sh`. Done —
**no app files, no release, no user update.** Every installed app picks it up the next time
someone opens the skin store. This is the path to use unless you have a reason not to.

Your CSS is sanitised on the way in: only `--pro-*` custom properties survive, and every
`url()` must name a file in the entry's `assets` array (downloaded at install, repointed at a
local path). Ordinary CSS properties are **silently dropped** — that is the point, not a bug.
So a remote skin is tokens and declared images, nothing else. Write the same block you would
write below; just expect anything that isn't a token to vanish. Details:
`src/main/phone-remote/remote-skins.ts`.

One thing a remote skin cannot do today: ship assets that aren't already deployed under
`web/skins/<id>/`. Deploy the files first, then the catalog entry.

**Built-in (rarer).** A skin compiled into the app — for one shipping in the default set, or
one that needs CSS beyond tokens.

| # | File | What you add |
|---|---|---|
| 1 | `theme.css` | the `[data-skin='<id>']` token block (the actual work) |
| 2 | `@shared/types.ts` | `<id>` into `PHONE_REMOTE_SKINS` |
| 3 | `skins.ts` | an entry in `SKIN_OPTIONS` (label, swatch) |

Those last two are one-line edits. If you find yourself editing a 4th file, stop — you are
probably fighting the base cascade instead of overriding a token, and the fix is usually a
new token (see *Adding a token* below).

There is one layout (`TouchpadLayout`). A skin is a `PhoneRemoteSkin` (or a `remote:<id>`
string) painted over it — paint only, never a structural variant.

## The token surface

Everything below is overridable. Defaults live on `.proRoot` in `theme.css`; anything you
don't override inherits Pro's value, so a minimal skin is maybe 15 lines.

| Group | Tokens | Notes |
|---|---|---|
| **Deck** | `--pro-bg` `--pro-blob` `--pro-card` `--pro-card-border` | `--pro-card` is the big surface; `--pro-bg` shows at the edges |
| **Touchpad** | `--pro-pad-bg` `--pro-pad-border` `--pro-pad-label` `--pro-pad-sheen-a/-mid/-b` `--pro-pad-inset` | sheen a→b is the gloss ramp; invert a/b to read *recessed* instead of *raised* |
| **Keycaps** | `--pro-key-bg` `--pro-key-ink` `--pro-key-wall` `--pro-key-wall-deep` `--pro-key-top` `--pro-key-face-lip` `--pro-key-travel` `--pro-key-seam` `--pro-key-seam-soft` | see *The keycap sculpt* |
| **Type** | `--pro-ink` `--pro-ink-strong` `--pro-pill-bg` | |
| **Accent** | `--pro-accent` `--pro-accent-ink` | Enter key + zoom slider/knob |
| **Mic** | `--pro-mic` `--pro-mic-ink` `--pro-mic-glow` `--pro-mic-rec` | defaults alias the accent; override when your accent is already a red |
| **Header icons** | `--pro-icon-lit` `--pro-icon-lit-ink` | the *lit* chat/history keys; defaults alias the accent |
| **Status text** | `--pro-status-ink` `--pro-status-scrim` | overlays the pad, so it needs its own contrast pair |
| **Shape** | `--pro-r` `--pro-r-key` | corner radii |
| **Depth** | `--pro-neu-shadow` `--pro-neu-highlight` | |

### Three tokens that exist only because a skin got them wrong

Worth calling out, since the failure mode is non-obvious in each case:

- **`--pro-key-seam*`** — the gutter between caps. Defaults are a warm brown (Pro's). A cool
  deck that doesn't override these glows orange in every gap.
- **`--pro-mic-glow`** — the mic's drop-shadow colour, keyed to Pro's amber. A red mic that
  inherits it gets an orange halo.
- **`--pro-icon-lit`** — split from `--pro-accent` so header icons can differ from Enter. On
  Cap, both being the same red made the lit icon and the Enter key read as one control.

## The keycap sculpt (do not re-implement it)

Caps are **two planes**: the element paints the side WALL, `::before` paints the TOP FACE,
inset asymmetrically (bottom inset ≫ top inset) so the trapezoid reads as depth.

Those rules are scoped to `.proRoot[data-skin]` — **any** skin — and derive every colour from
the key tokens. So you get the sculpt for free by setting `--pro-key-wall` / `-deep` / `-top`.

If your caps render flat, you have almost certainly scoped a sculpt rule to one skin id
instead of the bare `[data-skin]` attribute. That exact bug shipped once and cost an
afternoon.

## The bottom strip

iOS can leave a band below the *visible* viewport (793px on an 852px screen) that nothing
inside `.proRoot` paints. The page underneath wears `--pro-strip` so the seam has nothing to
show.

**Remote skins: nothing to do.** The sanitizer lifts your `--pro-card` (or an explicit
`--pro-strip`, if you set one) onto `<html>` for you.

**Built-in skins: one line**, next to the others in `theme.css`:

```css
html:has(.proRoot[data-skin='<id>']) { --pro-strip: <same as --pro-card>; }
```

Match `--pro-card`, **not** `--pro-bg` — the element adjacent to the seam is the card, and
using the deck colour reads as a visible band. (Pro II additionally paints `html` with
continued texture; only bother if your skin has a gradient/texture that would otherwise
restart at the seam.)

Why it can't just read the token: custom properties inherit **down, never up**. `--pro-card`
is declared on `.proRoot`, and `body`/`html` are its *ancestors* — `:has()` matches an
ancestor on a descendant's state but does not hand it that descendant's variables. So the
value has to be declared on a box the page can inherit from.

## Materials: pick the cheapest representation

The rule that came out of building Cap:

| Identity lives in | Use | Example |
|---|---|---|
| irregular shape / material structure | a photo asset | cork deck (`cork.webp`) |
| regular geometry | `clip-path: polygon()` | Cap's star |
| colour or value | a token | everything else |

Procedural texture (`feTurbulence` in an inline SVG data-URI, blended with
`background-blend-mode`) sits between the first two: anisotropic `baseFrequency "x y"` gives
brushed metal, a single isotropic value gives enamel grain. Copy the pattern from Pro II's
`.proCard::before` rather than deriving it.

## Light-only skins

If your tokens are built over the light base and you have no dark variant, add the id to
`LIGHT_PINNED_SKINS` in `skins.ts`. That pins `data-theme='light'` and hides the theme row in
Settings, so the user can't select a combination you never designed.

## Adding a token

Only when a base rule hardcodes a colour your skin genuinely needs to change:

1. Declare it on `.proRoot`, **defaulted to the exact literal you're replacing** — so Pro I
   and Pro II stay pixel-identical.
2. Replace the literal at its use site with `var(--pro-*)`.
3. Comment *why* it needed splitting, at the declaration.

Where possible, default a new token to an existing one (`--pro-mic: var(--pro-accent)`)
rather than to a raw value — the skin then opts in only if it cares.

## Before you call it done

- `npm run typecheck && npx vitest run`
- `npm run build:phone-remote` — **required.** The phone React app is a separate Vite build;
  `make restart` alone will not pick up changes in `react/`.
- Look at it. Typecheck and tests say nothing about layout or overlap. Check idle **and**
  recording states, portrait **and** landscape.
- **Do not point a browser at the live phone-remote server to check.** It kicks Roy's real
  device off via the single-active-socket rule. Use a static harness on a separate port, or
  ask him to look.
