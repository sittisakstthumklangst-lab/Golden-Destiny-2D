// Golden Destiny - accounts + cloud saves (Phase 1). Node 18+, uses express (npm i express).
// Run: ACCOUNTS_DIR=./data PORT=8787 node auth-server.js
'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8787;
const DIR = process.env.ACCOUNTS_DIR || path.join(__dirname, 'data');
const SESSION_DAYS = 30;
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
const USER_RE = /^[A-Za-z0-9_]{3,16}$/;
const MAX_SAVE_BYTES = 512 * 1024;
fs.mkdirSync(path.join(DIR, 'saves'), { recursive: true });

// ---------- tiny atomic JSON store ----------
const fileOf = n => path.join(DIR, n + '.json');
function load(n, def) { try { return JSON.parse(fs.readFileSync(fileOf(n), 'utf8')); } catch { return def; } }
function store(n, obj) { const t = fileOf(n) + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, fileOf(n)); }
let users = load('users', {});      // key: lowercase username -> { id, username, salt, hash, rhash, created }
let sessions = load('sessions', {}); // token -> { uid, exp }

// ---------- password hashing (scrypt, built in) ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
function checkPw(pw, u) {
  const h = Buffer.from(hashPw(pw, u.salt), 'hex'), want = Buffer.from(u.hash, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
const rand = (n = 32) => crypto.randomBytes(n).toString('hex');

// ---------- brute-force protection (per username and per IP) ----------
const fails = new Map(); // key -> { n, until }
function locked(key) { const f = fails.get(key); return f && f.until > Date.now(); }
function failed(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n++; if (f.n >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.n = 0; }
  fails.set(key, f);
}

// ---------- save validation (same plausibility rules as before) ----------
function validSave(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not an object';
  if (!Number.isInteger(s.lv) || s.lv < 1 || s.lv > 450) return 'bad level';
  if (typeof s.money !== 'number' || !Number.isFinite(s.money) || s.money < 0 || s.money > 1e12) return 'bad money';
  if (s.aw && typeof s.aw === 'object') for (const k of Object.keys(s.aw)) {
    const a = s.aw[k]; if (!a || !Number.isInteger(a.s) || a.s < 0 || a.s > 7) return 'bad awakening stage';
  }
  for (const arr of [s.acc, s.accEq, s.fInv, s.wps]) {
    if (arr !== undefined && (!Array.isArray(arr) || arr.length > 500 || arr.some(x => x !== null && typeof x !== 'string'))) return 'bad list';
  }
  return null;
}

// ---------- auth helpers ----------
function sessionUser(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const s = sessions[tok];
  if (!s || s.exp < Date.now()) return null;
  return s.uid;
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
app.use(express.json({ limit: MAX_SAVE_BYTES }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.post('/api/register', (req, res) => {
  const username = String(req.body.username || ''), password = String(req.body.password || '');
  if (!USER_RE.test(username)) return res.status(400).json({ error: 'ชื่อผู้ใช้ 3-16 ตัว (a-z, 0-9, _)' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'รหัสผ่านอย่างน้อย 8 ตัว' });
  const key = username.toLowerCase();
  if (users[key]) return res.status(409).json({ error: 'ชื่อนี้ถูกใช้แล้ว' });
  const salt = rand(16), recovery = rand(10);
  const id = rand(12);
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

// sessions expire
setInterval(() => {
  let changed = false;
  for (const t of Object.keys(sessions)) if (sessions[t].exp < Date.now()) { delete sessions[t]; changed = true; }
  if (changed) store('sessions', sessions);
}, 3600e3).unref();

if (require.main === module) app.listen(PORT, () => console.log('Auth server on port ' + PORT));
module.exports = { app, validSave, hashPw };
