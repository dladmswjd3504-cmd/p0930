'use strict';
// 방 단위 실시간 이벤트: WebSocket 푸시 + 폴링 폴백(같은 이벤트 로그를 seq로 조회)
const { WebSocketServer } = require('ws');

const LOG_SIZE = 300;
const rooms = new Map(); // roomId -> { seq, log: [{seq, type, data, to}], sockets: Set }

function roomState(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, { seq: 0, log: [], sockets: new Set() });
  return rooms.get(roomId);
}

// to: 'all' | 'teacher' | 'student:<id>'
function publish(roomId, type, data = {}, to = 'all') {
  const st = roomState(roomId);
  const ev = { seq: ++st.seq, type, data, to, at: Date.now() };
  st.log.push(ev);
  if (st.log.length > LOG_SIZE) st.log.shift();
  const msg = JSON.stringify(ev);
  for (const ws of st.sockets) if (visible(ev, ws.meta) && ws.readyState === 1) ws.send(msg);
}

function visible(ev, meta) {
  if (ev.to === 'all') return true;
  if (ev.to === 'teacher') return meta.role === 'teacher';
  return ev.to === `student:${meta.studentId}`;
}

function eventsSince(roomId, since, meta) {
  const st = roomState(roomId);
  return { seq: st.seq, events: st.log.filter(e => e.seq > since && visible(e, meta)) };
}

function attach(server, authorize) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const meta = await authorize(url.searchParams, req).catch(() => null);
    if (!meta) { ws.close(4001, 'unauthorized'); return; }
    ws.meta = meta;
    const st = roomState(meta.roomId);
    st.sockets.add(ws);
    ws.send(JSON.stringify({ type: 'hello', seq: st.seq }));
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => st.sockets.delete(ws));
  });
  const iv = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 25000);
  iv.unref();
  wss.on('close', () => clearInterval(iv));
  return wss;
}

module.exports = { publish, eventsSince, attach };
