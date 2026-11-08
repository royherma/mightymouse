// Shoots the shared-work roster headlessly against the harness stub. The real
// Work tab only fills when agents happen to be running, so this is the only way
// to see every state at once.
//
//   npm run dev  (serves the harness on 5273)
//   node_modules/.bin/electron bin/mm-coord-shot.cjs <out.png> [waitMs]

const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('fs')

const OUT = process.argv[2] || '/tmp/coord.png'
const WAIT = Number(process.argv[3] || 3500)
const URL = 'http://localhost:5273/coord-harness.local.html'

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: Math.max(660, Number(process.env.COORD_ROOT_W || 0) + 40),
    height: 1100,
    show: false,
    webPreferences: { offscreen: true }
  })

  win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[console] ' + msg))
  win.webContents.on('did-fail-load', (_e, code, desc) => console.log('[fail] ' + code + ' ' + desc))

  await win.loadURL(URL)
  if (process.env.COORD_ROOT_W)
    await win.webContents.executeJavaScript(
      `document.getElementById('root').style.width='${Number(process.env.COORD_ROOT_W)}px'`
    )
  await new Promise((r) => setTimeout(r, WAIT))

  if (process.env.COORD_CLICK) {
    const hit = await win.webContents.executeJavaScript(
      `(() => { const i = Number(${JSON.stringify(process.env.COORD_CLICK_N || '0')});
        const e = document.querySelectorAll(${JSON.stringify(process.env.COORD_CLICK)})[i];
        if (!e) return 'no match'; e.click(); return e.innerText.split('\\n')[0]; })()`
    )
    console.log('[click] ' + process.env.COORD_CLICK + ' -> ' + hit)
    await new Promise((r) => setTimeout(r, 900))
  }

  const probe = await win.webContents.executeJavaScript(`
    (() => {
      const q = (s) => document.querySelector(s);
      const all = (s) => [...document.querySelectorAll(s)];
      const overlaps = [];
      const rows = all('.coord-agent');
      for (let i = 0; i < rows.length - 1; i++) {
        const a = rows[i].getBoundingClientRect(), b = rows[i + 1].getBoundingClientRect();
        if (a.bottom > b.top + 0.5) overlaps.push(i);
      }
      const clipped = all('.coord-line-title, .coord-agent-name, .coord-project-name')
        .filter((e) => e.scrollWidth > e.clientWidth + 1)
        .map((e) => e.textContent.slice(0, 40));
      return JSON.stringify({
        projects: all('.coord-project').length,
        projectNames: all('.coord-project-name').map((e) => e.textContent),
        agentRows: rows.length,
        states: all('.coord-agent').map((e) => e.dataset.state),
        badges: all('.coord-project-badge').map((e) => e.textContent),
        revealChip: q('.code-session-filter') ? q('.code-session-filter').textContent : null,
        firstRowState: rows[0] ? rows[0].dataset.state : null,
        firstRowText: rows[0] ? rows[0].innerText.replace(/\\n/g, ' | ').slice(0, 120) : null,
        overlappingRows: overlaps,
        clippedText: clipped,
        bodyScrollWidth: document.body.scrollWidth,
        rootWidth: q('#root') ? q('#root').offsetWidth : null,
        panelWidth: q('.coord-panel') ? q('.coord-panel').offsetWidth : null,
        opensRows: all('.coord-agent-head[data-opens]').map((e) => e.innerText.split('\\n')[0]),
        detailBack: q('.code-detail-back') ? q('.code-detail-back').innerText : null,
        detailShared: q('.session-detail-shared') ? q('.session-detail-shared').innerText : null,
        chevGap: (() => { const c = q('.coord-agent-go'); if (!c) return null;
          const t = c.previousElementSibling; if (!t) return 'no sibling';
          return Math.round(c.getBoundingClientRect().left - t.getBoundingClientRect().right) + 'px after .' + t.className; })(),
        detailW: q('.code-detail-back') ? Math.round(q('.code-detail-back').closest('div').getBoundingClientRect().width) : null,
        sharedBox: q('.session-detail-shared') ? (() => { const r = q('.session-detail-shared').getBoundingClientRect(); return Math.round(r.left) + ',' + Math.round(r.width); })() : null
      }, null, 2);
    })()
  `)
  console.log(probe)

  writeFileSync(OUT, (await win.webContents.capturePage()).toPNG())
  console.log('shot -> ' + OUT)
  app.exit(0)
})
