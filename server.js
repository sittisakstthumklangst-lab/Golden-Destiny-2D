// Golden Destiny - ONE server for: accounts + cloud saves + multiplayer rooms (WebSocket) + the game page.
// Drop-in replacement for auth/server.js.  Needs: npm install express ws   (Node 18+)
// Run:  ACCOUNTS_DIR=./data PORT=8787 node server.js
'use strict';
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const DIR_WANTED = process.env.ACCOUNTS_DIR || path.join(__dirname, 'data');
const SESSION_DAYS = 30;
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
const USER_RE = /^[A-Za-z0-9_]{3,16}$/;
const MAX_SAVE_BYTES = 512 * 1024;
const MAX_LEVEL = 850;
let DIR = DIR_WANTED, TEMP_STORAGE = false;
try { fs.mkdirSync(path.join(DIR, 'saves'), { recursive: true }); }
catch (e) { // e.g. Render without a Disk: keep the service alive, but warn loudly (data is lost on restart)
  DIR = path.join(require('os').tmpdir(), 'gd-data'); TEMP_STORAGE = true;
  fs.mkdirSync(path.join(DIR, 'saves'), { recursive: true });
  console.warn('WARNING: cannot write to ' + DIR_WANTED + ' (' + e.code + '). Using TEMPORARY storage ' + DIR + ' - accounts and saves will be LOST on restart. Add a Render Disk and set ACCOUNTS_DIR to its mount path.');
}

