const BUNDLE = '../dist/index.html'
const DEVICE = { w: 393, h: 852 }
const SCALE_KEY = 'mm-screens-scale'
const PORTAL_APP_LOBBY = 'http://localhost:5173/code-harness.html?shot=app'

const PREFS = {
  layout: 'pro',
  skin: 'proII',
  colorScheme: 'light',
  handedness: 'right',
  keysPosition: 'bottom',
  deckMode: 'stacked',
  splitConcept: 'fan',
  showCursor: true,
  appRing: false,
  renderMarkup: false
}

const tap = (selector) => ({ selector })
const tapText = (selector, text) => ({ selector, text })

const ROWS = [
  {
    title: 'No Mac - what a new user sees',
    screens: [
      { title: 'iPhone app', how: 'Opens here', back: 'This is home', src: PORTAL_APP_LOBBY },
      { title: 'Start building', how: 'Tap Code, top middle', back: 'Close or Just chat', src: `${PORTAL_APP_LOBBY}&tap=Code` },
      { title: 'Menu', how: 'Tap the menu, top left', back: 'Tap outside it', src: `${PORTAL_APP_LOBBY}&tap=Menu` }
    ]
  },
  {
    title: 'With a Mac connected',
    screens: [
      { title: 'Mac remote', how: 'Tap the laptop, top right', back: 'Back arrow, top left', steps: [] },
      {
        title: 'Trackpad',
        how: 'Tap the mouse, top right',
        back: 'Back arrow, top left',
        steps: [tap('.ai [aria-label="Control your Mac"]')]
      },
      {
        title: 'Mac screen',
        how: 'Menu, then See your Mac screen',
        back: 'Chat, top left',
        steps: [tap('.ai [aria-label="Menu"]'), tapText('.ai .aiMenu button', 'See your Mac screen')]
      }
    ]
  }
]

const MISSING = 'Not shown: the Connect your Mac sheet - it is native iPhone code and needs a simulator capture.'

let bundleHtml = null
async function loadBundleHtml() {
  if (bundleHtml) return bundleHtml
  const res = await fetch(BUNDLE, { cache: 'no-store' })
  if (!res.ok) throw new Error(`no built bundle at ${BUNDLE} - run: npm run build:phone-remote`)
  const html = (await res.text()).replace('<head>', '<head><base href="../dist/">')
  bundleHtml = html.replace(
    '</head>',
    `<script>window.__MM_LAYOUT_PREFS__=${JSON.stringify(PREFS)};window.__MM_PREVIEW__=true;` +
      `(${harnessFixups.toString()})(${JSON.stringify(OFFLINE_TOAST)});</script></head>`
  )
  return bundleHtml
}

const OFFLINE_TOAST = 'Your Mac is not connected right now'

function harnessFixups(offlineToast) {
  const fix = () => {
    for (const img of document.querySelectorAll('img[src^="/"]')) img.src = '../dist' + img.getAttribute('src')
    for (const t of document.querySelectorAll('.aiToast')) if (t.textContent.trim() === offlineToast) t.remove()
  }
  new MutationObserver(fix).observe(document, { childList: true, subtree: true })
}

async function boot(frame, html) {
  const fresh = frame.cloneNode(false)
  frame.replaceWith(fresh)
  await new Promise((r) => requestAnimationFrame(r))
  const doc = fresh.contentDocument
  doc.open()
  doc.write(html)
  doc.close()
  return fresh
}

function find(doc, step) {
  const nodes = [...doc.querySelectorAll(step.selector)]
  return step.text ? nodes.find((n) => n.textContent.trim() === step.text) : nodes[0]
}

async function waitFor(doc, step, ms = 8000) {
  const end = performance.now() + ms
  while (performance.now() < end) {
    const hit = find(doc, step)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

async function drive(frame, screen, howEl) {
  const doc = frame.contentDocument
  const ready = await waitFor(doc, { selector: '.ai, .proRoot' })
  if (!ready) return fail(howEl, 'App never mounted')
  for (const step of screen.steps) {
    const el = await waitFor(doc, step)
    if (!el) return fail(howEl, `Missing: ${step.text ?? step.selector}`)
    el.click()
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function showExternal(frame, src, howEl) {
  try {
    await fetch(src, { mode: 'no-cors', cache: 'no-store' })
    const how = howEl.textContent
    howEl.textContent = 'Loading the web chat...'
    frame.addEventListener('load', () => (howEl.textContent = how), { once: true })
    frame.src = src
  } catch {
    fail(howEl, 'Portal dev server is down')
  }
}

function fail(howEl, msg) {
  howEl.textContent = msg
  howEl.classList.add('bad')
}

function readScale() {
  try {
    return Number(localStorage.getItem(SCALE_KEY)) || 0.75
  } catch {
    return 0.75
  }
}

function applyScale(scale) {
  try {
    localStorage.setItem(SCALE_KEY, String(scale))
  } catch {}
  for (const b of document.querySelectorAll('[data-scale]')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.scale) === scale))
  }
  for (const phone of document.querySelectorAll('.phone')) {
    phone.style.width = `${DEVICE.w * scale}px`
    phone.style.height = `${DEVICE.h * scale}px`
    phone.querySelector('.scaler').style.transform = `scale(${scale})`
  }
}

function renderFlow() {
  document.getElementById('flow').textContent = MISSING
}

function addCell(row, screen) {
  const cell = document.createElement('div')
  cell.className = 'cell'
  cell.innerHTML =
    `<p class="cap">${screen.title}</p><p class="how">${screen.how}</p><p class="back">Back: ${screen.back}</p>` +
    `<div class="phone"><div class="scaler"><iframe title="${screen.title}" width="${DEVICE.w}" height="${DEVICE.h}"></iframe></div></div>`
  row.appendChild(cell)
  return cell
}

async function render() {
  const rows = document.getElementById('rows')
  rows.innerHTML = ''
  let html
  try {
    html = await loadBundleHtml()
  } catch (e) {
    rows.innerHTML = `<div class="err">${e.message}</div>`
    return
  }
  const jobs = ROWS.flatMap(({ title, screens }) => {
    const head = document.createElement('h2')
    head.textContent = title
    const row = document.createElement('div')
    row.className = 'row'
    rows.append(head, row)
    return screens.map(async (screen) => {
      const cell = addCell(row, screen)
      applyScale(readScale())
      if (screen.src) return showExternal(cell.querySelector('iframe'), screen.src, cell.querySelector('.how'))
      const frame = await boot(cell.querySelector('iframe'), html)
      await drive(frame, screen, cell.querySelector('.how'))
    })
  })
  await Promise.all(jobs)
}

for (const b of document.querySelectorAll('[data-scale]')) {
  b.addEventListener('click', () => applyScale(Number(b.dataset.scale)))
}
document.getElementById('reload').addEventListener('click', () => {
  bundleHtml = null
  render()
})

renderFlow()
render()
