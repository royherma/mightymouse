const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 1 0-7 0v6A3.5 3.5 0 0 0 12 15Zm6-3.5a.9.9 0 1 1 1.8 0 7.8 7.8 0 0 1-6.9 7.75V21a.9.9 0 1 1-1.8 0v-1.75A7.8 7.8 0 0 1 4.2 11.5a.9.9 0 1 1 1.8 0 6 6 0 0 0 12 0Z"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 3.5l1.6 4.4L16 9.5l-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6L10 3.5Zm7.5 9l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4Z"/></svg>',
  shift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 4 4 12.5h4.5V20h7v-7.5H20L12 4Z"/></svg>',
  shiftOn: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4 4 12.5h4.5V20h7v-7.5H20L12 4Z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 4 11h4.5v5.5h7V11H20l-8-8Z"/><rect x="8.5" y="18" width="7" height="2.2" rx=".6"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M9 5h10.5a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5H9l-6-7 6-7Z"/><path d="m11.5 9.5 5 5m0-5-5 5" stroke-linecap="round"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.7 2.5 2.7 15.5 0 18M12 3c-2.7 2.5-2.7 15.5 0 18"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
}

const ROWS = {
  abc: [['q','w','e','r','t','y','u','i','o','p'], ['a','s','d','f','g','h','j','k','l'], ['z','x','c','v','b','n','m']],
  '123': [['1','2','3','4','5','6','7','8','9','0'], ['-','/',':',';','(',')','$','&','@','"'], ['.',',','?','!',"'"]],
  sym: [['[',']','{','}','#','%','^','*','+','='], ['_','\\','|','~','<','>','€','£','¥','•'], ['.',',','?','!',"'"]],
}

