(() => {
  const $ = id => document.getElementById(id);
  const inputCss = 'width:260px;padding:8px 10px;background:#111;color:#fff;border:2px solid #ffd23c;font:14px monospace;user-select:text;-webkit-user-select:text';
  const btnCss = 'padding:10px 14px;margin:4px;background:#ffd23c;color:#111;border:0;font:bold 14px monospace;cursor:pointer';

  // ---------- Lobby overlay ----------
  const ov = document.createElement('div');
  ov.id = 'lobby';
  ov.style.cssText = 'position:fixed;inset:0;z-index:50;background:#05080f;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:16px;color:#fff;font:14px monospace;text-align:center';
  ov.innerHTML = `
    <div style="color:#ffd23c;font-size:20px;margin-bottom:6px">Golden Destiny 2D · Co-op</div>
    <input id="lu" inputmode="numeric" maxlength="10" placeholder="UID (10 หลัก)" style="${inputCss}">
    <input id="lp" type="password" maxlength="12" placeholder="รหัสผ่านห้อง" style="${inputCss}">
    <input id="ln" maxlength="16" placeholder="ชื่อตัวละคร" style="${inputCss}">
    <input id="lr" maxlength="4" placeholder="รหัสห้อง (สำหรับเข้าห้อง)" style="${inputCss}">
    <div>
      <button id="bc" style="${btnCss}">สร้างห้องใหม่</button>
      <button id="bj" style="${btnCss}">เข้าห้อง</button>
    </div>
    <div id="lm" style="color:#f88;min-height:18px"></div>
    <div id="lh" style="color:#9f9;line-height:1.6;word-break:break-all"></div>
    <button id="bs" style="${btnCss};display:none">เข้าเกม</button>`;
  document.body.appendChild(ov);

  // ป้องกันไม่ให้ตัวอักษรที่พิมพ์ในช่องไปถึงตัวควบคุมเกม
  ov.querySelectorAll('input').forEach(el => {
    el.addEventListener('keydown', e => e.stopPropagation());
    el.addEventListener('keyup', e => e.stopPropagation());
  });

  const qRoom = new URLSearchParams(location.search).get('room');
  if (qRoom) $('lr').value = qRoom.toUpperCase();

  // ---------- Room badge ----------
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;left:8px;top:8px;z-index:20;font:11px monospace;color:#fff;background:#0008;padding:4px 6px;border-radius:4px;display:none;pointer-events:none';
  document.body.appendChild(badge);

  // ---------- Network ----------
  let ws = null, info = null, myUid = null;
  let others = {}; // uid -> { name, x, dx, y, d, hp, mhp, pose, seen }
  const say = t => { $('lm').textContent = t; };

  function updateBadge() {
    badge.style.display = info ? 'block' : 'none';
    if (info) badge.textContent = `ห้อง ${info.room} · ${Object.keys(others).length + 1}/6`;
  }

  function connect(type) {
    const uid = $('lu').value.trim();
    const pass = $('lp').value;
    const name = $('ln').value.trim() || 'Hero';
    const room = $('lr').value.trim().toUpperCase();
    if (!/^\d{10}$/.test(uid)) return say('UID ต้องเป็นตัวเลข 10 หลัก');
    if (type === 'join' && !room) return say('ใส่รหัสห้องก่อน');

    say('กำลังเชื่อมต่อ...');
    if (ws) ws.close();
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onopen = () => ws.send(JSON.stringify({ t: type, uid, pass, name, room }));
    ws.onmessage = e => onMsg(JSON.parse(e.data));
    ws.onerror = () => say('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
    ws.onclose = () => {
      if (info) { say('หลุดจากห้อง'); $('bs').style.display = 'none'; }
      info = null; others = {}; updateBadge();
    };
  }

  function onMsg(m) {
    if (m.t === 'err') { say(m.msg); ws.close(); return; }

    if (m.t === 'joined') {
      info = { room: m.room };
      myUid = m.uid;
      others = {};
      m.players.filter(p => p.uid !== myUid).forEach(addOther);
      say('');
      $('lh').textContent = `ห้อง ${m.room} · ส่งลิงก์นี้ให้เพื่อน:\n${location.origin}/?room=${m.room}`;
      $('bs').style.display = 'inline-block';
      updateBadge();
    }
    else if (m.t === 'join') { addOther(m); updateBadge(); }
    else if (m.t === 'leave') { delete others[m.uid]; updateBadge(); }
    else if (m.t === 'st') {
      const o = others[m.uid] || addOther({ uid: m.uid, name: '?' });
      Object.assign(o, m, { seen: performance.now() });
      if (o.dx === undefined) o.dx = m.x;
    }
  }

  function addOther(p) {
    others[p.uid] = { name: p.name, x: 0, dx: undefined, y: 440, d: 1, hp: 0, mhp: 0, pose: '', seen: 0 };
    return others[p.uid];
  }

  $('bc').onclick = () => connect('create');
  $('bj').onclick = () => connect('join');
  $('bs').onclick = () => { ov.style.display = 'none'; };

  // ---------- Send own state 10 times/sec ----------
  setInterval(() => {
    if (!info || !ws || ws.readyState !== 1) return;
    if (typeof mode === 'undefined' || mode !== 'play' || typeof P === 'undefined' || !P) return;
    ws.send(JSON.stringify({
      t: 'st',
      x: Math.round(P.x), y: Math.round(P.y), d: P.dir,
      hp: Math.round(P.hp), mhp: Math.round(maxHP()),
      pose: String(P.pose ?? '')
    }));
  }, 100);

  // ---------- Draw teammates on top of the game ----------
  const _draw = draw;
  draw = function () {
    _draw();
    if (typeof mode === 'undefined' || mode !== 'play' || !P) return;
    const now = performance.now();
    for (const uid in others) {
      const o = others[uid];
      if (!o.seen || now - o.seen > 6000 || o.dx === undefined) continue;
      o.dx += (o.x - o.dx) * 0.25; // ทำให้การเคลื่อนที่นุ่มขึ้น
      const sx = Math.round(o.dx - cx);
      if (sx < -60 || sx > W + 60) continue;
      X.save();
      X.globalAlpha = 0.85;
      X.fillStyle = '#5bd1ff';
      X.fillRect(sx - 8, o.y - 40, 16, 32);
      X.fillStyle = '#f5cfa0';
      X.fillRect(sx - 6, o.y - 50, 12, 10);
      X.globalAlpha = 1;
      X.fillStyle = '#fff';
      X.font = '10px monospace';
      X.textAlign = 'center';
      X.fillText(`${o.name} ${o.hp}/${o.mhp}`, sx, o.y - 56);
      X.restore();
    }
  };
})();