/* ====================== accounts + cloud saves ====================== */
const fileOf = n => path.join(DIR, n + '.json');
function load(n, def) { try { return JSON.parse(fs.readFileSync(fileOf(n), 'utf8')); } catch { return def; } }
function store(n, obj) { const t = fileOf(n) + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, fileOf(n)); }
let users = load('users', {});
let sessions = load('sessions', {});

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
function checkPw(pw, u) {
  const h = Buffer.from(hashPw(pw, u.salt), 'hex'), want = Buffer.from(u.hash, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
const rand = (n = 32) => crypto.randomBytes(n).toString('hex');

const fails = new Map();
const locked = key => { const f = fails.get(key); return f && f.until > Date.now(); };
function failed(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n++; if (f.n >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.n = 0; }
  fails.set(key, f);
}

function validSave(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not an object';
  if (!Number.isInteger(s.lv) || s.lv < 1 || s.lv > MAX_LEVEL) return 'bad level';
  if (typeof s.money !== 'number' || !Number.isFinite(s.money) || s.money < 0 || s.money > 1e12) return 'bad money';
  if (s.aw && typeof s.aw === 'object') for (const k of Object.keys(s.aw)) {
    const a = s.aw[k]; if (!a || !Number.isInteger(a.s) || a.s < 0 || a.s > 7) return 'bad awakening stage';
  }
  for (const arr of [s.acc, s.accEq, s.fInv, s.wps]) {
    if (arr !== undefined && (!Array.isArray(arr) || arr.length > 500 || arr.some(x => x !== null && typeof x !== 'string'))) return 'bad list';
  }
  return null;
}

function sessionUser(req) {
  const h = req.headers.authorization || '';
  return tokenUser(h.startsWith('Bearer ') ? h.slice(7) : '');
}
function tokenUser(tok) {
  const s = typeof tok === 'string' ? sessions[tok] : null;
  return s && s.exp > Date.now() ? s.uid : null;
}
function newSession(uid) {
  const tok = rand(32);
  sessions[tok] = { uid, exp: Date.now() + SESSION_DAYS * 864e5 };
  store('sessions', sessions);
  return tok;
}
const userByUid = uid => Object.values(users).find(u => u.id === uid);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind a proxy: req.ip = real client
app.use(express.json({ limit: MAX_SAVE_BYTES }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/health', (req, res) => res.send(TEMP_STORAGE ? 'ok - WARNING: temporary storage, accounts will be lost on restart' : 'ok'));

app.post('/api/register', (req, res) => {
  const username = String(req.body.username || ''), password = String(req.body.password || '');
  if (!USER_RE.test(username)) return res.status(400).json({ error: 'ชื่อผู้ใช้ 3-16 ตัว (a-z, 0-9, _)' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'รหัสผ่านอย่างน้อย 8 ตัว' });
  const key = username.toLowerCase();
  if (users[key]) return res.status(409).json({ error: 'ชื่อนี้ถูกใช้แล้ว' });
  const salt = rand(16), recovery = rand(10), id = rand(12);
  users[key] = { id, username, salt, hash: hashPw(password, salt), rhash: hashPw(recovery, salt), created: Date.now() };
  store('users', users);
  res.json({ token: newSession(id), recoveryCode: recovery, note: 'เก็บรหัสกู้คืนนี้ไว้ จะแสดงเพียงครั้งเดียว' });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').toLowerCase(), password = String(req.body.password || '');
  const ipKey = 'ip:' + req.ip, userKey = 'user:' + username;
  if (locked(ipKey) || locked(userKey)) return res.status(429).json({ error: 'ลองหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่' });
  const u = users[username];
  if (!u || !checkPw(password, u)) {
    failed(ipKey); failed(userKey);
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  fails.delete(userKey);
  res.json({ token: newSession(u.id), username: u.username });
});

app.post('/api/logout', (req, res) => {
  const tok = (req.headers.authorization || '').slice(7);
  if (sessions[tok]) { delete sessions[tok]; store('sessions', sessions); }
  res.json({ ok: true });
});

app.post('/api/recover', (req, res) => {
  const username = String(req.body.username || '').toLowerCase(), code = String(req.body.recoveryCode || '');
  const newPw = String(req.body.newPassword || '');
  const key = 'recover:' + req.ip;
  if (locked(key)) return res.status(429).json({ error: 'ลองหลายครั้งเกินไป' });
  const u = users[username];
  if (!u || newPw.length < 8 || !checkPw(code, { salt: u.salt, hash: u.rhash })) {
    failed(key); return res.status(401).json({ error: 'ข้อมูลกู้คืนไม่ถูกต้อง' });
  }
  const salt = rand(16), recovery = rand(10);
  u.salt = salt; u.hash = hashPw(newPw, salt); u.rhash = hashPw(recovery, salt);
  for (const t of Object.keys(sessions)) if (sessions[t].uid === u.id) delete sessions[t];
  store('users', users); store('sessions', sessions);
  res.json({ ok: true, recoveryCode: recovery, note: 'รหัสกู้คืนใหม่ เก็บไว้ให้ดี' });
});

app.get('/api/me', (req, res) => {
  const uid = sessionUser(req); if (!uid) return res.status(401).json({ error: 'ยังไม่ได้เข้าสู่ระบบ' });
  res.json({ username: userByUid(uid).username });
});

app.get('/api/save', (req, res) => {
  const uid = sessionUser(req); if (!uid) return res.status(401).json({ error: 'ต้องเข้าสู่ระบบ' });
  const f = path.join(DIR, 'saves', uid + '.json');
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'no save' });
  res.json(JSON.parse(fs.readFileSync(f, 'utf8')));
});

app.put('/api/save', (req, res) => {
  const uid = sessionUser(req); if (!uid) return res.status(401).json({ error: 'ต้องเข้าสู่ระบบ' });
  const data = req.body && req.body.data;
  const err = validSave(data); if (err) return res.status(400).json({ error: 'invalid save: ' + err });
  const rec = { updated: Date.now(), v: 1, data };
  const f = path.join(DIR, 'saves', uid + '.json'), t = f + '.tmp';
  fs.writeFileSync(t, JSON.stringify(rec)); fs.renameSync(t, f);
  res.json({ ok: true, updated: rec.updated });
});

setInterval(() => {
  let changed = false;
  for (const t of Object.keys(sessions)) if (sessions[t].exp < Date.now()) { delete sessions[t]; changed = true; }
  if (changed) store('sessions', sessions);
  const now = Date.now(); for (const [k, f] of fails) if (f.until && f.until < now) fails.delete(k);
}, 3600e3).unref();

/* ====================== serve the game page (optional) ====================== */
// Put the game file at  public/index.html  (next to this file or one folder up) and open the Render URL.
for (const d of [path.join(__dirname, 'public'), path.join(__dirname, '..', 'public')]) {
  if (fs.existsSync(d)) { app.use(express.static(d)); console.log('Serving game files from', d); break; }
}

/* ====================== multiplayer rooms (WebSocket /ws) ====================== */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
const RID_RE = /^[a-f0-9]{16}$/;
const MAX_PLAYERS = 6, MAX_ROOMS = 500, EMPTY_GRACE_MS = 120000;
const rooms = new Map(); // code -> { players: Map<ws, {pid,key,name,isl,lv,look}>, killTimer }

const clampN = (v, lim) => { const n = Number(v); return Number.isFinite(n) ? Math.max(-lim, Math.min(lim, n)) : 0; };
const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const send = (ws, d) => { if (ws.readyState === 1) ws.send(JSON.stringify(d)); };
const broadcast = (room, d, except) => { for (const w of room.players.keys()) if (w !== except) send(w, d); };
function newCode() {
  let c;
  do { c = ''; for (const b of crypto.randomBytes(5)) c += ALPHA[b % ALPHA.length]; } while (rooms.has(c));
  return c;
}
function pub(p) { return { pid: p.pid, name: p.name, isl: p.isl, lv: p.lv, look: p.look }; }

function leave(ws) {
  const code = ws.room; if (!code) return;
  ws.room = null;
  const room = rooms.get(code); if (!room) return;
  const p = room.players.get(ws); if (!p) return;
  room.players.delete(ws);
  broadcast(room, { t: 'leave', pid: p.pid, name: p.name });
  if (room.players.size === 0) { // keep an empty room briefly so a dropped connection can come back
    room.killTimer = setTimeout(() => { if (room.players.size === 0) rooms.delete(code); }, EMPTY_GRACE_MS);
    room.killTimer.unref();
  }
}

function handleJoin(ws, m, isCreate) {
  const name = cleanText(m.name, 16) || 'Hero';
  const rid = typeof m.rid === 'string' && RID_RE.test(m.rid) ? m.rid : null;
  const acct = tokenUser(m.token);
  const key = acct ? 'a:' + acct : rid ? 'g:' + rid : null;
  let look = {};
  try { if (m.look && typeof m.look === 'object' && JSON.stringify(m.look).length <= 1500) look = m.look; } catch {}

  let code;
  if (isCreate) {
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'err', msg: 'Server is busy, try again later' });
    code = newCode(); rooms.set(code, { players: new Map(), killTimer: null });
  } else {
    code = cleanText(m.room, 5).toUpperCase();
    if (!CODE_RE.test(code)) return send(ws, { t: 'err', msg: 'Room not found' });
  }
  const room = rooms.get(code);
  if (!room) return send(ws, { t: 'err', msg: 'Room not found' });

  if (ws.room && ws.room !== code) leave(ws);
  if (room.killTimer) { clearTimeout(room.killTimer); room.killTimer = null; }

  if (key) for (const [old, p] of room.players) { // same account / same device reconnecting: replace the old connection
    if (p.key === key && old !== ws) {
      room.players.delete(old); old.room = null;
      send(old, { t: 'err', msg: 'Joined from another tab or device' });
      old.close();
      broadcast(room, { t: 'leave', pid: p.pid, name: p.name }, ws);
      break;
    }
  }
  if (!room.players.has(ws) && room.players.size >= MAX_PLAYERS) return send(ws, { t: 'err', msg: 'Room is full (max ' + MAX_PLAYERS + ')' });

  const me = { pid: ws.pid, key, name, isl: 0, lv: 1, look };
  room.players.set(ws, me); ws.room = code;
  send(ws, { t: 'joined', room: code, you: ws.pid, players: [...room.players.values()].map(pub) });
  broadcast(room, { t: 'join', player: pub(me) }, ws);
}

wss.on('connection', ws => {
  ws.room = null; ws.isAlive = true; ws.pid = rand(4);
  ws.chatT = []; ws.stWin = 0; ws.stN = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'create': return handleJoin(ws, m, true);
      case 'join': return handleJoin(ws, m, false);
      case 'leave': return leave(ws);
      case 'ping': return send(ws, { t: 'pong' });
      case 'chat': {
        const room = ws.room && rooms.get(ws.room), p = room && room.players.get(ws);
        if (!p) return;
        const text = cleanText(m.text, 120); if (!text) return;
        const now = Date.now(); ws.chatT = ws.chatT.filter(t => now - t < 6000);
        if (ws.chatT.length >= 5) return send(ws, { t: 'err', msg: 'Slow down!' });
        ws.chatT.push(now);
        return broadcast(room, { t: 'chat', pid: p.pid, name: p.name, text });
      }
      case 'st': {
        const room = ws.room && rooms.get(ws.room), p = room && room.players.get(ws);
        if (!p) return;
        const now = Date.now(); if (now - ws.stWin > 1000) { ws.stWin = now; ws.stN = 0; }
        if (++ws.stN > 20) return; // max 20 updates / second
        p.isl = Math.max(0, Math.min(40, m.isl | 0)); p.lv = Math.max(0, Math.min(MAX_LEVEL, m.lv | 0));
        const mhp = Math.max(0, clampN(m.mhp, 1e9));
        return broadcast(room, {
          t: 'st', pid: p.pid, x: clampN(m.x, 1e5), y: clampN(m.y, 1e5), d: m.d < 0 ? -1 : 1,
          hp: Math.min(clampN(m.hp, 1e9), mhp), mhp, pose: cleanText(m.pose, 12), isl: p.isl, lv: p.lv, fly: m.fly ? 1 : 0,
        }, ws);
      }
    }
  });
  ws.on('close', () => leave(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 15000);
heartbeat.unref();

if (require.main === module) server.listen(PORT, () => console.log('Golden Destiny server on port ' + PORT));
module.exports = { app, server, validSave };
