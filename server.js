// InstaFollowCheck — backend API per Render.
// Espone gli endpoint del tool (screencast WebSocket, progress SSE, analisi
// Puppeteer) e valida ogni richiesta col JWT dell'utente Supabase.
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const PORT = Number(process.env.PORT) || 3000;

// ----- Supabase (per autenticare il JWT dell'utente) -----
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function decodeExp(token) {
  try {
    const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = part + '='.repeat((4 - (part.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch (_) {
    return null;
  }
}

const tokenCache = new Map(); // token -> { user, until }
async function verifyToken(token) {
  if (!token) return null;
  const now = Date.now();
  const hit = tokenCache.get(token);
  if (hit && hit.until > now) return hit.user;
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      tokenCache.delete(token);
      return null;
    }
    const user = await resp.json();
    const exp = decodeExp(token);
    const ttl = exp ? exp * 1000 - now : 600000;
    tokenCache.set(token, { user, until: now + Math.max(Math.min(ttl, 600000), 10000) });
    return user;
  } catch (_) {
    return null;
  }
}

function getTokenFrom(req) {
  const auth = req.get('authorization') || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}

async function requireAuth(req, res, next) {
  const token = getTokenFrom(req);
  const user = await verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized — log in first.' });
  req.user = user;
  req.token = token;
  next();
}

// ---------------------------------------------------------------------------
// Timing di analisi (stessi default del progetto, override via env CF_*).
// ---------------------------------------------------------------------------
const CONFIG = {
  pageLoadMs: Number(process.env.CF_PAGE_LOAD_MS) || 1500,
  dialogOpenMs: Number(process.env.CF_DIALOG_OPEN_MS) || 1000,
  scrollGapMs: Number(process.env.CF_SCROLL_GAP_MS) || 300,
  stableRounds: Number(process.env.CF_STABLE_ROUNDS) || 3,
  finalGraceMs: Number(process.env.CF_FINAL_GRACE_MS) || 900,
  maxIterations: Number(process.env.CF_MAX_ITERATIONS) || 1500,
};

const app = express();
app.use(express.json());
app.use(cors({ origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGIN.length === 0 || ALLOWED_ORIGIN.includes(origin)), credentials: true }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Diagnostica deploy: mostra dove puppeteer cerca Chrome e se esiste.
app.get('/api/debug', requireAuth, async (req, res) => {
  try {
    const fs = require('fs');
    const puppeteer = require('puppeteer');
    let exe = null;
    try { exe = puppeteer.executablePath(); } catch (e) { exe = 'ERR: ' + ((e && e.message) || e); }
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || null;
    const check = (p) => (p ? fs.existsSync(p) : null);
    res.json({
      cacheDir,
      executablePath: exe,
      exists: typeof exe === 'string' ? check(exe) : null,
      home: process.env.HOME || null,
      cwd: process.cwd(),
      nodeModules: check(require('path').join(process.cwd(), 'node_modules')),
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

const broker = new EventEmitter();
function emit(type, data = {}) {
  broker.emit('event', { type, ...data });
}

let browser = null;
let page = null;
let busy = false;
let cdpSession = null;
let screencastClient = null;

function broadcast(type, data = {}) {
  if (screencastClient && screencastClient.readyState === 1) {
    try { screencastClient.send(JSON.stringify({ t: type, ...data })); } catch (_) {}
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Assicura che l'eseguibile di Chrome esista; se manca (es. immagine Render
// senza la cache di build), lo scarica a runtime prima di lanciare il browser.
let chromeReady = null;
async function ensureChrome() {
  // Se un download è già in corso (o già riuscito), riusa la stessa promessa.
  if (chromeReady) return chromeReady;
  chromeReady = (async () => {
    const pp = require('puppeteer');
    // NB: puppeteer.executablePath() LANCIA quando il browser manca (non ritorna
    // un path) — per questo va in try/catch separato e si procede al download.
    let exe = null;
    try { exe = pp.executablePath(); } catch (_) { exe = null; }
    if (exe && fs.existsSync(exe)) return exe;
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || require('path').join(process.cwd(), 'node_modules', 'puppeteer-cache');
    console.log('Chrome mancante — download in corso in', cacheDir);
    const { install } = require('@puppeteer/browsers');
    let buildId = null;
    try { buildId = (pp.configuration && pp.configuration.browserRevision) || null; } catch (_) {}
    if (!buildId) {
      const revPath = require('path').join(process.cwd(), 'node_modules', 'puppeteer-core', 'lib', 'cjs', 'puppeteer', 'revisions.js');
      try {
        const m = fs.readFileSync(revPath, 'utf8').match(/chrome\s*:\s*'([^']+)'/);
        if (m) buildId = m[1];
      } catch (_) {}
    }
    if (!buildId) {
      const { resolveBuildId } = require('@puppeteer/browsers');
      buildId = await resolveBuildId('chrome', 'linux', 'latest');
    }
    console.log('ensureChrome: buildId =', buildId);
    const installed = await install({
      browser: 'chrome',
      buildId,
      cacheDir,
      baseUrl: 'https://storage.googleapis.com/chrome-for-testing-public',
    });
    console.log('ensureChrome: installato a', installed.executablePath, '| exists =', fs.existsSync(installed.executablePath));
    return installed.executablePath;
  })();
  chromeReady.catch((err) => {
    console.error('ensureChrome error:', String((err && err.message) || err));
    chromeReady = null; // consente un nuovo tentativo al prossimo giro
  });
  return chromeReady;
}

async function getBrowser() {
  if (browser && browser.connected) return browser;
  const exe = await ensureChrome();
  if (!exe) throw new Error('Chrome non disponibile: download a runtime fallito (vedi log).');
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: exe,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: { width: 1100, height: 760 },
  });
  page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await setupCDP();
  return browser;
}

async function getCDP() {
  if (!cdpSession || !cdpSession.connection) cdpSession = page ? await page.createCDPSession() : null;
  return cdpSession;
}
async function setupCDP() {
  if (!page) return;
  const cdp = await getCDP();
  await cdp.send('Page.enable').catch(() => {});
  await cdp.send('Input.enable').catch(() => {});
  cdp.on('Page.screencastFrame', (msg) => {
    cdp.send('Page.screencastFrameAck', { sessionId: msg.sessionId }).catch(() => {});
    broadcast('frame', { img: msg.data });
  });
}
async function startScreencast() {
  if (!browser || !browser.connected || !page) return;
  const cdp = await getCDP();
  await cdp.send('Page.enable').catch(() => {});
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1100, maxHeight: 760, everyNthFrame: 1 }).catch(() => {});
}
async function stopScreencast() {
  if (!cdpSession) return;
  try { await cdpSession.send('Page.stopScreencast'); } catch (_) {}
}

const SPECIAL_KEYS = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32 };
function keycodeOf(key, code) {
  if (key && SPECIAL_KEYS[key] != null) return SPECIAL_KEYS[key];
  if (code && /^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (code && /^Digit\d$/.test(code)) return code.charCodeAt(5) + 41;
  if (key && key.length === 1) return key.toUpperCase().charCodeAt(0);
  return 0;
}

async function dispatchInput(msg) {
  const cdp = await getCDP();
  if (!cdp) return;
  const base = msg.pos ? { x: msg.pos.x, y: msg.pos.y } : {};
  switch (msg.type) {
    case 'mousemove': await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base }); break;
    case 'mousedown': await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, button: 'left', clickCount: 1 }); break;
    case 'mouseup': await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, button: 'left', clickCount: 1 }); break;
    case 'wheel': await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...base, deltaX: msg.deltaX || 0, deltaY: msg.deltaY || 0 }); break;
    case 'keydown': {
      const vk = keycodeOf(msg.key, msg.code);
      if (msg.key && msg.key.length === 1 && !msg.ctrlKey && !msg.metaKey && !msg.altKey) {
        await cdp.send('Input.insertText', { text: msg.key });
      } else if (vk) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: msg.key || '', code: msg.code || '', windowsVirtualKeyCode: vk });
      }
      break;
    }
    case 'keyup': {
      const vk = keycodeOf(msg.key, msg.code);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: msg.key || '', code: msg.code || '', windowsVirtualKeyCode: vk });
      break;
    }
  }
}

