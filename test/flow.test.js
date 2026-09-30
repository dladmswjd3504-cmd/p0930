'use strict';
// 수업 1회 전체 흐름 검증: 교사 로그인 → 방 생성 → 학생 입장 → 암기 → 게임 3종 → 랭킹 → 리포트·내보내기
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voca800-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.DATA_DIR = tmp;
const http = require('http');
const { app, authorizeSocket } = require('../server/app');
const rt = require('../server/realtime');
const Scoring = require('../public/shared/scoring');
const db = require('../server/db');
// 실제로 플레이한 것처럼 게임 시작 시각을 과거로 돌린다(응답 시간 불일치 탐지 회피)
const backdate = id => db.run('UPDATE game_sessions SET started_at = started_at - 600000 WHERE id = ?', id);

let base, server, cookie = '';

async function call(p, { method = 'GET', body, token, raw } = {}) {
  const headers = { cookie };
  if (body) headers['content-type'] = 'application/json';
  if (token) headers['x-student-token'] = token;
  const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = res.headers.get('set-cookie');
  if (sc && sc.startsWith('tsess=')) cookie = sc.split(';')[0];
  if (raw) return res;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

test.before(async () => {
  server = http.createServer(app);
  rt.attach(server, authorizeSocket);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.closeAllConnections(); server.close(); });

test('scoring rules', () => {
  // 3연속 ×1.2, 5연속 ×1.5, 남은 초 ×10
  const a = Array.from({ length: 5 }, (_, i) => ({ q: i, ok: true, ms: 2000 }));
  const s = Scoring.score('quiz', a);
  assert.equal(s.score, 150 + 150 + 180 + 180 + 225);
  assert.equal(s.maxCombo, 5);
  assert.equal(Scoring.score('quiz', [{ q: 0, ok: false, ms: 0 }, { q: 1, ok: true, ms: 6500 }]).score, 100);
  assert.ok(Scoring.maxScore('quiz') > 0);
});

let room, stu, stu2;

test('teacher magic-link login and room creation', async () => {
  assert.equal((await call('/api/rooms')).status, 401);
  const m = await call('/api/auth/magic', { method: 'POST', body: { email: 'teacher@school.kr' } });
  assert.equal(m.status, 200);
  const v = await call(new URL(m.data.devLink).pathname + new URL(m.data.devLink).search, { raw: true });
  assert.equal(v.status, 302);
  assert.ok(cookie.startsWith('tsess='));
  const r = await call('/api/rooms', { method: 'POST', body: { name: '2학년 3반', mode: 'class', stage_lock: { stage: '2-2', setFrom: 1, setTo: 1 }, allowed_games: ['quiz', 'match', 'flip'], pass_rate: 80, capacity: 3, roster_size: 5 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  room = r.data.room;
  assert.match(room.pin, /^\d{6}$/);
  assert.ok(r.data.link.endsWith('?pin=' + room.pin));
  const d = await call(`/api/rooms/${room.id}`);
  assert.ok(d.data.qr.startsWith('data:image/png;base64,'));
});

test('student join rules', async () => {
  assert.equal((await call('/api/join/000001')).data.code, 'NO_PIN');
  const bad = await call(`/api/rooms/${room.pin}/join`, { method: 'POST', body: { seat_no: 1, nickname: '씨발놈' } });
  assert.equal(bad.data.code, 'BAD_NICK');
  const j = await call(`/api/rooms/${room.pin}/join`, { method: 'POST', body: { seat_no: 1, nickname: '영어천재' } });
  assert.equal(j.status, 201);
  stu = j.data;
  const dup = await call(`/api/rooms/${room.pin}/join`, { method: 'POST', body: { seat_no: 2, nickname: '영어천재' } });
  assert.equal(dup.data.code, 'DUP_NICK');
  assert.equal(dup.data.suggestion, '영어천재2');
  const j2 = await call(`/api/rooms/${room.pin}/join`, { method: 'POST', body: { seat_no: 2, nickname: '영어천재2' } });
  stu2 = j2.data;
  // 같은 번호·같은 기기 재입장 → 기존 기록 이어붙임
  const re = await call(`/api/rooms/${room.pin}/join`, { method: 'POST', body: { seat_no: 1, nickname: '다른이름', device_token: stu.token } });
  assert.equal(re.data.resumed, true);
  assert.equal(re.data.student.id, stu.student.id);
  assert.equal(re.data.token, stu.token);
  await call(`/api/rooms/${room.pin}/join`, { method: 'POST', body: { seat_no: 3, nickname: '셋째' } });
  const full = await call(`/api/rooms/${room.pin}/join`, { method: 'POST', body: { seat_no: 4, nickname: '넷째' } });
  assert.equal(full.data.code, 'FULL');
  await call(`/api/rooms/${room.id}`, { method: 'PATCH', body: { locked: true } });
  const locked = await call(`/api/rooms/${room.pin}/join`, { method: 'POST', body: { seat_no: 5, nickname: '다섯' } });
  assert.equal(locked.data.code, 'LOCKED');
  await call(`/api/rooms/${room.id}`, { method: 'PATCH', body: { locked: false, capacity: 40 } });
});

test('stage data and study session', async () => {
  const set = await call('/api/stages/2-2/sets/1');
  assert.equal(set.data.words.length, 20);
  assert.equal(set.data.words[0].stage, '2-2');
  const me = await call('/api/student/me', { token: stu.token });
  assert.deepEqual(me.data.room.stage_lock, { stage: '2-2', setFrom: 1, setTo: 1 });
  const s = await call('/api/study-sessions', { method: 'POST', token: stu.token, body: { cards_seen: 20, known_count: 15, duration_sec: 400 } });
  assert.equal(s.data.completed, true);
});

function decode(q, nonce) { return (parseInt(q.k, 36) - q.i * 31 - nonce) / 7919 - 1; }

test('speed quiz: server recomputes score, ranking, wrong words', async () => {
  const g = await call('/api/games', { method: 'POST', token: stu.token, body: { game_type: 'quiz' } });
  assert.equal(g.status, 201, JSON.stringify(g.data));
  assert.equal(g.data.payload.length, 20);
  const q0 = g.data.payload[0];
  assert.equal(q0.options.length, 4);
  assert.equal(new Set(q0.options.map(o => o.id)).size, 4);
  // 18개 정답, 2개 오답
  const answers = g.data.payload.map((q, i) => {
    const ci = decode(q, g.data.nonce);
    assert.ok(Number.isInteger(ci) && ci >= 0 && ci < 4);
    const pick = i < 2 ? (ci + 1) % 4 : ci;
    return { n: i, q: q.i, chosen: q.options[pick].id, ms: 1500, ok: true /* 클라이언트 주장은 무시됨 */ };
  });
  await call(`/api/games/${g.data.id}/answers`, { method: 'POST', token: stu.token, body: { answers: answers.slice(0, 5) } });
  await new Promise(r => setTimeout(r, 30));
  backdate(g.data.id);
  const f = await call(`/api/games/${g.data.id}/finish`, { method: 'POST', token: stu.token, body: { answers, blur_count: 1 } });
  assert.equal(f.data.correct, 18);
  assert.equal(f.data.total, 20);
  assert.equal(f.data.accuracy, 90);
  assert.equal(f.data.passed, true);
  assert.equal(f.data.new_best, true);
  assert.equal(f.data.wrong.length, 2);
  assert.ok(f.data.wrong[0].chosen.word);
  const expected = Scoring.score('quiz', answers.map((a, i) => ({ q: a.q, ok: i >= 2, ms: 1500 }))).score;
  assert.equal(f.data.score, expected);
  // 재전송해도 결과 동일(멱등)
  backdate(g.data.id);
  const f2 = await call(`/api/games/${g.data.id}/finish`, { method: 'POST', token: stu.token, body: { answers } });
  assert.equal(f2.data.score, f.data.score);
  const ww = await call('/api/student/wrong-words', { token: stu.token });
  assert.equal(ww.data.words.length, 2);
});

test('cheating: sub-300ms streak is held from ranking', async () => {
  const g = await call('/api/games', { method: 'POST', token: stu2.token, body: { game_type: 'quiz' } });
  const answers = g.data.payload.map((q, i) => ({ n: i, q: q.i, chosen: q.options[decode(q, g.data.nonce)].id, ms: 100 }));
  backdate(g.data.id);
  const f = await call(`/api/games/${g.data.id}/finish`, { method: 'POST', token: stu2.token, body: { answers } });
  assert.equal(f.data.flagged, true);
  const lb = await call(`/api/rooms/${room.id}/leaderboard?stage=2-2&game=quiz`, { token: stu.token });
  assert.equal(lb.data.top.length, 1);
  assert.equal(lb.data.top[0].nickname, '영어천재');
  assert.equal(lb.data.me.rank, 1);
  assert.equal(lb.data.top[0].seat_no, undefined, '출석번호는 학생에게 비공개');
});

test('match and flip games', async () => {
  const m = await call('/api/games', { method: 'POST', token: stu.token, body: { game_type: 'match' } });
  assert.equal(m.data.payload.length, 3);
  const ans = [];
  m.data.payload.forEach(r => {
    const w0 = r.words[0].id, w1 = r.words[1].id;
    ans.push({ n: ans.length, q: r.round, word_id: w0, chosen: w1, ms: 1000 }); // 오답 1회
    r.words.forEach((w, i) => ans.push({ n: ans.length, q: r.round, word_id: w.id, chosen: w.id, ms: 2000 + i * 1000 }));
  });
  backdate(m.data.id);
  const mf = await call(`/api/games/${m.data.id}/finish`, { method: 'POST', token: stu.token, body: { answers: ans } });
  assert.equal(mf.data.correct, 18);
  assert.equal(mf.data.total, 21);
  assert.ok(mf.data.score > 18 * 80);

  const fl = await call('/api/games', { method: 'POST', token: stu.token, body: { game_type: 'flip' } });
  const cards = fl.data.payload.cards;
  assert.equal(cards.length, 12);
  const fa = [];
  const ids = [...new Set(cards.map(c => c.id))];
  ids.forEach((id, i) => {
    const [a, b] = cards.filter(c => c.id === id);
    fa.push({ n: fa.length, a: a.pos, b: b.pos, ms: 3000 + i * 2000 });
  });
  backdate(fl.data.id);
  const ff = await call(`/api/games/${fl.data.id}/finish`, { method: 'POST', token: stu.token, body: { answers: fa } });
  assert.equal(ff.data.correct, 6);
  assert.equal(ff.data.score, Scoring.score('flip', fa.map(() => ({ q: 0, ok: true, ms: 0 }))).score);
});

test('review mini quiz is not ranked', async () => {
  const ww = await call('/api/student/wrong-words', { token: stu.token });
  const g = await call('/api/games', { method: 'POST', token: stu.token, body: { mode: 'review', word_ids: ww.data.words.map(w => w.id) } });
  assert.equal(g.data.mode, 'review');
  const answers = g.data.payload.map((q, i) => ({ n: i, q: q.i, chosen: q.options[decode(q, g.data.nonce)].id, ms: 2000 }));
  backdate(g.data.id);
  const f = await call(`/api/games/${g.data.id}/finish`, { method: 'POST', token: stu.token, body: { answers } });
  assert.equal(f.data.rank, null);
  const after = await call('/api/student/wrong-words', { token: stu.token });
  // 미니 퀴즈에서 각 단어를 2번 이상 맞혔으면 단어장에서 제거
  assert.ok(after.data.words.length <= ww.data.words.length);
});

test('teacher report, checklist, overrides, exports', async () => {
  const st = await call(`/api/rooms/${room.id}/students`);
  const r1 = st.data.rows.find(r => r.seat_no === 1);
  assert.equal(r1.status, 'done');
  assert.equal(st.data.rows.find(r => r.seat_no === 2).status, 'progress');
  assert.equal(st.data.rows.find(r => r.seat_no === 4).status, 'absent');
  assert.equal(st.data.flags.length, 1);
  assert.equal((await call(`/api/rooms/${room.id}/overrides/4`, { method: 'PUT', body: { status: 'done' } })).status, 400);
  await call(`/api/rooms/${room.id}/overrides/4`, { method: 'PUT', body: { status: 'done', memo: '종이 시험 대체' } });
  const rep = await call(`/api/rooms/${room.id}/report`);
  assert.equal(rep.data.checklist.find(r => r.seat_no === 4).status, 'done');
  assert.ok(rep.data.history.length >= 3);
  const x = await call(`/api/rooms/${room.id}/export.xlsx`, { raw: true });
  assert.equal(x.status, 200);
  const buf = Buffer.from(await x.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString(), 'PK');
  const csv = await call(`/api/rooms/${room.id}/export.csv?sheet=neis`, { raw: true });
  const cbuf = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...cbuf.slice(0, 3)], [0xef, 0xbb, 0xbf], '엑셀 한글용 BOM');
  assert.ok(cbuf.slice(3).toString().startsWith('번호,상태,점수'));
  const det = await call(`/api/rooms/${room.id}/students/${stu.student.id}/detail`);
  assert.ok(det.data.games.length >= 3);
  // 승인하면 랭킹에 반영
  await call(`/api/rooms/${room.id}/games/${st.data.flags[0].id}/approve`, { method: 'POST' });
  const lb = await call(`/api/rooms/${room.id}/leaderboard?stage=2-2&game=quiz`);
  assert.equal(lb.data.top.length, 2);
});

test('teacher controls: kick, rename, timer, polling events', async () => {
  const ev0 = await call(`/api/rooms/${room.id}/events?since=0`, { token: stu2.token });
  const seq = ev0.data.seq;
  await call(`/api/rooms/${room.id}/students/${stu2.student.id}`, { method: 'PATCH', body: { timer_factor: 1.5, nickname: '바른이름' } });
  await call(`/api/rooms/${room.id}/start`, { method: 'POST', body: { game_type: 'quiz' } });
  const ev = await call(`/api/rooms/${room.id}/events?since=${seq}`, { token: stu2.token });
  const types = ev.data.events.map(e => e.type);
  assert.ok(types.includes('student.timer'));
  assert.ok(types.includes('student.renamed'));
  assert.ok(types.includes('room.started'));
  await call(`/api/rooms/${room.id}/students/${stu2.student.id}/kick`, { method: 'POST' });
  assert.equal((await call('/api/student/me', { token: stu2.token })).status, 401);
});

test('review room from wrong TOP, duplicate, delete', async () => {
  const dup = await call(`/api/rooms/${room.id}/duplicate`, { method: 'POST', body: { name: '2학년 4반' } });
  assert.equal(dup.status, 201);
  assert.notEqual(dup.data.room.pin, room.pin);
  assert.deepEqual(dup.data.room.stage_lock, room.stage_lock);
  const del = await call(`/api/rooms/${dup.data.room.id}`, { method: 'DELETE' });
  assert.equal(del.data.ok, true);
  const period = await call('/api/rooms', { method: 'POST', body: { name: '과제', mode: 'period', start_date: '2020-01-01', end_date: '2020-01-02' } });
  assert.equal(period.status, 400);
});
