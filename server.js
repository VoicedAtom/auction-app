'use strict';
/*
 * JIDO Engineering Auction server.
 * No npm packages needed. Node 18 or newer.
 *   node server.js
 * Team page:      http://HOST:3000/
 * Organiser page: http://HOST:3000/organiser   (locked with ORGANISER_KEY)
 *
 * The server is the single source of truth: it checks every bid, runs the clock,
 * settles each slot and stores everything in data/state.json.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const PORT = +env('PORT', 3000);
const ORG_KEY = env('ORGANISER_KEY', 'JCkPwM');
const CFG = {
  budget: +env('BUDGET', 10000),     // starting JC per team
  inc: +env('MIN_INCREMENT', 2),     // minimum raise over your own last bid
  roundSec: +env('ROUND_SEC', 90),   // length of each slot
  gapSec: +env('GAP_SEC', 5),        // pause between slots
  snipeSec: +env('SNIPE_SEC', 10),   // a bid in the last N seconds adds N seconds
  maxExt: +env('MAX_EXTENSIONS', 3), // at most this many extensions per slot
  perSlot: +env('PER_SLOT', 6),      // components per slot
  halls: +env('HALLS', 5),           // number of halls
  cap: +env('HALL_CAPACITY', 10),    // teams per hall
};
const TRUST_PROXY = env('TRUST_PROXY', '0') === '1'; // set to 1 when hosted behind a proxy (Render, Caddy, nginx)
const DATA_DIR = env('DATA_DIR', path.join(__dirname, 'data'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ITEMS = JSON.parse(fs.readFileSync(path.join(__dirname, 'items.json'), 'utf8')); // [category,name,lotSize,lots,start]

const SHOP = [], AUC = [];
ITEMS.forEach((it, i) => (it[0] === 'Wiring & Basics' || it[4] <= 3 ? SHOP : AUC).push(i));
const SLOTS = [];
for (let q = 0; q < AUC.length; q += CFG.perSlot) SLOTS.push(AUC.slice(q, q + CFG.perSlot));

/* ---------- state ---------- */
const fresh = () => ({ slot: -1, open: false, endsAt: 0, auto: true, closedAt: 0, ext: 0, teams: {}, bids: {}, results: {}, buys: [] });
let S = fresh();
try { S = Object.assign(fresh(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) { /* first run */ }

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 400);
}
function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(S));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error('Could not save state:', e.message); }
}

/* ---------- helpers ---------- */
const slug = n => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const fail = (msg, code = 400) => { const e = new Error(msg); e.status = code; return e; };
const teamByToken = tok => Object.values(S.teams).find(t => t.token === tok);

function spent(name) {
  let s = 0;
  for (const r of Object.values(S.results)) for (const w of r.winners) if (w.team === name) s += w.amt;
  for (const b of S.buys) if (b.team === name) s += b.price;
  return s;
}
const ranked = (hall, idx) =>
  Object.values(S.bids).filter(b => b.hall === hall && b.idx === idx).sort((a, b) => b.amt - a.amt || a.t - b.t);
function committed(name, hall, except) {
  if (!S.open) return 0;
  let c = 0;
  for (const i of SLOTS[S.slot]) {
    if (i === except) continue;
    const rk = ranked(hall, i), k = rk.findIndex(b => b.team === name);
    if (k >= 0 && k < ITEMS[i][3]) c += rk[k].amt;
  }
  return c;
}
const finished = () => S.slot === SLOTS.length - 1 && !S.open && S.closedAt > 0;

