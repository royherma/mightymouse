export const X_QUICK_REPLY = {
  host: 'x.com',
  prompt: "Add a reply box that follows the post I'm reading",
  name: 'Quick reply',
  summary: 'A reply box follows the post in the middle of the screen. Type, press Enter, and it posts.',
  css: `
[data-mm-mod-xr-target] { box-shadow: inset 3px 0 0 #1d9bf0 !important; }
#mm-mod-xr {
  --bg: #000; --line: #2f3336; --text: #e7e9ea; --muted: #71767b; --btn-bg: #eff3f4; --btn-text: #0f1419;
  --glow: rgba(255, 255, 255, 0.2) 0 0 15px, rgba(255, 255, 255, 0.15) 0 0 3px 1px;
  position: fixed; bottom: 0; z-index: 2147483000; box-sizing: border-box; display: flex; gap: 12px;
  padding: 12px 16px; background: var(--bg); color: var(--text);
  border: 1px solid var(--line); border-bottom: 0; border-radius: 16px 16px 0 0; box-shadow: var(--glow);
  font: 15px/20px TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
#mm-mod-xr[data-theme="dim"] { --bg: #15202b; --line: #38444d; --text: #f7f9f9; --muted: #8b98a5; --btn-bg: #eff3f4; --btn-text: #0f1419; }
#mm-mod-xr[data-theme="light"] {
  --bg: #fff; --line: #eff3f4; --text: #0f1419; --muted: #536471; --btn-bg: #0f1419; --btn-text: #fff;
  --glow: rgba(101, 119, 134, 0.2) 0 0 15px, rgba(101, 119, 134, 0.15) 0 0 3px 1px;
}
#mm-mod-xr[hidden] { display: none; }
#mm-mod-xr .mm-mod-xr-avatar { width: 40px; height: 40px; border-radius: 9999px; flex: none; object-fit: cover; }
#mm-mod-xr .mm-mod-xr-main { flex: 1; min-width: 0; }
#mm-mod-xr .mm-mod-xr-to { color: var(--muted); font-size: 15px; }
#mm-mod-xr .mm-mod-xr-to span { color: #1d9bf0; }
#mm-mod-xr textarea {
  display: block; width: 100%; box-sizing: border-box; resize: none; border: 0; outline: 0; padding: 6px 0;
  background: transparent; color: var(--text); font: inherit; font-size: 20px; line-height: 24px; min-height: 36px; max-height: 160px;
}
#mm-mod-xr textarea::placeholder { color: var(--muted); }
#mm-mod-xr .mm-mod-xr-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  border-top: 1px solid var(--line); padding-top: 10px; color: var(--muted); font-size: 13px;
}
#mm-mod-xr .mm-mod-xr-status[data-tone="good"] { color: #00ba7c; }
#mm-mod-xr .mm-mod-xr-status[data-tone="bad"] { color: #f4212e; }
#mm-mod-xr button {
  flex: none; min-height: 36px; padding: 0 16px; border: 0; border-radius: 9999px; cursor: pointer;
  background: var(--btn-bg); color: var(--btn-text); font: inherit; font-weight: 700;
}
#mm-mod-xr button:disabled { opacity: 0.5; cursor: default; }
`,
  js: String.raw`
const ANCHOR = 0.4
const make = (tag, cls) => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  return el
}
const box = make('div')
box.id = 'mm-mod-xr'
box.hidden = true
const avatar = make('img', 'mm-mod-xr-avatar')
avatar.alt = ''
const main = make('div', 'mm-mod-xr-main')
const to = make('div', 'mm-mod-xr-to')
const toHandle = make('span')
to.append('Replying to ', toHandle)
const input = make('textarea')
input.rows = 1
input.placeholder = 'Post your reply'
const foot = make('div', 'mm-mod-xr-foot')
const status = make('span', 'mm-mod-xr-status')
const hint = 'Enter to post · Tab for an AI draft · ↑ ↓ next post'
status.textContent = hint
const replyButton = make('button')
replyButton.type = 'button'
replyButton.textContent = 'Reply'
replyButton.disabled = true
foot.append(status, replyButton)
main.append(to, input, foot)
box.append(avatar, main)
document.documentElement.append(box)

function fit() {
  const bg = getComputedStyle(document.body).backgroundColor
  box.dataset.theme = bg === 'rgb(0, 0, 0)' ? 'dark' : bg === 'rgb(21, 32, 43)' ? 'dim' : 'light'
  const col = document.querySelector('[data-testid="primaryColumn"]')
  const r = col ? col.getBoundingClientRect() : { left: (innerWidth - 600) / 2, width: 600 }
  box.style.left = r.left + 'px'
  box.style.width = r.width + 'px'
  const me = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"] img')
  if (me && avatar.src !== me.src) avatar.src = me.src
}

let target = null
let sending = false
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(find, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = find()
    if (hit) return hit
    await wait(80)
  }
  return null
}
const posts = () => [...document.querySelectorAll('article[data-testid="tweet"]')]
const handleOf = (post) => {
  const link = post && [...post.querySelectorAll('[data-testid="User-Name"] a[href^="/"]')].find((a) => a.textContent.startsWith('@'))
  return link ? link.textContent : ''
}
let statusTimer = 0
function setStatus(text, tone) {
  clearTimeout(statusTimer)
  status.textContent = text || hint
  if (tone) status.dataset.tone = tone
  else delete status.dataset.tone
  if (tone === 'good') statusTimer = setTimeout(() => setStatus(''), 4000)
}
function setTarget(next) {
  if (next === target) return
  if (target) target.removeAttribute('data-mm-mod-xr-target')
  target = next
  if (target) target.setAttribute('data-mm-mod-xr-target', '')
  box.hidden = !target
  toHandle.textContent = handleOf(target) || 'this post'
  fit()
}
function nearest() {
  if (sending) return
  const mid = innerHeight * ANCHOR
  let best = null
  let bestGap = Infinity
  for (const post of posts()) {
    const r = post.getBoundingClientRect()
    if (r.bottom < 0 || r.top > innerHeight) continue
    const gap = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid))
    if (gap < bestGap) { best = post; bestGap = gap }
  }
  setTarget(best)
}
function step(dir) {
  const list = posts()
  const next = list[list.indexOf(target) + dir]
  if (!next) return
  next.scrollIntoView({ block: 'center', behavior: 'smooth' })
  setTarget(next)
}
let queued = false
const schedule = () => {
  if (queued) return
  queued = true
  requestAnimationFrame(() => { queued = false; nearest() })
}
addEventListener('scroll', schedule, { passive: true })
addEventListener('resize', () => { fit(); schedule() })
new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })

// Only the reply popup: the feed's own "What's happening?" box shares these test ids.
const composer = () => document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]')
const postButton = () => {
  const b = document.querySelector('[role="dialog"] [data-testid="tweetButton"]')
  return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled ? b : null
}
const flat = (t) => t.replace(/\s+/g, ' ').trim()
async function fill(editor, text) {
  editor.focus()
  await wait(60)
  const data = new DataTransfer()
  data.setData('text/plain', text)
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  if (await until(() => flat(editor.innerText) === flat(text), 800)) return true
  editor.focus()
  document.execCommand('selectAll')
  document.execCommand('insertText', false, text)
  return Boolean(await until(() => flat(editor.innerText) === flat(text), 800))
}
const closeComposer = () => {
  document.querySelector('[role="dialog"] [data-testid="app-bar-close"]')?.click()
  setTimeout(() => document.querySelector('[data-testid="confirmationSheetConfirm"]')?.click(), 400)
}

async function send() {
  const text = input.value.trim()
  const post = target
  if (!text || !post || sending) return
  const reply = post.querySelector('[data-testid="reply"]')
  if (!reply) return setStatus('This post has replies turned off', 'bad')
  sending = true
  setStatus('Posting…')
  try {
    reply.click()
    const editor = await until(composer, 5000)
    if (!editor) {
      mm.broken("X's reply box did not open")
      throw new Error('The reply box did not open')
    }
    if (!(await fill(editor, text))) {
      closeComposer()
      throw new Error('X changed the text, so nothing was posted')
    }
    const button = await until(postButton, 4000)
    if (!button) throw new Error('X did not accept the text')
    button.click()
    const closed = await until(() => !document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]'), 8000)
    if (!closed) throw new Error('X did not confirm the post')
    input.value = ''
    input.dispatchEvent(new Event('input'))
    setStatus('Replied to ' + (handleOf(post) || 'the post'), 'good')
    sending = false
    step(1)
  } catch (err) {
    setStatus(err.message + '. Your text is still here.', 'bad')
    sending = false
  }
  input.focus()
}

input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = input.scrollHeight + 'px'
  replyButton.disabled = !input.value.trim()
})
replyButton.addEventListener('click', () => void send())
const postText = (post) => (post.querySelector('[data-testid="tweetText"]')?.innerText || '').trim()
let drafting = false
async function draft() {
  const post = target
  if (!post || drafting) return
  drafting = true
  setStatus('Drafting…')
  try {
    const said = postText(post)
    const text = await mm.ask(
      'Write a reply to this post on X from ' + (handleOf(post) || 'someone') + '. Under 200 characters, casual, specific to what they said, adds a thought instead of praise.' +
      (input.value.trim() ? ' Build on this start: ' + input.value.trim() : '') +
      '\n\nPost: ' + (said || '(no text, likely an image or video)')
    )
    if (target === post) {
      input.value = text
      input.dispatchEvent(new Event('input'))
      setStatus('Draft ready - edit it or press Enter')
    }
  } catch (err) {
    setStatus(err.message, 'bad')
  }
  drafting = false
  input.focus()
}

input.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); void draft() }
  else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send() }
  else if (e.key === 'Escape') input.blur()
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (!input.value || e.altKey)) {
    e.preventDefault()
    step(e.key === 'ArrowDown' ? 1 : -1)
  }
})
schedule()
setTimeout(() => {
  if (/^[/](home|search|[^/]+[/]status[/])/.test(location.pathname) && posts().length && !document.querySelector('article[data-testid="tweet"] [data-testid="reply"]'))
    mm.broken("X's reply buttons are missing")
}, 10000)
`
}
