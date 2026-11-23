const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOM_PASS = process.env.ROOM_PASS || '12345';
const MAX_PLAYERS = 6;
const rooms = new Map(); // code -> { players: Map<ws, {uid,name}> }

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 4096 });

const send = (ws, data) => { if (ws.readyState === 1) ws.send(JSON.stringify(data)); };
const broadcast = (room, data, except) => {
  for (const ws of room.players.keys()) if (ws !== except) send(ws, data);
};
const newCode = () => {
  let c;
  do c = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(c));
  return c;
};

function leave(ws) {
  const code = ws.room;
  if (!code) return;
  ws.room = null;
  const room = rooms.get(code);
  if (!room) return;
  const p = room.players.get(ws);
  room.players.delete(ws);
  if (p) broadcast(room, { t: 'leave', uid: p.uid });
  if (room.players.size === 0) rooms.delete(code);
}

wss.on('connection', ws => {
  ws.room = null;
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'create' || m.t === 'join') {
      const uid = String(m.uid || '');
      if (!/^\d{10}$/.test(uid)) return send(ws, { t: 'err', msg: 'UID ต้องเป็นตัวเลข 10 หลัก' });
      if (m.pass !== ROOM_PASS) return send(ws, { t: 'err', msg: 'รหัสผ่านไม่ถูกต้อง' });

      leave(ws);
      const code = m.t === 'create' ? newCode() : String(m.room || '').toUpperCase().trim();
      if (m.t === 'create') rooms.set(code, { players: new Map() });
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'err', msg: 'ไม่พบห้องนี้' });
      if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'err', msg: 'ห้องเต็มแล้ว (สูงสุด 6 คน)' });
      if ([...room.players.values()].some(p => p.uid === uid))
        return send(ws, { t: 'err', msg: 'UID นี้อยู่ในห้องแล้ว' });

      const name = String(m.name || 'Hero').slice(0, 16);
      room.players.set(ws, { uid, name });
      ws.room = code;
      send(ws, {
        t: 'joined', room: code, uid,
        players: [...room.players.values()].map(p => ({ uid: p.uid, name: p.name }))
      });
      broadcast(room, { t: 'join', uid, name }, ws);
    }

    else if (m.t === 'st' && ws.room) {
      const room = rooms.get(ws.room);
      const p = room && room.players.get(ws);
      if (!p) return;
      broadcast(room, {
        t: 'st', uid: p.uid,
        x: +m.x || 0, y: +m.y || 0,
        d: m.d < 0 ? -1 : 1,
        hp: +m.hp || 0, mhp: +m.mhp || 0,
        pose: String(m.pose ?? '').slice(0, 12)
      }, ws);
    }

    else if (m.t === 'leave') leave(ws);
  });
  ws.on('close', () => leave(ws));
});

server.listen(PORT, () => console.log('Golden Destiny 2D listening on', PORT));