async function getUser(p) {
  return await p.evaluate(() => {
    for (const a of document.querySelectorAll('nav a[href]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/([A-Za-z0-9_.]{1,30})\/?$/);
      if (!m) continue;
      const lc = href.toLowerCase();
      if (['/', '/explore', '/direct', '/reels', '/accounts', '/threads'].includes(lc) || lc.startsWith('/explore') || lc.startsWith('/direct') || lc.startsWith('/accounts')) continue;
      if (m[1] && a.querySelector('img')) return m[1];
    }
    for (const img of document.querySelectorAll('img[alt]')) {
      const alt = (img.getAttribute('alt') || '').trim();
      if (alt.startsWith('@') && alt.length <= 31) return alt.slice(1);
    }
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/([A-Za-z0-9_.]{1,30})\/?$/);
      if (!m || !m[1]) continue;
      const lc = href.toLowerCase();
      if (a.querySelector('img') && !['/explore', '/direct', '/reels', '/accounts'].includes(lc)) return m[1];
    }
    return null;
  });
}

async function profileCounts() {
  return await page.evaluate(() => {
    const el = document.querySelector('meta[property="og:description"]');
    const text = (el && el.content) || '';
    const num = (s) => Number(String(s).replace(/[^\d]/g, '')) || 0;
    const m = text.match(/([\d.,]+)\s*Followers?\s*,\s*([\d.,]+)\s*Following/i);
    if (m) return { followers: num(m[1]), following: num(m[2]) };
    return { followers: null, following: null };
  });
}