/* ---------- auction actions ---------- */
function join(nameIn, token) {
  const name = String(nameIn || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  const key = slug(name);
  if (name.length < 2 || !key) throw fail('Enter a team name with at least 2 characters.');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.'\-]*$/u.test(name)) throw fail('Use only letters, numbers, spaces, dots, hyphens and apostrophes in the team name.');
  const ex = S.teams[key];
  if (ex) {
    if (token && ex.token === token) return { token: ex.token, hall: ex.hall, seat: ex.seat, again: true };
    return { taken: true };
  }
  for (let h = 1; h <= CFG.halls; h++) {
    const inHall = Object.values(S.teams).filter(t => t.hall === h);
    if (inHall.length >= CFG.cap) continue;
    const used = new Set(inHall.map(t => t.seat));
    let seat = 1; while (used.has(seat)) seat++;
    const t = { name, hall: h, seat, token: crypto.randomBytes(16).toString('hex'), t: Date.now() };
    S.teams[key] = t; save(); broadcast();
    return { token: t.token, hall: h, seat };
  }
  return { allFull: true };
}

function placeBid(team, idxIn, amtIn) {
  const idx = Number(idxIn), amt = Number(amtIn);
  if (!S.open || Date.now() > S.endsAt) throw fail('Bidding has closed.');
  if (!SLOTS[S.slot].includes(idx)) throw fail('That component is not open right now.');
  const it = ITEMS[idx];
  if (!Number.isInteger(amt) || amt < it[4]) throw fail(`Bid at least ${it[4]} JC, in whole numbers.`);
  const key = `${team.hall}_${idx}_${slug(team.name)}`, my = S.bids[key];
  if (my && amt < my.amt + CFG.inc) throw fail(`Raise by at least ${CFG.inc} JC (minimum ${my.amt + CFG.inc}).`);
  const free = CFG.budget - spent(team.name) - committed(team.name, team.hall, idx);
  if (amt > free) throw fail(`Not enough free balance. You have ${free} JC free after your other winning bids.`);
  const now = Date.now();
  S.bids[key] = { hall: team.hall, idx, team: team.name, amt, t: now };
  if (S.endsAt - now <= CFG.snipeSec * 1000 && S.ext < CFG.maxExt) { S.endsAt = now + CFG.snipeSec * 1000; S.ext++; }
  save(); broadcast();
}

function buy(team, itemIn) {
  const item = Number(itemIn);
  if (!SHOP.includes(item)) throw fail('That item is not in the shop.');
  const it = ITEMS[item];
  const sold = S.buys.filter(b => b.hall === team.hall && b.item === item);
  if (sold.length >= it[3]) throw fail('Sold out. Someone bought the last one.');
  const free = CFG.budget - spent(team.name) - committed(team.name, team.hall, -1);
  if (it[4] > free) throw fail('Not enough free balance.');
  const used = new Set(sold.map(b => b.k)); let k = 1; while (used.has(k)) k++;
  S.buys.push({ hall: team.hall, item, k, team: team.name, price: it[4] });
  save(); broadcast();
}

function openSlot(k) {
  S.slot = k; S.open = true; S.endsAt = Date.now() + CFG.roundSec * 1000; S.closedAt = 0; S.ext = 0;
  save(); broadcast();
}
function closeSlot() {
  const items = SLOTS[S.slot], end = S.endsAt, rem = {}, W = {};
  const halls = [...new Set(Object.values(S.teams).map(t => t.hall))];
  halls.forEach(h => items.forEach(i => { W[`${h}_${i}`] = []; }));
  Object.values(S.bids)
    .filter(b => items.includes(b.idx) && W[`${b.hall}_${b.idx}`] && b.amt >= ITEMS[b.idx][4] && b.t <= end)
    .sort((a, b) => b.amt - a.amt || a.t - b.t)
    .forEach(b => {
      const k = `${b.hall}_${b.idx}`;
      if (rem[b.team] === undefined) rem[b.team] = CFG.budget - spent(b.team);
      if (W[k].length < ITEMS[b.idx][3] && b.amt <= rem[b.team]) { W[k].push({ team: b.team, amt: b.amt }); rem[b.team] -= b.amt; }
    });
  for (const k of Object.keys(W)) { const [h, i] = k.split('_').map(Number); S.results[k] = { hall: h, idx: i, winners: W[k] }; }
  S.open = false; S.endsAt = 0; S.closedAt = Date.now(); S.ext = 0;
  save(); broadcast();
}
function resetAll() { S = fresh(); saveNow(); broadcast(); }

/* clock: closes and opens slots by itself */
setInterval(() => {
  const now = Date.now();
  if (S.slot < 0 || S.auto === false) return;
  if (S.open && now >= S.endsAt) closeSlot();
  else if (!S.open && S.closedAt > 0 && S.slot + 1 < SLOTS.length && now >= S.closedAt + CFG.gapSec * 1000) openSlot(S.slot + 1);
}, 250);

/* ---------- snapshots and live streams ---------- */
const pubState = () => ({ slot: S.slot, open: S.open, endsAt: S.endsAt, auto: S.auto, closedAt: S.closedAt });
function teamSnap(t) {
  const h = t.hall;
  const results = {};
  for (const [k, v] of Object.entries(S.results)) if (v.hall === h) results[k] = v;
  return {
    now: Date.now(), state: pubState(),
    teams: Object.values(S.teams).filter(x => x.hall === h).map(x => ({ name: x.name, hall: x.hall })),
    bids: Object.values(S.bids).filter(b => b.hall === h),
    results, buys: S.buys.filter(b => b.hall === h),
  };
}
function orgSnap() {
  return {
    now: Date.now(), state: Object.assign(pubState(), { ext: S.ext }),
    teams: Object.values(S.teams).map(x => ({ name: x.name, hall: x.hall, seat: x.seat })),
    bids: Object.values(S.bids), results: S.results, buys: S.buys,
  };
}
const clients = new Set();
let pending = false;
function broadcast() {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    for (const c of clients) {
      try {
        const data = c.kind === 'org' ? orgSnap() : (() => { const t = teamByToken(c.token); return t ? teamSnap(t) : null; })();
        if (data) c.res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (e) { clients.delete(c); }
    }
  }, 60);
}
setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch (e) { clients.delete(c); } } }, 20000);

function openStream(req, res, kind, token) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const c = { res, kind, token };
  clients.add(c);
  req.on('close', () => clients.delete(c));
  const data = kind === 'org' ? orgSnap() : teamSnap(teamByToken(token));
  res.write(`retry: 2000\n\ndata: ${JSON.stringify(data)}\n\n`);
}

