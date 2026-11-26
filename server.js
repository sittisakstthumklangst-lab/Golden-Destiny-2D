const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOM_PASS = process.env.ROOM_PASS || '12345';
const MAX_PLAYERS = 6;
const UID_RE = /^\d{10}$/;
const CODE_RE = /^[0-9A-F]{4}$/;
const MAX_NAME = 16;

if (ROOM_PASS === '12345') console.warn('WARNING: using the default ROOM_PASS. Set the ROOM_PASS environment variable.');

const rooms = new Map(); // code -> { players: Map<ws, { uid, name }> }

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 4096 });

const num = (v, lim) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-lim, Math.min(lim, n)) : 0;
};

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcast(room, data, except) {
  for (const ws of room.players.keys()) {
    if (ws !== except) send(ws, data);
  }
}

function newCode() {
  let code;
  do {
    code = crypto.randomBytes(2).toString('hex').toUpperCase();
  } while (rooms.has(code));
  return code;
}

function leave(ws) {
  const code = ws.room;
  if (!code) return;
  const room = rooms.get(code);
  ws.room = null;
  if (!room) return;
  const p = room.players.get(ws);
  if (!p) return;
  room.players.delete(ws);
  broadcast(room, { t: 'leave', uid: p.uid });
  if (room.players.size === 0) rooms.delete(code);
}

function handleJoin(ws, m, isCreate) {
  const uid = String(m.uid || '');
  if (!UID_RE.test(uid)) return send(ws, { t: 'err', msg: 'UID ต้องเป็นตัวเลข 10 หลัก' });
  if (m.pass !== ROOM_PASS) return send(ws, { t: 'err', msg: 'รหัสผ่านไม่ถูกต้อง' });

  const name = String(m.name || '').trim().slice(0, MAX_NAME) || 'Hero';

  let code;
  if (isCreate) {
    code = newCode();
    rooms.set(code, { players: new Map() });
  } else {
    code = String(m.room || '').toUpperCase().trim();
    if (!CODE_RE.test(code)) return send(ws, { t: 'err', msg: 'ไม่พบห้องนี้' });
  }

  const room = rooms.get(code);
  if (!room) return send(ws, { t: 'err', msg: 'ไม่พบห้องนี้' });

  if (ws.room && ws.room !== code) leave(ws);

  // UID เดิมที่ค้างอยู่ในห้อง ให้ตัดการเชื่อมต่อเดิม
  for (const [oldWs, p] of room.players) {
    if (p.uid === uid && oldWs !== ws) {
      room.players.delete(oldWs);
      oldWs.room = null;
      send(oldWs, { t: 'err', msg: 'เข้าห้องจากอุปกรณ์หรือแท็บอื่นแล้ว' });
      oldWs.close();
      broadcast(room, { t: 'leave', uid }, ws);
      break;
    }
  }

  if (!room.players.has(ws) && room.players.size >= MAX_PLAYERS) {
    if (room.players.size === 0) rooms.delete(code);
    return send(ws, { t: 'err', msg: 'ห้องเต็มแล้ว (สูงสุด 6 คน)' });
  }

  room.players.set(ws, { uid, name });
  ws.room = code;

  send(ws, {
    t: 'joined',
    room: code,
    uid,
    players: [...room.players.values()].map(p => ({ uid: p.uid, name: p.name }))
  });
  broadcast(room, { t: 'join', uid, name }, ws);
}

wss.on('connection', ws => {
  ws.room = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {}); // ป้องกัน error ของ socket ทำให้ process ล่ม

  ws.on('message', raw => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return; // กัน null / ตัวเลข / สตริงที่ทำให้ m.t พัง

    if (m.t === 'create') return handleJoin(ws, m, true);
    if (m.t === 'join') return handleJoin(ws, m, false);
    if (m.t === 'ping') return send(ws, { t: 'pong' });
    if (m.t === 'leave') return leave(ws);

    if (m.t === 'st' && ws.room) {
      const room = rooms.get(ws.room);
      const p = room && room.players.get(ws);
      if (!p) return;
      const mhp = Math.max(0, num(m.mhp, 1e9));
      broadcast(room, {
        t: 'st',
        uid: p.uid,
        x: num(m.x, 1e6),
        y: num(m.y, 1e6),
        d: m.d < 0 ? -1 : 1,
        hp: Math.min(num(m.hp, 1e9), mhp),
        mhp,
        pose: String(m.pose ?? '').slice(0, 12)
      }, ws);
    }
  });

  ws.on('close', () => leave(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

server.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
