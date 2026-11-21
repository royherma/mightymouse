import { CONFIG } from '../../shared/config'
const T = CONFIG.THEME_TOKENS
export const TODAY_CSS = `
  .companion-caption {
    max-width: 100%;
    max-height: ${CONFIG.COMPANION.CAPTION_MAX_H - 8}px;
    overflow: hidden;
    padding: 9px 12px;
    border-radius: 16px 16px 4px 16px;
    background: ${T.surfaceSolid};
    box-shadow: 0 0 0 1px rgba(${T.shadowRgb}, 0.06), ${T.shadowBubble};
    display: flex; flex-direction: column; gap: 3px;
    font-size: 12px; line-height: 1.4;
    pointer-events: none;
    animation: companion-rise 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .companion-caption p { margin: 0; overflow-wrap: anywhere; }
  .companion-caption-heard { color: ${T.onSurface}; font-weight: 500; }
  .companion-caption.is-ignored { opacity: 0.6; }
  .companion-caption.is-ignored .companion-caption-heard { color: ${T.textMutedMedium}; font-weight: 400; }
  .companion-caption-note { font-size: 10px; color: ${T.textMutedMedium}; }
  .companion-caption-action { color: ${T.orange}; font-weight: 600; }
  .companion-caption-reply { color: ${T.textMutedDark}; }
  .companion-caption-reply.is-failed { color: ${T.redLight}; }

  .companion-pill {
    position: relative;
    display: flex; align-items: center; gap: 10px;
    height: ${CONFIG.COMPANION.PILL_H}px;
    padding: 0 6px 0 18px;
    box-sizing: border-box;
    border-radius: 999px;
    background: ${T.surfaceSolid};
    box-shadow: 0 0 0 1px rgba(${T.shadowRgb}, 0.07), ${T.shadowBubble};
    transition: box-shadow 200ms ease;
    animation: companion-pop 280ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
    -webkit-app-region: no-drag;
  }
  .companion-pill.is-listening,
  .companion-pill.is-thinking,
  .companion-pill.is-talking {
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--accent) 40%, transparent),
      0 6px 22px color-mix(in srgb, var(--accent) 28%, transparent);
  }
  .companion-pill:has(.companion-pill-stop) { padding-left: 8px; }
  .companion-pill-word {
    font-size: 12.5px; font-weight: 600;
    letter-spacing: -0.01em;
    color: ${T.textMutedDark};
    white-space: nowrap;
    animation: companion-fade 180ms ease-out;
  }
  .companion-pill.is-listening .companion-pill-word,
  .companion-pill.is-thinking .companion-pill-word,
  .companion-pill.is-talking .companion-pill-word { color: ${T.onSurface}; }
  .companion-pill.is-paused .companion-pill-word { color: ${T.textMutedLight}; }

  .companion-pill-avatar {
    position: relative;
    display: flex; align-items: center; justify-content: center;
    width: 40px; height: 40px;
    flex: none;
    border-radius: 50%;
    background: ${T.surface2};
  }
  .companion-pill-avatar img {
    width: 34px; height: 34px; object-fit: contain;
    pointer-events: none;
    transition: filter 200ms ease, opacity 200ms ease;
  }
  .companion-pill.is-paused .companion-pill-avatar img { filter: grayscale(1); opacity: 0.55; }
  .companion-pill-ring {
    position: absolute; inset: -3px;
    border-radius: 50%;
    border: 2px solid var(--accent);
    opacity: 0.22;
    transform: scale(var(--swell, 1));
    transition: opacity 120ms linear, transform 90ms ease-out;
    pointer-events: none;
  }
  .companion-pill.is-paused .companion-pill-ring { opacity: 0; }
  .companion-pill.is-thinking .companion-pill-ring {
    opacity: 1;
    border-color: color-mix(in srgb, var(--accent) 22%, transparent);
    border-top-color: var(--accent);
    animation: companion-spin 900ms linear infinite;
  }
  .companion-pill.is-talking .companion-pill-ring {
    animation: companion-breathe ${CONFIG.COMPANION.CYCLE_MS}ms ease-in-out infinite;
  }

  .companion-pill-off {
    position: absolute; top: -5px; left: -5px;
    width: 20px; height: 20px;
    display: flex; align-items: center; justify-content: center;
    padding: 0; border: none; border-radius: 50%;
    background: ${T.surface3};
    color: ${T.textMutedDark};
    box-shadow: ${T.shadowBubble};
    cursor: pointer;
    opacity: 0; transform: scale(0.7);
    transition: opacity 140ms ease, transform 140ms ease, color 140ms ease;
    -webkit-app-region: no-drag;
  }
  .companion-pill:hover .companion-pill-off { opacity: 1; transform: scale(1); }
  .companion-pill-off:hover { color: ${T.redLight}; }

  .companion-pill-stop {
    display: flex; align-items: center; gap: 6px;
    height: 32px; padding: 0 12px;
    border: none; border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
    font: inherit;
    cursor: pointer;
    transition: background 140ms ease, transform 100ms ease;
    -webkit-app-region: no-drag;
  }
  .companion-pill-stop:hover { background: color-mix(in srgb, var(--accent) 28%, transparent); }
  .companion-pill-stop:active { transform: scale(0.95); }
  .companion-pill-stop kbd {
    font: 600 10px/1 -apple-system, system-ui, sans-serif;
    color: ${T.textMutedDark};
  }

  .companion-bars {
    display: inline-flex; align-items: center; gap: 3px;
    height: 20px;
  }
  .companion-bars span {
    width: 3px; height: 100%;
    border-radius: 2px;
    background: var(--accent);
    transform: scaleY(0.2);
    transition: transform 90ms ease-out;
  }
  .companion-bars.is-wave span { animation: companion-wave 1s ease-in-out infinite; }
  .companion-bars.is-wave span:nth-child(2) { animation-delay: -0.8s; }
  .companion-bars.is-wave span:nth-child(3) { animation-delay: -0.6s; }
  .companion-bars.is-wave span:nth-child(4) { animation-delay: -0.4s; }
  .companion-bars.is-wave span:nth-child(5) { animation-delay: -0.2s; }

  .companion-dots { display: inline-flex; gap: 4px; }
  .companion-dots span {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: companion-dot 1s ease-in-out infinite;
  }
  .companion-dots span:nth-child(2) { animation-delay: 0.15s; }
  .companion-dots span:nth-child(3) { animation-delay: 0.3s; }

  @keyframes companion-pop {
    from { opacity: 0; transform: translateY(8px) scale(0.92); }
    to   { opacity: 1; transform: none; }
  }
  @keyframes companion-rise {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: none; }
  }
  @keyframes companion-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes companion-spin { to { transform: rotate(360deg); } }
  @keyframes companion-breathe {
    0%, 100% { transform: scale(1); opacity: 0.4; }
    50%      { transform: scale(1.08); opacity: 1; }
  }
  @keyframes companion-wave {
    0%, 100% { transform: scaleY(0.25); }
    50%      { transform: scaleY(1); }
  }
  @keyframes companion-dot {
    0%, 80%, 100% { transform: translateY(0); opacity: 0.45; }
    40%           { transform: translateY(-4px); opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .companion-pill, .companion-pill *, .companion-caption { animation: none !important; }
  }
`