/* ---------- organiser key (with attempt limit) ---------- */
const attempts = new Map();
function clientIp(req) {
  if (TRUST_PROXY) { const f = req.headers['x-forwarded-for']; if (f) return String(f).split(',')[0].trim(); }
  return req.socket.remoteAddress || 'x';
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function orgAuth(req, url) {
  const ip = clientIp(req), a = attempts.get(ip) || { n: 0, until: 0 };
  if (Date.now() < a.until) throw fail('Too many wrong keys. Try again in a little while.', 429);
  const key = req.headers['x-organiser-key'] || url.searchParams.get('key') || '';
  if (crypto.timingSafeEqual(sha(key), sha(ORG_KEY))) { attempts.delete(ip); return; }
  a.n++; if (a.n >= 5) { a.n = 0; a.until = Date.now() + 30000; }
  attempts.set(ip, a);
  throw fail('Wrong key.', 401);
}

/* ---------- http ---------- */
function body(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 10000) { reject(fail('Request too large.', 413)); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(fail('Bad request.')); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const PAGES = { '/': 'index.html', '/organiser': 'organiser.html' };

function csv() {
  const q = v => '"' + String(v).replace(/"/g, '""') + '"';
  const rows = Object.values(S.teams).sort((a, b) => a.hall - b.hall || a.seat - b.seat).map(t => {
    const own = [];
    for (const r of Object.values(S.results)) for (const w of r.winners) if (w.team === t.name) own.push(`${ITEMS[r.idx][1]} (${w.amt} JC)`);
    for (const b of S.buys) if (b.team === t.name) own.push(`${ITEMS[b.item][1]} (shop, ${b.price} JC)`);
    const sp = spent(t.name);
    return [q(t.name), t.hall, sp, CFG.budget - sp, q(own.join('; '))].join(',');
  });
  return ['team,hall,spent_jc,balance_jc,components'].concat(rows).join('\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true, slot: S.slot, teams: Object.keys(S.teams).length });
    if (req.method === 'GET' && PAGES[p]) {
      const f = path.join(__dirname, 'public', PAGES[p]);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/config')
      return send(res, 200, { items: ITEMS, shop: SHOP, slots: SLOTS, budget: CFG.budget, inc: CFG.inc, snipeSec: CFG.snipeSec, halls: CFG.halls, cap: CFG.cap });

    /* team api */
    if (req.method === 'POST' && p === '/api/join') { const b = await body(req); return send(res, 200, join(b.name, b.token)); }
    if (req.method === 'GET' && p === '/api/events') {
      if (!teamByToken(url.searchParams.get('token'))) throw fail('Unknown team. Join again.', 401);
      return openStream(req, res, 'team', url.searchParams.get('token'));
    }
    if (req.method === 'POST' && (p === '/api/bid' || p === '/api/buy')) {
      const b = await body(req), t = teamByToken(b.token);
      if (!t) throw fail('Unknown team. Join again.', 401);
      if (p === '/api/bid') placeBid(t, b.idx, b.amt); else buy(t, b.item);
      return send(res, 200, { ok: true });
    }

    /* organiser api */
    if (p.startsWith('/api/org/')) {
      orgAuth(req, url);
      if (req.method === 'GET' && p === '/api/org/ping') return send(res, 200, { ok: true });
      if (req.method === 'GET' && p === '/api/org/events') return openStream(req, res, 'org');
      if (req.method === 'GET' && p === '/api/org/export.csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="jido-results.csv"' });
        return res.end(csv());
      }
      if (req.method === 'POST') {
        const b = await body(req);
        if (p === '/api/org/start') { if (S.slot >= 0) throw fail('Already started.'); openSlot(0); }
        else if (p === '/api/org/close') { if (!S.open) throw fail('No slot is open.'); closeSlot(); }
        else if (p === '/api/org/next') { if (S.open || S.slot < 0 || S.slot + 1 >= SLOTS.length) throw fail('Cannot open the next slot now.'); openSlot(S.slot + 1); }
        else if (p === '/api/org/auto') { S.auto = !!b.on; save(); broadcast(); }
        else if (p === '/api/org/reset') resetAll();
        else throw fail('Not found.', 404);
        return send(res, 200, { ok: true });
      }
    }
    throw fail('Not found.', 404);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
    if (!e.status) console.error(e);
  }
});

server.listen(PORT, () => {
  console.log(`JIDO auction server on port ${PORT}`);
  console.log(`  Teams:     http://localhost:${PORT}/`);
  console.log(`  Organiser: http://localhost:${PORT}/organiser`);
  console.log(`  ${SLOTS.length} slots, ${SHOP.length} shop items, ${CFG.halls} halls x ${CFG.cap} teams, budget ${CFG.budget} JC`);
  if (ORG_KEY === 'JCkPwM') console.log('  WARNING: using the default organiser key. Set ORGANISER_KEY before a real event.');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveNow(); process.exit(0); });

process.on('uncaughtException', e => console.error('Unexpected error:', e));
process.on('unhandledRejection', e => console.error('Unexpected rejection:', e));