// ----- API -----
app.post('/api/open', requireAuth, async (req, res) => {
  try {
    await getBrowser();
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2', timeout: 90000 });
    await startScreencast().catch(() => {});
    emit('step', { message: 'Embedded browser open — log into Instagram in the panel.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.post('/api/logout', requireAuth, async (req, res) => {
  try {
    if (!browser || !browser.connected || !page) return res.json({ ok: true, loggedIn: false });
    await page.goto('https://www.instagram.com/accounts/logout/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(800);
    await page.evaluate(() => {
      try {
        (document.cookie.split(';') || []).forEach((c) => {
          const n = c.split('=')[0].trim();
          if (!n) return;
          for (const d of ['', '.instagram.com', 'instagram.com']) {
            document.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${d}`;
          }
        });
      } catch (_) {}
    });
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    emit('step', { message: 'Logged out of Instagram.' });
    res.json({ ok: true, loggedIn: false });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.get('/api/peek', requireAuth, async (req, res) => {
  try {
    if (!browser || !browser.connected) return res.json({ ok: true, connected: false });
    const info = await page.evaluate(() => {
      const navLinks = [];
      for (const a of document.querySelectorAll('nav a[href]')) navLinks.push({ href: a.getAttribute('href'), hasImg: !!a.querySelector('img') });
      const imgAlts = [];
      for (const img of document.querySelectorAll('img[alt]')) imgAlts.push(img.getAttribute('alt'));
      const loginBtn = Array.from(document.querySelectorAll('button')).some((b) => /log in/i.test(b.textContent || ''));
      return { url: location.href, title: document.title, navLinks: navLinks.slice(0, 40), imgAlts: imgAlts.slice(0, 25), loginBtn };
    });
    res.json({ ok: true, connected: true, ...info });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.post('/api/close', requireAuth, async (req, res) => {
  try {
    if (browser && browser.connected) await browser.close();
    browser = null; page = null; cdpSession = null; screencastClient = null;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.get('/api/status', requireAuth, async (req, res) => {
  let connected = !!(browser && browser.connected);
  let username = null;
  if (connected && page) username = await getUser(page).catch(() => null);
  res.json({ connected, loggedIn: !!username, username, busy });
});

app.get('/api/events', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const onEvent = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  broker.on('event', onEvent);
  req.on('close', () => broker.off('event', onEvent));
});

app.post('/api/analyze', requireAuth, async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Analysis already in progress.' });
  busy = true;
  try {
    if (!browser || !browser.connected) await getBrowser();
    await stopScreencast();
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2', timeout: 90000 });
    await sleep(2000);
    const username = await getUser(page).catch(() => null);
    if (!username) throw new Error('You do not appear to be logged in on Instagram. Press "Login Instagram", log in, then retry.');
    emit('step', { message: `Account detected: @${username}`, username });
    const result = await analyzeAccount(username);
    emit('done', { summary: result.summary, notFollowingBack: result.notFollowingBack });
    res.json({ ok: true, ...result });
  } catch (e) {
    emit('error', { message: String((e && e.message) || e) });
    res.status(500).json({ error: String((e && e.message) || e) });
  } finally {
    busy = false;
  }
});

async function analyzeAccount(username) {
  await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(CONFIG.pageLoadMs);
  const counts = await profileCounts().catch(() => ({ followers: null, following: null }));
  emit('step', { message: 'Opening the followers list...' });
  const followers = await collectFromDialog('followers', username, counts.followers);
  emit('step', { message: `Followers collected: ${followers.length}` });
  emit('step', { message: 'Opening the following list...' });
  const following = await collectFromDialog('following', username, counts.following);
  emit('step', { message: `Following collected: ${following.length}` });
  const followersSet = new Set(followers);
  const followingSet = new Set(following);
  const notFollowingBack = following.filter((u) => !followersSet.has(u));
  const summary = { followersCount: followers.length, followingCount: following.length, notFollowingBackCount: notFollowingBack.length };
  return { username, summary, notFollowingBack };
}

async function collectFromDialog(keyword, selfUser, total = null) {
  let found = false, dialogOpened = false, names = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    found = await page.evaluate((kw) => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      for (const a of links) {
        if ((a.textContent || '').toLowerCase().includes(kw)) { a.click(); return true; }
      }
      return false;
    }, keyword);
    if (!found) break;
    if (await waitForDialog(15000)) {
      dialogOpened = true;
      await sleep(CONFIG.dialogOpenMs);
      names = await scrollUntilStable(selfUser, keyword, total);
      break;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(700);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(500);
  if (!found) throw new Error(`Button "${keyword}" not found on the profile page.`);
  if (!dialogOpened) throw new Error(`Could not open the "${keyword}" dialog after several attempts.`);
  return names;
}

async function waitForDialog(timeout) {
  try {
    await page.waitForFunction(() => {
      const isU = (h) => /^\/([A-Za-z0-9_.]{1,30})\/?$/.test(h);
      for (const el of document.querySelectorAll('[role="dialog"],[role="presentation"]')) {
        let n = 0;
        for (const a of el.querySelectorAll('a[href]')) if (isU(a.getAttribute('href') || '')) n++;
        if (n > 0) return true;
      }
      return false;
    }, { timeout });
    return true;
  } catch { return false; }
}

async function scrollUntilStable(selfUser, phase = 'followers', total = null) {
  const all = new Set();
  let stableRounds = 0, iterations = 0, doneGrace = false, hardStop = false;
  while (iterations < CONFIG.maxIterations) {
    const names = await collectNames(selfUser);
    let added = 0;
    for (const n of names) if (!all.has(n)) { all.add(n); added++; }
    const cur = all.size;
    if (added > 0) {
      stableRounds = 0; doneGrace = false;
      emit('progress', { count: cur, phase, total });
    } else {
      stableRounds += 1;
      if (stableRounds >= CONFIG.stableRounds && !doneGrace) {
        doneGrace = true;
        await sleep(CONFIG.finalGraceMs);
      }
      if (stableRounds >= CONFIG.stableRounds && doneGrace && (await isScrollerBottom())) break;
      if (added === 0 && stableRounds >= 8) hardStop = true;
    }
    if (hardStop) break;
    await scrollDialogDown();
    iterations += 1;
    await sleep(CONFIG.scrollGapMs);
  }
  emit('progress', { count: all.size, phase, total });
  return Array.from(all);
}

async function scrollDialogDown() {
  await page.evaluate(() => {
    const isU = (h) => /^\/([A-Za-z0-9_.]{1,30})\/?$/.test(h);
    let best = null, bestN = 0;
    for (const el of document.querySelectorAll('[role="dialog"],[role="presentation"]')) {
      let n = 0;
      for (const a of el.querySelectorAll('a[href]')) if (isU(a.getAttribute('href') || '')) n++;
      if (n > bestN) { bestN = n; best = el; }
    }
    if (!best) return;
    let target = null, maxO = -1;
    for (const el of [best, ...best.querySelectorAll('*')]) {
      const o = el.scrollHeight - el.clientHeight;
      if (o > 30 && o > maxO) { target = el; maxO = o; }
    }
    (target || best).scrollTop = (target || best).scrollHeight;
  });
}

async function isScrollerBottom() {
  return await page.evaluate(() => {
    const isU = (h) => /^\/([A-Za-z0-9_.]{1,30})\/?$/.test(h);
    let best = null, bestN = 0;
    for (const el of document.querySelectorAll('[role="dialog"],[role="presentation"]')) {
      let n = 0;
      for (const a of el.querySelectorAll('a[href]')) if (isU(a.getAttribute('href') || '')) n++;
      if (n > bestN) { bestN = n; best = el; }
    }
    if (!best) return true;
    let target = null, maxO = -1;
    for (const el of [best, ...best.querySelectorAll('*')]) {
      const o = el.scrollHeight - el.clientHeight;
      if (o > 30 && o > maxO) { target = el; maxO = o; }
    }
    const sc = target || best;
    return sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 40;
  });
}

async function collectNames(selfUser) {
  return await page.evaluate((self) => {
    const isU = (h) => /^\/([A-Za-z0-9_.]{1,30})\/?$/.test(h);
    let best = null, bestN = 0;
    for (const el of document.querySelectorAll('[role="dialog"],[role="presentation"]')) {
      let n = 0;
      for (const a of el.querySelectorAll('a[href]')) if (isU(a.getAttribute('href') || '')) n++;
      if (n > bestN) { bestN = n; best = el; }
    }
    const names = new Set();
    if (best) {
      for (const a of best.querySelectorAll('a[href]')) {
        const h = a.getAttribute('href') || '';
        const m = h.match(/^\/([A-Za-z0-9_.]{1,30})\/?$/);
        if (m && m[1] && m[1] !== self) names.add(m[1]);
      }
    }
    return Array.from(names);
  }, selfUser);
}

// ----- WebSocket: screencast embed + relay input -----
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', async (ws, req) => {
  const q = new URL(req.url, 'http://localhost');
  const user = await verifyToken(q.searchParams.get('token') || '');
  if (!user) { ws.close(4001, 'Unauthorized'); return; }
  screencastClient = ws;
  ws.send(JSON.stringify({ t: 'hello', connected: !!(browser && browser.connected) }));
  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (m.t === 'start') await startScreencast().catch(() => {});
    else if (m.t === 'stop') await stopScreencast().catch(() => {});
    else if (m.t === 'input') await dispatchInput(m.e).catch(() => {});
  });
  ws.on('close', () => { if (screencastClient === ws) screencastClient = null; });
});

httpServer.on('error', (err) => console.error('HTTP server error:', err.message));
httpServer.listen(PORT, () => console.log(`InstaFollowCheck backend su porta ${PORT}`));

// Avvia subito (in background) l'eventuale download di Chrome: sul piano free
// Render non include la cache di build nell'immagine, quindi al boot va
// scaricato a runtime. Così quando l'utente apre il tool il browser è pronto.
ensureChrome()
  .then((exe) => console.log('Chrome pronto:', exe))
  .catch((err) => console.error('Chrome preload fallito (verrà ritentato su richiesta):', String((err && err.message) || err)));
