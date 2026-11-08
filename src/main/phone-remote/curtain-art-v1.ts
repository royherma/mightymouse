/**
 * Curtain art, variant 1 — the flat-grid version, kept as a fallback.
 *
 * Superseded by `curtain-art-v2.ts` (the branded layout the user chose on 2026-08-07),
 * which is what `privacy-curtain.ts` actually loads. This stays importable so the
 * swap back is a one-line change rather than a git archaeology exercise.
 *
 * Same constraints as v2: CSS only, no JS, no external assets — the window loads
 * a `data:` URI under `sandbox: true`. And zero animation, which is a
 * requirement rather than an omission; two motion passes (five masked radial
 * "ripple" layers, then a 24s background drift) were both rejected on device as
 * flashy. A curtain that draws the eye defeats its own job.
 */
import { CONFIG } from '../../shared/config'

export const CURTAIN_HTML_V1 = `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:100%;height:100%;background:#000;overflow:hidden}
  body{font:500 13px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
  .grid{
    position:absolute;inset:-80px;
    background-image:
      linear-gradient(rgba(255,255,255,.07) 1px,transparent 1px),
      linear-gradient(90deg,rgba(255,255,255,.07) 1px,transparent 1px);
    background-size:64px 64px;
  }
  /* Fades the grid out toward the edges so the panel's corners stay true black
     and the window's rectangle doesn't announce itself on a dark room's wall. */
  .vignette{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 0%,transparent 35%,#000 85%)}
  /* Centred, not bottom-left: on a wide display the corner reads as a forgotten
     watermark, and the curtain's job is to tell someone walking up what this
     machine is doing. The pill gives the text an edge to sit against so it stays
     legible at 55% white without the whole plate getting bright. */
  .mark{
    position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
    display:flex;align-items:center;gap:9px;
    padding:11px 20px 11px 16px;border-radius:999px;
    background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);
    color:rgba(255,255,255,.55);letter-spacing:.01em;
  }
  .icon{font-size:15px;line-height:1}
  .sub{color:rgba(255,255,255,.3);font-size:12px}
  .sep{width:1px;height:13px;background:rgba(255,255,255,.14)}
</style>
<div class="grid"></div><div class="vignette"></div>
<div class="mark"><span class="icon" aria-hidden="true">${CONFIG.BRAND_ICON}</span>${CONFIG.BRAND_NAME}<span class="sep"></span><span class="sub">screen covered</span></div>`
