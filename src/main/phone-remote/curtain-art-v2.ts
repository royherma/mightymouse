/**
 * Curtain art, variant 2 — the shipped look. `privacy-curtain.ts` loads this;
 * `curtain-art-v1.ts` is the previous flat grid, kept importable as a fallback.
 *
 * Structure is lifted from a reference comp Roy supplied (a dark "brand lock
 * screen": spotlight, dotted grid, emblem ring, tracked wordmark, status pill,
 * footer). Two deliberate departures from that comp:
 *
 * - The reference's gold becomes MightyMouse's own accent, `rgba(255,160,80)`
 *   from `THEME.accent` — near enough to the comp's warmth to keep its look, and
 *   ours rather than borrowed. It carries at low alpha throughout: the plate has
 *   to stay dark enough that a walk-past still reads "off", not "advertisement".
 * - Still zero animation, for the reason in `privacy-curtain.ts`'s docstring.
 *
 * No external assets, because the window loads a `data:` URI. Inline page JS
 * DOES run under `sandbox: true` (that flag walls off Node, not the page), and
 * the clock at the bottom is the only thing that uses it.
 */
import { CONFIG } from '../../shared/config'

/**
 * Grid + dots are two backgrounds on one layer, sharing a 96px cell so the dots
 * land exactly on the intersections. A separate dot layer would need its own
 * offset kept in sync by hand — one `background-size` for both can't drift.
 *
 * The spotlight sits ABOVE the grid rather than behind it: the reference's grid
 * is brightest where the light falls, which only happens if the light is applied
 * over the lines. Behind them, the lines stay uniformly dim and the whole thing
 * flattens out.
 */
export const CURTAIN_HTML_V2 = `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:100%;height:100%;overflow:hidden;background:#05070c}
  body{
    font:400 13px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
    /* Navy at the bottom, near-black at the top: the comp's depth comes from the
       plate never being one flat color. */
    background:linear-gradient(180deg,#05070c 0%,#080b12 45%,#0d1420 100%);
  }
  .grid{
    position:absolute;inset:0;
    background-image:
      linear-gradient(rgba(255,160,80,.055) 1px,transparent 1px),
      linear-gradient(90deg,rgba(255,160,80,.055) 1px,transparent 1px),
      radial-gradient(circle,rgba(255,160,80,.16) 1px,transparent 1.6px);
    background-size:96px 96px,96px 96px,96px 96px;
  }
  /* Top-centre warm spotlight — the single biggest "premium" cue in the comp.
     120% wide so its falloff clears the screen edges instead of ending in a
     visible arc, and anchored above the top edge so only the skirt shows. */
  .spot{
    position:absolute;left:50%;top:0;transform:translate(-50%,-42%);
    width:120%;height:78%;
    background:radial-gradient(ellipse at center,
      rgba(255,238,205,.13) 0%,
      rgba(255,232,195,.07) 32%,
      rgba(255,228,190,.025) 55%,
      transparent 72%);
  }
  /* Keeps the corners true black so the window's rectangle doesn't announce
     itself on a dark wall — same reason as the shipped art's vignette. */
  .vignette{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 42%,transparent 0%,transparent 30%,rgba(0,0,0,.82) 88%)}
  .stack{
    position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
    display:flex;flex-direction:column;align-items:center;
  }
  /* The emblem ring. A border alone looked stamped-on; the inner radial gives the
     disc a faint fill so it reads as lit from the same source as the spotlight. */
  .emblem{
    width:132px;height:132px;border-radius:50%;
    display:flex;align-items:center;justify-content:center;
    border:1px solid rgba(255,160,80,.13);
    background:radial-gradient(circle at 50% 38%,rgba(255,160,80,.05) 0%,transparent 68%);
  }
  .emblem span{font-size:52px;line-height:1;opacity:.92}
  /* Display, not Text: at this size Text's looser optical cut reads soft, and
     Display is what the app's own headings use (renderer index.css). Tracking is
     the other premium cue and only works in caps — but it trades against weight,
     so .26em pairs with 500 where a lighter weight needs more air. The left
     margin compensates for the trailing letter-space so the word stays optically
     centred, and must track any letter-spacing change. */
  .wordmark{
    margin:30px 0 0 .26em;
    font-family:'SF Pro Display',-apple-system,system-ui,sans-serif;
    font-size:21px;font-weight:500;letter-spacing:.26em;text-transform:uppercase;
    color:rgba(255,160,80,.82);
  }
  /* The one live element on the plate. Tabular figures so the digits don't
     shuffle the centre every minute, and -.02em pulls the wide default tracking
     back to optical centre at this size. */
  .clock{
    margin:22px 0 0;
    font-family:'SF Pro Display',-apple-system,system-ui,sans-serif;
    font-size:76px;font-weight:200;letter-spacing:-.02em;line-height:1;
    font-variant-numeric:tabular-nums;
    color:rgba(255,236,214,.88);
  }
  /* Sits in the wordmark's accent rather than the clock's near-white, so the
     pair reads as one block with a clear primary. */
  .date{
    margin:14px 0 0;
    font-size:14px;letter-spacing:.06em;
    color:rgba(255,160,80,.5);
  }
  .est{
    margin:22px 0 0 .3em;
    font-size:10px;letter-spacing:.3em;text-transform:uppercase;
    color:rgba(255,160,80,.32);
  }
  .pill{
    margin-top:34px;
    display:flex;align-items:center;gap:11px;
    padding:12px 22px 12px 17px;border-radius:999px;
    background:rgba(255,160,80,.045);border:1px solid rgba(255,160,80,.1);
    color:rgba(255,160,80,.7);font-size:13.5px;letter-spacing:.01em;
  }
  .pill .dot{width:7px;height:7px;border-radius:50%;background:rgba(255,160,80,.65)}
  .pill .sep{width:1px;height:14px;background:rgba(255,160,80,.16)}
  .pill .sub{color:rgba(255,160,80,.42);font-size:12px}
  .footer{
    position:absolute;left:50%;bottom:38px;transform:translateX(-50%);
    font-size:9.5px;letter-spacing:.34em;text-transform:uppercase;
    color:rgba(255,160,80,.2);white-space:nowrap;
  }
</style>
<div class="grid"></div><div class="spot"></div><div class="vignette"></div>
<div class="stack">
  <div class="emblem"><span aria-hidden="true">${CONFIG.BRAND_ICON}</span></div>
  <div class="wordmark">${CONFIG.BRAND_NAME}</div>
  <div class="clock" id="clock"></div>
  <div class="date" id="date"></div>
  <div class="est">Remote session</div>
  <div class="pill">
    <span class="dot"></span>Your screen is protected<span class="sep"></span><span class="sub">you can step away freely</span>
  </div>
</div>
<div class="footer">Touch this Mac and it locks</div>
<script>
  /* The window is sandboxed with no preload and no IPC, so the clock has to be
     self-contained page JS -- verified to run under sandbox:true on a data: URI.
     Ticking on the next minute BOUNDARY rather than every 60s keeps it from
     drifting a few seconds late over a long unattended session. */
  (function () {
    var el = document.getElementById('clock')
    var dateEl = document.getElementById('date')
    function paint() {
      var d = new Date()
      el.textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      // Repainted every tick, not just at load: a curtain left up overnight
      // would otherwise still be showing yesterday.
      dateEl.textContent = d.toLocaleDateString([], {
        weekday: 'long', month: 'long', day: 'numeric'
      })
      setTimeout(paint, 60000 - (d.getSeconds() * 1000 + d.getMilliseconds()))
    }
    paint()
  })()
</script>`
