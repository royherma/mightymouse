import { BrowserWindow, session, shell } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { CONFIG } from '../../shared/config'
import { PATHS } from '../store/paths'

// In-app viewer for an HTML or Markdown artifact Mighty built. HTML loads directly
// (it's a self-contained, app-authored file inside Mighty's sandbox, so inline
// CSS/JS just renders — no protocol/CORS dance needed). Markdown has no renderer
// dependency in this app, so it's shown as readable monospace text wrapped in a
// minimal styled shell (data: URL) — not full markdown rendering, but far more
// useful than a Finder reveal. One window PER path so opening two reports gives
// two windows; re-opening the same path re-focuses.
//
// Hard boundary: only files UNDER the Mighty workspace open here. A path outside
// the sandbox (or a missing file) is refused — defense in depth even though the
// only caller passes registry paths Mighty itself wrote.

function isMarkdown(filePath: string): boolean {
  const p = filePath.toLowerCase()
  return p.endsWith('.md') || p.endsWith('.markdown')
}

// Escape text for safe embedding inside an HTML <pre> block.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function markdownShellUrl(filePath: string): string {
  const raw = readFileSync(filePath, 'utf-8')
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; padding: 2rem; background: #1a1a1a; color: #e8e8e8;
           font: 14px/1.6 -apple-system, ui-monospace, monospace; }
    pre { white-space: pre-wrap; word-wrap: break-word; max-width: 860px; margin: 0 auto; }
  </style></head><body><pre>${escapeHtml(raw)}</pre></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

const viewers = new Map<string, BrowserWindow>()

// CSP for artifact windows. The HTML here is MODEL OUTPUT — if a prompt injection
// reaches the generator, whatever it wrote runs in this window. The window already
// has no preload/node bridge, so the residual risk is exfiltration: a script that
// POSTs the artifact's contents (or anything else it can read) to a remote host.
//
// `default-src 'none'` denies everything, then styles/images/fonts are added back
// because reports legitimately need them — inline styles and data: images are how
// a self-contained artifact carries its own look. Scripts are NOT added back, and
// connect-src stays 'none' so even a script that slipped in has nowhere to send to.
// form-action 'none' blocks the no-JS exfil path of a form POSTing offsite.
const ARTIFACT_CSP =
  "default-src 'none'; " +
  "style-src 'unsafe-inline' data:; " +
  "img-src data: blob: file:; " +
  "font-src data: file:; " +
  "connect-src 'none'; " +
  "form-action 'none'; " +
  "frame-src 'none'; " +
  "object-src 'none'; " +
  "base-uri 'none'"

// Artifact windows get their OWN session partition, never the app default. The
// default session is shared with the panel/HUD/settings windows, so stamping this
// CSP there would break them — and its cookies/storage would be reachable from
// model-written HTML. Registered once at module load because onHeadersReceived
// keeps only ONE handler per session; doing it per-window would unhook the
// previous artifact window every time a new one opened.
const ARTIFACT_PARTITION = 'mighty-artifact-view'
let cspRegistered = false

function artifactSession(): Electron.Session {
  const sess = session.fromPartition(ARTIFACT_PARTITION)
  if (!cspRegistered) {
    cspRegistered = true
    sess.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [ARTIFACT_CSP] }
      })
    })
    // Model-written HTML must never trigger a permission prompt (camera, mic,
    // geolocation, notifications). Deny the whole class rather than enumerating.
    sess.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  }
  return sess
}

function underWorkspace(filePath: string): boolean {
  const root = PATHS.MIGHTY_WORKSPACE.endsWith('/')
    ? PATHS.MIGHTY_WORKSPACE
    : PATHS.MIGHTY_WORKSPACE + '/'
  return filePath.startsWith(root) && !filePath.includes('..')
}

export function showMightyViewWindow(filePath: string): void {
  if (!underWorkspace(filePath) || !existsSync(filePath)) {
    // Not a sandboxed artifact (or gone) — fall back to revealing it in Finder so
    // the click still does something sensible instead of silently failing.
    shell.showItemInFolder(filePath)
    return
  }

  const existing = viewers.get(filePath)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  const win = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 480,
    minHeight: 360,
    title: `${CONFIG.MIGHTY.NAME} · ${filePath.split('/').pop() ?? 'view'}`,
    backgroundColor: '#FFFFFF',
    show: false,
    webPreferences: {
      // No preload / node — this renders untrusted-ish generated HTML, so keep it a
      // plain sandboxed web page with no bridge to the app.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Isolated partition carrying the artifact CSP + a deny-all permission
      // handler, so model-written HTML can't reach the app's default session.
      session: artifactSession(),
      // Generated HTML has no reason to open a devtools-style child or run
      // webviews; both are extra surface on untrusted content.
      webviewTag: false
    }
  })

  // Open any external links the report contains in the real browser, not in-window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // CSP is stamped on the ARTIFACT_PARTITION session (see webPreferences below),
  // registered once at module load — not here. Two reasons this must not be
  // per-window on the default session: the default session is shared with the
  // panel/HUD/settings windows (this CSP would break them), and
  // onHeadersReceived holds a SINGLE handler per session, so the newest artifact
  // window would silently unhook every earlier one.

  // Refuse in-window navigation away from the artifact. Without this, a generated
  // <meta refresh> or link target could turn the viewer into a browser pointed at
  // an attacker's page that looks like it came from the app.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault()
      if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    }
  })

  if (isMarkdown(filePath)) {
    void win.loadURL(markdownShellUrl(filePath))
  } else {
    void win.loadFile(filePath)
  }

  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })
  win.on('closed', () => {
    viewers.delete(filePath)
  })
  viewers.set(filePath, win)
}
