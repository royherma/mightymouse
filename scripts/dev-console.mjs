#!/usr/bin/env node
// dev-console.mjs — Read the Electron renderer console + DOM state over CDP.
//
// Renderer errors never reach the dev-server stdout (a blank window = a thrown
// error visible only in DevTools). This script connects to the remote-debugging
// port the dev build exposes (see src/main/index.ts, dev-only) and prints, for
// every open window: its URL, whether #root rendered, any console errors, and any
// uncaught exceptions. Zero dependencies — raw WebSocket over node's `net`.
//
//   npm run dev:console            # dump all windows once
//   npm run dev:console panel      # only the window whose URL contains "panel"
//   node scripts/dev-console.mjs eval "document.title"   # run an expression
//
// Requires the dev app running (npm run dev) with the CDP port up (default 9322,
// override with MM_CDP_PORT). If you see "no targets", the app isn't running.
import net from 'node:net';
import crypto from 'node:crypto';
import http from 'node:http';

const PORT = process.env.MM_CDP_PORT || '9322';
const filter = process.argv[2] && process.argv[2] !== 'eval' ? process.argv[2] : null;
const evalExpr = process.argv[2] === 'eval' ? process.argv[3] : null;

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/json`, (res) => {
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Minimal CDP-over-WebSocket client (RFC6455 client frames, no deps).
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let handshook = false, buf = Buffer.alloc(0);
    const handlers = { id: 0, cbs: new Map(), events: [] };
    const send = (method, params = {}) =>
      new Promise((res) => { const id = ++handlers.id; handlers.cbs.set(id, res); sock.write(frame(JSON.stringify({ id, method, params }))); });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshook) {
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) return;
        buf = buf.slice(i + 4); handshook = true;
        resolve({ send, events: handlers.events, close: () => sock.destroy() });
      }
      // parse server frames (unmasked)
      while (buf.length >= 2) {
        const len0 = buf[1] & 0x7f; let off = 2, len = len0;
        if (len0 === 126) { len = buf.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const payload = buf.slice(off, off + len).toString(); buf = buf.slice(off + len);
        try {
          const m = JSON.parse(payload);
          if (m.id && handlers.cbs.has(m.id)) { handlers.cbs.get(m.id)(m); handlers.cbs.delete(m.id); }
          else if (m.method) handlers.events.push(m);
        } catch { /* ignore non-JSON frame */ }
      }
    });
    sock.on('error', reject);
  });
}

function frame(str) {
  const data = Buffer.from(str);
  const mask = crypto.randomBytes(4);
  const len = data.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0xfe; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0xff; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let targets;
  try { targets = await getTargets(); }
  catch { console.error(`✗ No CDP on :${PORT}. Is the dev app running? (npm run dev)`); process.exit(1); }
  const pages = targets.filter((t) => t.type === 'page' && (!filter || (t.url || '').includes(filter)));
  if (!pages.length) { console.error('✗ No matching window. Open targets:\n' + targets.map((t) => '  ' + t.url).join('\n')); process.exit(1); }

  for (const p of pages) {
    console.log(`\n━━━ ${p.url} ━━━`);
    const c = await cdp(p.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await c.send('Log.enable');
    if (evalExpr) {
      const r = await c.send('Runtime.evaluate', { expression: evalExpr, returnByValue: true });
      console.log('eval →', JSON.stringify(r.result?.result?.value ?? r.result, null, 2));
    } else {
      const r = await c.send('Runtime.evaluate', {
        expression: `JSON.stringify({ root: (document.getElementById('root')||{}).innerHTML?.slice(0,300) || 'NO #root', bodyText: document.body?.innerText?.slice(0,300), api: typeof window.api })`,
        returnByValue: true,
      });
      const dom = JSON.parse(r.result?.result?.value || '{}');
      console.log('  #root:', dom.root === '' ? '(empty — render produced nothing)' : dom.root?.slice(0, 120));
      console.log('  bodyText:', JSON.stringify(dom.bodyText));
      console.log('  window.api:', dom.api);
    }
    await sleep(800); // let console/exception events arrive
    const errs = c.events.filter((e) =>
      e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params?.type)) ||
      (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params?.entry?.level)));
    if (errs.length) {
      console.log('  ⚠️  console errors/exceptions:');
      for (const e of errs.slice(0, 10)) {
        if (e.method === 'Runtime.exceptionThrown') {
          const d = e.params.exceptionDetails;
          console.log('   ✗', d.exception?.description || d.text);
        } else if (e.method === 'Runtime.consoleAPICalled') {
          console.log('   •', e.params.args?.map((a) => a.value ?? a.description).join(' '));
        } else {
          console.log('   •', e.params.entry?.text);
        }
      }
    } else {
      console.log('  ✓ no console errors captured');
    }
    c.close();
  }
  process.exit(0);
})();
