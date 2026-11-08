// Runs inside pages the app does not own, so it stays plain ES2017 with no imports, and must not contain a backtick.
export const PAGE_REPLY_WIDGET = String.raw`(() => {
  const tag = document.currentScript;
  if (!tag || window.__mmPageReply) return;
  window.__mmPageReply = true;
  const base = new URL(tag.src).origin + '/page/';
  const POLL_MS = 4000;
  const START_TRIES = 30;
  const NEW = 'new';
  const OPEN_KEY = 'mm.pageReply.open';
  const PICK_KEY = 'mm.pageReply.pick:' + location.pathname;
  const ADDED_KEY = 'mm.pageReply.added:' + location.pathname;
  const load = (store, name) => { try { return store.getItem(name) || ''; } catch (err) { return ''; } };
  const save = (store, name, value) => { try { store.setItem(name, value); } catch (err) {} };
  const parse = (list) => String(list || '').split(',').map((pair) => pair.split(':')).filter((p) => p[0] && p[1]).map((p) => ({ id: p[0], key: p[1], name: '' }));
  const sessions = parse(load(localStorage, ADDED_KEY)).concat(parse(tag.dataset.sessions || (tag.dataset.session || '') + ':' + (tag.dataset.key || '')))
    .filter((s, i, all) => all.findIndex((o) => o.id === s.id) === i);
  if (!sessions.length) return;
  let pick = load(sessionStorage, PICK_KEY);
  if (pick !== NEW && !sessions.some((s) => s.id === pick)) pick = sessions[0].id;
  const current = () => sessions.find((s) => s.id === pick) || sessions[0];

  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
  const shadow = root.attachShadow({ mode: 'open' });
  shadow.innerHTML = [
    '<style>',
    ':host{all:initial}',
    '*{box-sizing:border-box;font:13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}',
    '.pill{display:flex;align-items:center;gap:8px;max-width:320px;height:36px;padding:0 14px;border:1px solid #d9d5cb;border-radius:18px;background:#fff;color:#1d1b16;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.14)}',
    '.pill:hover{background:#f6f4ee}',
    '.pill span,.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dot{flex:0 0 8px;height:8px;border-radius:50%;background:#a39e92}',
    '.dot[data-state=working]{background:#d98a1f}.dot[data-state=idle]{background:#2f7d4f}.dot[data-state=off]{background:#c0392b}',
    '.card{display:none;flex-direction:column;width:380px;max-height:min(560px,calc(100vh - 32px));border:1px solid #d9d5cb;border-radius:12px;background:#fff;color:#1d1b16;box-shadow:0 8px 32px rgba(0,0,0,.2);overflow:hidden}',
    '.open .card{display:flex}.open .pill{display:none}',
    '.head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #ebe8df}',
    '.name{flex:1;min-width:0;font-weight:600;border:0;background:none;color:inherit;padding:0;margin:0;outline:none;cursor:pointer;text-overflow:ellipsis}',
    '.state{color:#7a756a;font-size:12px;white-space:nowrap}',
    '.x{border:0;background:none;color:#7a756a;cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;border-radius:4px}.x:hover{background:#f0ede5}',
    '.on{padding:8px 12px;background:#fbfaf6;border-bottom:1px solid #ebe8df;color:#57534a;font-size:12px}',
    '.on:empty{display:none}',
    '.thread{flex:1;min-height:60px;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
    '.turn{white-space:pre-wrap;overflow-wrap:anywhere;padding:7px 10px;border-radius:10px;background:#f3f1ea;align-self:flex-start;max-width:92%}',
    '.turn.you{background:#1d1b16;color:#fff;align-self:flex-end}',
    '.turn.pending{opacity:.6}.turn.failed{background:#fbe9e7;color:#8a2a1f}',
    '.turn button{display:block;margin-top:4px;border:0;background:none;color:inherit;text-decoration:underline;cursor:pointer;padding:0}',
    '.empty{color:#7a756a;font-size:12px}',
    '.shots{display:flex;gap:6px;padding:10px 12px 0;border-top:1px solid #ebe8df}.shots:empty{display:none}',
    '.shot{position:relative}.shot img{height:48px;border-radius:6px;border:1px solid #d9d5cb;display:block}',
    '.shot button{position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:0;background:#1d1b16;color:#fff;cursor:pointer;font-size:11px;line-height:18px;padding:0}',
    'form{display:flex;gap:8px;align-items:flex-end;padding:10px 12px;border-top:1px solid #ebe8df}',
    'textarea{flex:1;min-height:36px;max-height:120px;resize:none;border:1px solid #d9d5cb;border-radius:8px;padding:8px 10px;outline:none;color:#1d1b16;background:#fff}',
    'textarea:focus{border-color:#1d1b16}',
    '.send{height:36px;padding:0 14px;border:0;border-radius:8px;background:#1d1b16;color:#fff;font-weight:600;cursor:pointer}',
    '.send:disabled{opacity:.4;cursor:default}',
    '@media print{:host{display:none}}',
    '</style>',
    '<div class="wrap">',
    '<button class="pill" type="button"><i class="dot"></i><span class="pillname">Reply to the session</span></button>',
    '<div class="card">',
    '<div class="head"><i class="dot"></i><select class="name" title="Switch conversation"></select><div class="state"></div><button class="x" type="button" title="Minimize">&#x2013;</button></div>',
    '<div class="on"></div>',
    '<div class="thread"></div>',
    '<div class="shots"></div>',
    '<form><textarea rows="1" placeholder="Reply, or paste a screenshot"></textarea><button class="send">Send</button></form>',
    '</div></div>'
  ].join('');
  const $ = (sel) => shadow.querySelector(sel);
  const wrap = $('.wrap'), thread = $('.thread'), input = $('textarea'), shots = $('.shots'), sendBtn = $('.send');
  const picker = $('.name');
  const STATES = { working: 'Working', idle: 'Waiting for you', ended: 'Session ended', off: 'MightyMouse is not running', fresh: 'Starts a new agent', starting: 'Starting' };
  let state = 'off', turns = [], local = [], images = [];

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const canSend = () => state === 'working' || state === 'idle' || state === 'fresh';
  const EMPTY = {
    off: 'Open MightyMouse to reply from here.',
    ended: 'This session ended. Pick another conversation above, or start a new one.',
    fresh: 'Your first message starts a new agent in this project. It is told which page you are on.',
    starting: 'Starting the new agent.'
  };

  function renderPicker() {
    picker.innerHTML = sessions.map((s, i) => '<option value="' + esc(s.id) + '">' + esc(s.name || 'Conversation ' + (i + 1)) + '</option>').join('') +
      '<option value="' + NEW + '">+ New conversation</option>';
    picker.value = pick;
    $('.pillname').textContent = pick === NEW ? 'New conversation' : 'Reply to ' + (current().name || 'the session');
  }

  function render() {
    shadow.querySelectorAll('.dot').forEach((d) => { d.dataset.state = state === 'ended' ? 'off' : state; });
    $('.state').textContent = STATES[state];
    sendBtn.disabled = !canSend() || (!input.value.trim() && images.length === 0);
    input.disabled = !canSend();
    const rows = turns.map((t) => '<div class="turn ' + (t.role === 'you' ? 'you' : '') + '">' + esc(t.text) + '</div>')
      .concat(local.map((m, i) => '<div class="turn you ' + m.status + '">' + esc(m.text || 'Screenshot') +
        (m.status === 'failed' ? '<button type="button" data-retry="' + i + '">Could not send. Retry</button>' : '') + '</div>'));
    const stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
    thread.innerHTML = rows.length ? rows.join('') : '<div class="empty">' + (EMPTY[state] || 'Nothing said in this session yet.') + '</div>';
    if (stick) thread.scrollTop = thread.scrollHeight;
    shots.innerHTML = images.map((src, i) => '<div class="shot"><img src="' + src + '"><button type="button" data-drop="' + i + '">&#xd7;</button></div>').join('');
  }

  const auth = (s) => 'session=' + encodeURIComponent(s.id) + '&key=' + encodeURIComponent(s.key);

  async function context(s) {
    const res = await fetch(base + 'context?' + auth(s), { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const ctx = await res.json();
    if (ctx.name && ctx.name !== s.name) { s.name = ctx.name; renderPicker(); }
    return ctx;
  }

  async function pull() {
    if (document.hidden || state === 'starting') return;
    if (pick === NEW) { state = 'fresh'; turns = []; $('.on').textContent = ''; render(); return; }
    const asked = pick;
    try {
      const ctx = await context(current());
      if (asked !== pick) return;
      state = ctx.state || 'ended';
      turns = ctx.turns || [];
      $('.on').textContent = ctx.workingOn ? 'Working on: ' + ctx.workingOn : '';
      local = local.filter((m) => m.status !== 'sent' || !turns.some((t) => t.role === 'you' && t.at >= m.at));
    } catch (err) {
      state = 'off';
    }
    render();
  }

  function choose(id) {
    pick = id;
    save(sessionStorage, PICK_KEY, id);
    local = [];
    turns = [];
    state = id === NEW ? 'fresh' : 'off';
    renderPicker();
    render();
    pull();
  }

  async function startNew(message) {
    const from = sessions[0];
    const res = await fetch(base + NEW, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: from.id, key: from.key, text: message.text, images: message.images, page: document.title || location.pathname, href: location.href })
    });
    if (!res.ok) return false;
    const pane = (await res.json()).pane;
    state = 'starting';
    render();
    for (let i = 0; i < START_TRIES; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const got = await fetch(base + 'started?' + auth(from) + '&pane=' + encodeURIComponent(pane), { cache: 'no-store' }).then((r) => r.json()).catch(() => ({}));
      if (got.session) {
        sessions.unshift({ id: got.session, key: got.key, name: '' });
        save(localStorage, ADDED_KEY, sessions.map((s) => s.id + ':' + s.key).join(','));
        state = 'off';
        choose(got.session);
        return true;
      }
    }
    state = 'fresh';
    return true;
  }

  async function deliver(message) {
    message.status = 'pending';
    render();
    try {
      if (pick === NEW) message.status = (await startNew(message)) ? 'sent' : 'failed';
      else {
        const to = current();
        const res = await fetch(base + 'reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: to.id, key: to.key, text: message.text, images: message.images, page: document.title || location.pathname })
        });
        message.status = res.ok ? 'sent' : 'failed';
      }
    } catch (err) {
      message.status = 'failed';
    }
    render();
    thread.scrollTop = thread.scrollHeight;
  }

  function setOpen(open) {
    wrap.classList.toggle('open', open);
    save(sessionStorage, OPEN_KEY, open ? '1' : '');
    if (open) { thread.scrollTop = thread.scrollHeight; input.focus(); }
  }

  $('.pill').onclick = () => setOpen(true);
  $('.x').onclick = () => setOpen(false);
  input.oninput = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; render(); };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form').requestSubmit(); }
    if (e.key === 'Escape') setOpen(false);
  };
  input.onpaste = (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => f.type.indexOf('image/') === 0);
    if (!files.length) return;
    e.preventDefault();
    files.slice(0, 3 - images.length).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => { images.push(String(reader.result)); render(); };
      reader.readAsDataURL(file);
    });
  };
  shadow.addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset && t.dataset.drop !== undefined) { images.splice(Number(t.dataset.drop), 1); render(); }
    if (t.dataset && t.dataset.retry !== undefined) deliver(local[Number(t.dataset.retry)]);
  });
  $('form').onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!canSend() || (!text && images.length === 0)) return;
    const message = { text: text, images: images, at: Date.now(), status: 'pending' };
    local.push(message);
    images = [];
    input.value = '';
    input.style.height = 'auto';
    deliver(message);
  };

  document.documentElement.appendChild(root);
  picker.onchange = () => choose(picker.value);
  renderPicker();
  sessions.filter((s) => s.id !== pick).forEach((s) => { context(s).catch(() => {}); });
  if (load(sessionStorage, OPEN_KEY) === '1') setOpen(true);
  pull();
  setInterval(pull, POLL_MS);
  document.addEventListener('visibilitychange', pull);
})();
`