const WORDS = 'the to and you that it for on with this have be are at can will just we what was so not but about meeting tomorrow thanks thank today tonight time think thought great good going get got know need next later lunch let love like looking leave right really running ready sounds sure see send some sorry still start done dinner doing work works working week weekend when where would with yes yeah okay perfect plan please call coming could free friday from morning monday maybe more message minutes hey hello here home how happy'.split(' ')
const SPOKEN = 'hey sorry I am running about ten minutes late can we push the call to four thirty'.split(' ')
const SPOKEN_CLEAN = "Hey, sorry, I'm running about 10 minutes late. Can we push the call to 4:30?"
const AI = [
  { id: 'fix', label: 'Fix', out: (t) => t.replace(/\bi\b/g, 'I').replace(/\s+/g, ' ').replace(/(^|[.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/([^.!?])$/, '$1.') },
  { id: 'short', label: 'Shorter', out: () => 'Running 10 min late - can we do 4:30?' },
  { id: 'friendly', label: 'Friendlier', out: () => "Hey! So sorry, I'm running about 10 minutes behind. Would 4:30 work for the call instead?" },
  { id: 'pro', label: 'Professional', out: () => 'Apologies, I am running about 10 minutes late. Could we move our call to 4:30?' },
  { id: 'translate', label: 'Spanish', out: () => 'Perdón, llego unos 10 minutos tarde. ¿Podemos pasar la llamada a las 4:30?' },
]

const fresh = (over = {}) => ({
  text: '', caret: 0, shift: 'once', layer: 'abc', mode: 'idle', live: [], level: 0,
  ret: 'return', aiOut: '', aiLabel: '', note: null, lastInsert: null, pressed: null, ...over,
})

function currentWord(s) {
  const m = s.text.slice(0, s.caret).match(/([A-Za-z']+)$/)
  return m ? m[1] : ''
}

function suggestions(s) {
  const w = currentWord(s).toLowerCase()
  if (!w) return ['I', 'Thanks', 'Sounds good']
  const hits = WORDS.filter((x) => x.startsWith(w) && x !== w).slice(0, 2)
  return [`"${currentWord(s)}"`, ...hits].concat(['', '']).slice(0, 3)
}

function el(tag, cls, html) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (html != null) n.innerHTML = html
  return n
}

function barFor(s, act) {
  const bar = el('div', 'bar')
  if (s.mode === 'listening' || s.mode === 'writing') return bar
  if (s.note) {
    bar.append(el('span', 'msg', `${s.note.text}${s.note.action ? ` <b>${s.note.action}</b>` : ''}`))
    bar.querySelector('b')?.addEventListener('click', () => act('noteAction'))
    return bar
  }
  const talk = el('button', 'talk', `${ICON.mic}Talk`)
  talk.addEventListener('pointerdown', () => act('micDown'))
  talk.addEventListener('pointerup', () => act('micUp'))
  bar.append(talk)
  if (s.mode === 'inserted') {
    const chips = el('div', 'chips')
    const undo = el('button', 'chip', `${ICON.undo}Undo`)
    undo.addEventListener('click', () => act('undo'))
    const clean = el('button', 'chip accent', `${ICON.spark}Polish it`)
    clean.addEventListener('click', () => act('ai', 'friendly'))
    chips.append(undo, clean)
    bar.append(chips)
    return bar
  }
  if (s.mode === 'ai' || s.mode === 'aiWorking' || s.mode === 'aiPreview') {
    const chips = el('div', 'chips')
    for (const a of AI) {
      const c = el('button', 'chip', a.label)
      if (s.mode === 'aiWorking' && s.aiLabel === a.label) c.innerHTML = `<span class="spin"></span>${a.label}`
      c.addEventListener('click', () => act('ai', a.id))
      chips.append(c)
    }
    bar.append(chips)
  } else {
    const sugg = el('div', 'sugg')
    suggestions(s).forEach((w, i) => {
      const b = el('button', i === 1 ? 'main' : '', w)
      b.addEventListener('click', () => act('pick', w))
      sugg.append(b)
    })
    bar.append(sugg)
  }
  const spark = el('button', `spark${s.mode.startsWith('ai') ? ' on' : ''}`, ICON.spark)
  spark.title = 'Rewrite what you typed'
  spark.addEventListener('click', () => act('spark'))
  bar.append(spark)
  return bar
}

function listenStrip(s, act) {
  const strip = el('div', 'listen')
  const x = el('button', 'x', ICON.x)
  x.addEventListener('click', () => act('cancel'))
  const wave = el('div', 'wave')
  for (let i = 0; i < 9; i++) {
    const h = s.mode === 'writing' ? 4 : 4 + Math.round(Math.abs(Math.sin(i * 1.7 + s.live.length)) * 22 * (0.3 + s.level))
    wave.append(Object.assign(el('i'), { style: `height:${h}px` }))
  }
  const live = el('div', 'live')
  live.innerHTML = s.mode === 'writing'
    ? '<span class="hint">Writing it out…</span>'
    : s.live.length ? `<span>${s.live.join(' ')}</span>` : '<span class="hint">Listening… talk now</span>'
  const ok = el('button', 'ok', s.mode === 'writing' ? '<span class="spin" style="border-top-color:#fff"></span>' : ICON.check)
  ok.addEventListener('click', () => act('done'))
  strip.append(x, wave, live, ok)
  return strip
}

function keyboard(s, act) {
  const kb = el('div', `kb${s.mode === 'listening' || s.mode === 'writing' ? ' dim' : ''}`)
  kb.append(barFor(s, act))
  if (s.mode === 'listening' || s.mode === 'writing') kb.append(listenStrip(s, act))
  if (s.mode === 'aiPreview') {
    const p = el('div', 'preview', `<small>${s.aiLabel}</small>${s.aiOut}<div class="acts"><button>Keep mine</button><button class="go">Replace</button></div>`)
    const [keep, go] = p.querySelectorAll('button')
    keep.addEventListener('click', () => act('aiKeep'))
    go.addEventListener('click', () => act('aiReplace'))
    kb.append(p)
  }
  const rows = el('div', 'rows')
  const set = ROWS[s.layer]
  const upper = s.layer === 'abc' && s.shift !== 'off'
  set.forEach((keys, r) => {
    const row = el('div', `row${r === 1 && s.layer === 'abc' ? ' r2' : ''}`)
    if (r === 2) {
      const left = s.layer === 'abc'
        ? el('div', 'k fn wide', s.shift === 'lock' ? ICON.lock : s.shift === 'once' ? ICON.shiftOn : ICON.shift)
        : el('div', 'k fn wide', s.layer === '123' ? '#+=' : '123')
      if (s.layer === 'abc' && s.shift !== 'off') left.classList.add('on')
      left.addEventListener('click', () => act(s.layer === 'abc' ? 'shift' : 'layer', s.layer === '123' ? 'sym' : '123'))
      row.append(left)
    }
    for (const k of keys) {
      const ch = upper ? k.toUpperCase() : k
      const key = el('div', 'k', ch)
      if (s.layer !== 'abc' && r === 2) key.style.flex = '0 0 46px'
      key.addEventListener('pointerdown', () => { key.append(el('div', 'pop', ch)) })
      key.addEventListener('pointerup', () => { key.querySelector('.pop')?.remove(); act('type', ch) })
      key.addEventListener('pointerleave', () => key.querySelector('.pop')?.remove())
      if (s.pressed === k) key.append(el('div', 'pop', ch))
      row.append(key)
    }
    if (r === 2) {
      const del = el('div', 'k fn wide', ICON.del)
      del.addEventListener('click', () => act('del'))
      row.append(del)
    }
    rows.append(row)
  })
  const bottom = el('div', 'row')
  const mode = el('div', 'k mode', s.layer === 'abc' ? '123' : 'ABC')
  mode.addEventListener('click', () => act('layer', s.layer === 'abc' ? '123' : 'abc'))
  const space = el('div', 'k space', 'space')
  let dragX = null
  space.addEventListener('pointerdown', (e) => { dragX = e.clientX; space.setPointerCapture(e.pointerId) })
  space.addEventListener('pointermove', (e) => {
    if (dragX == null) return
    const steps = Math.trunc((e.clientX - dragX) / 9)
    if (steps) { dragX += steps * 9; act('moveCaret', steps); space.textContent = '' }
  })
  space.addEventListener('pointerup', () => { if (space.textContent === 'space') act('type', ' '); dragX = null; space.textContent = 'space' })
  const ret = el('div', `k ret${s.ret !== 'return' ? ' blue' : ''}`, s.ret)
  ret.addEventListener('click', () => act('type', '\n'))
  bottom.append(mode, space, ret)
  rows.append(bottom)
  kb.append(rows)
  const sys = el('div', 'sys', `<span>${ICON.globe}</span><span style="opacity:.35">${ICON.mic}</span>`)
  kb.append(sys, el('div', 'home'))
  return kb
}

function reducer(s, type, arg) {
  const insert = (str) => {
    const t = s.text.slice(0, s.caret) + str + s.text.slice(s.caret)
    return { text: t, caret: s.caret + str.length }
  }
  switch (type) {
    case 'type': {
      let str = arg
      if (str === ' ' && s.text.slice(0, s.caret).endsWith(' ') && /\w $/.test(s.text.slice(0, s.caret))) {
        const t = s.text.slice(0, s.caret - 1) + '. ' + s.text.slice(s.caret)
        return { ...s, text: t, caret: s.caret + 1, shift: 'once', mode: 'idle' }
      }
      const next = { ...s, ...insert(str), mode: s.mode.startsWith('ai') || s.mode === 'inserted' ? 'idle' : s.mode }
      if (s.shift === 'once') next.shift = 'off'
      if (s.layer !== 'abc' && (str === ' ' || str === "'")) next.layer = 'abc'
      if (/[.!?]\s$/.test(next.text.slice(0, next.caret)) || str === '\n') next.shift = s.shift === 'lock' ? 'lock' : 'once'
      return next
    }
    case 'del': {
      if (!s.caret) return s
      const t = s.text.slice(0, s.caret - 1) + s.text.slice(s.caret)
      return { ...s, text: t, caret: s.caret - 1, shift: s.caret - 1 === 0 ? 'once' : s.shift, mode: 'idle' }
    }
    case 'shift': return { ...s, shift: s.shift === 'off' ? 'once' : s.shift === 'once' ? 'lock' : 'off' }
    case 'layer': return { ...s, layer: arg }
    case 'moveCaret': return { ...s, caret: Math.max(0, Math.min(s.text.length, s.caret + arg)) }
    case 'pick': {
      if (!arg) return s
      const w = currentWord(s)
      const word = arg.replace(/"/g, '')
      const before = s.text.slice(0, s.caret - w.length)
      const t = before + word + ' ' + s.text.slice(s.caret)
      return { ...s, text: t, caret: before.length + word.length + 1, shift: 'off' }
    }
    case 'spark': return { ...s, mode: s.mode.startsWith('ai') ? 'idle' : 'ai' }
    case 'undo': {
      if (!s.lastInsert) return { ...s, mode: 'idle' }
      return { ...s, text: s.lastInsert.before, caret: s.lastInsert.caret, mode: 'idle', lastInsert: null }
    }
    case 'aiKeep': return { ...s, mode: 'idle', aiOut: '' }
    case 'aiReplace': return { ...s, lastInsert: { before: s.text, caret: s.caret }, text: s.aiOut, caret: s.aiOut.length, mode: 'inserted', aiOut: '' }
    case 'noteAction': return { ...s, note: null, mode: 'idle' }
    default: return s
  }
}

function mount(host, initial, { live = true } = {}) {
  let s = initial
  let timer = null
  let micDownAt = 0
  const draw = () => {
    host.innerHTML = ''
    if (live) {
      const note = host.closest('.phone')?.querySelector('.note .body')
      if (note) note.innerHTML = escape(s.text.slice(0, s.caret)) + '<span class="caret"></span>' + escape(s.text.slice(s.caret))
    }
    host.append(keyboard(s, act))
  }
  const set = (next) => { s = next; draw() }
  const stopTimers = () => { clearInterval(timer); timer = null }
  function startListening() {
    stopTimers()
    set({ ...s, mode: 'listening', live: [], level: 0, note: null })
    let i = 0
    timer = setInterval(() => {
      if (i < SPOKEN.length) set({ ...s, live: [...s.live, SPOKEN[i++]], level: Math.random() })
      else set({ ...s, level: Math.random() * 0.2 })
    }, 260)
  }
  function finish() {
    if (s.mode !== 'listening') return
    stopTimers()
    set({ ...s, mode: 'writing' })
    setTimeout(() => {
      const before = s.text.slice(0, s.caret)
      const pad = before && !/\s$/.test(before) ? ' ' : ''
      const ins = pad + SPOKEN_CLEAN
      set({ ...s, lastInsert: { before: s.text, caret: s.caret }, text: before + ins + s.text.slice(s.caret), caret: s.caret + ins.length, mode: 'inserted', live: [] })
      timer = setTimeout(() => { if (s.mode === 'inserted') set({ ...s, mode: 'idle' }) }, 7000)
    }, 900)
  }
  function act(type, arg) {
    if (!live) return
    if (type === 'micDown') { micDownAt = Date.now(); if (s.mode !== 'listening') startListening(); else finish(); return }
    if (type === 'micUp') { if (s.mode === 'listening' && Date.now() - micDownAt > 450 && s.live.length) finish(); return }
    if (type === 'done') return finish()
    if (type === 'cancel') { stopTimers(); return set({ ...s, mode: 'idle', live: [] }) }
    if (type === 'noteAction' && s.note?.retry) {
      const retry = s.note.retry
      set({ ...s, note: null })
      if (retry === 'talk') return startListening()
      if (retry === 'write') { set({ ...s, mode: 'listening', live: SPOKEN }); return finish() }
      return act('ai', retry)
    }
    if (type === 'ai') {
      const a = AI.find((x) => x.id === arg)
      const src = s.text.trim() || SPOKEN_CLEAN
      set({ ...s, mode: 'aiWorking', aiLabel: a.label })
      setTimeout(() => set({ ...s, mode: 'aiPreview', aiOut: a.out(src) }), 700)
      return
    }
    set(reducer(s, type, arg))
  }
  draw()
  return { set: (over) => set({ ...s, ...over }), get: () => s }
}

const escape = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')

const GALLERY = [
  ['Typing', 'word ideas on top', { text: 'Running a bit la', caret: 16, shift: 'off' }],
  ['Talking', 'live words as you speak', { mode: 'listening', live: SPOKEN.slice(0, 9), level: .8 }],
  ['Writing it out', 'a second after Done', { mode: 'writing' }],
  ['Just typed it', 'undo or polish', { mode: 'inserted', text: SPOKEN_CLEAN, caret: SPOKEN_CLEAN.length }],
  ['Rewrite', 'one-tap rewrites', { mode: 'ai', text: SPOKEN_CLEAN }],
  ['Rewrite result', 'see it before it replaces', { mode: 'aiPreview', aiLabel: 'Friendlier', aiOut: AI[2].out() }],
  ['Numbers', '123 layer', { layer: '123', shift: 'off' }],
  ['Caps lock', 'double-tap shift', { shift: 'lock' }],
  ['Messages', 'return becomes Send', { ret: 'send', shift: 'off', text: 'ok' }],
  ['Dark mode', 'talking, dark phone', { mode: 'listening', live: SPOKEN.slice(0, 6), level: .6, dark: true }],
  ['Setup: Full Access', 'first Talk, Full Access off', { note: { text: 'Turn on Full Access to talk', action: 'Open Settings' } }],
  ['Setup: mic', 'mic never allowed in the app', { note: { text: 'Allow the mic once in MightyMouse', action: 'Open' } }],
  ['Heard nothing', 'silence or too quiet', { note: { text: "Didn't catch that", action: 'Try again', retry: 'talk' } }],
  ['Write-out failed', 'recording kept, one tap retries', { note: { text: "Couldn't write that out", action: 'Retry', retry: 'write' } }],
  ['Rewrite failed', 'your text is untouched', { text: SPOKEN_CLEAN, note: { text: "Couldn't rewrite that", action: 'Retry', retry: 'friendly' } }],
  ['Apple Intelligence off', 'rewrites need it', { note: { text: 'Rewrites need Apple Intelligence', action: 'Open Settings' } }],
  ['Mic busy', 'on a call, or another app has it', { note: { text: 'The mic is busy right now', action: 'Try again', retry: 'talk' } }],
  ['Talk from the app', 'if the keyboard mic is blocked', { note: { text: 'Opening MightyMouse to listen…' } }],
]

function build() {
  const stage = document.getElementById('stage')
  stage.innerHTML = ''
  const left = el('div')
  const phone = el('div', 'phone', '<div class="note"><div class="app">‹ Notes</div><div class="body"></div></div>')
  const kbHost = el('div')
  phone.append(kbHost)
  left.append(phone)
  const live = mount(kbHost, fresh())

  const side = el('div', 'side')
  side.append(el('h3', '', 'Every state · click one to load it on the phone'))
  const gallery = el('div', 'gallery')
  for (const [name, cap, over] of GALLERY) {
    const cell = el('div', 'cell', `<div class="cap"><b>${name}</b> · ${cap}</div>`)
    const mini = el('div', `mini${over.dark ? ' dark' : ''}`)
    mount(mini, fresh(over), { live: false })
    cell.append(mini)
    cell.addEventListener('click', () => {
      document.body.classList.toggle('dark', !!over.dark)
      darkBox.checked = !!over.dark
      live.set({ ...fresh(), ...over })
    })
    gallery.append(cell)
  }
  side.append(gallery)
  stage.append(left, side)

  const darkBox = document.getElementById('dark')
  darkBox.onchange = () => document.body.classList.toggle('dark', darkBox.checked)
  document.getElementById('ret').onchange = (e) => live.set({ ret: e.target.value })
}

document.getElementById('sub').textContent = 'Type, hold or tap Talk, try ✨ - the left phone is live'
document.querySelector('.top').insertAdjacentHTML('beforeend',
  '<label>Return key <select id="ret"><option>return</option><option>send</option><option>search</option></select></label><label><input type="checkbox" id="dark"> Dark</label>')
build()
