'use strict';
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const { all, get, run, tx } = require('./db');
const W = require('./words');
const R = require('./reports');
const Scoring = require('../public/shared/scoring');
const rt = require('./realtime');
const { id, token, kstDate, kstStart, kstEnd, DAY, nicknameProblem, suggestNickname, HttpError } = require('./util');

const GAMES = ['quiz', 'match', 'flip'];
const DEV_MAGIC = process.env.MAGIC_LINK_DEV !== '0' && process.env.NODE_ENV !== 'production';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const SESSION_DAYS = 30;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));

// ───────── helpers ─────────
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, code = 'BAD_REQUEST') => new HttpError(400, code, msg);
const intIn = (v, lo, hi, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${name}은(는) ${lo}~${hi} 사이여야 해요.`);
  return n;
};

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function teacherFromReq(req) {
  const t = cookies(req).tsess;
  if (!t) return null;
  const s = get(`SELECT t.* FROM teacher_sessions ss JOIN teachers t ON t.id = ss.teacher_id WHERE ss.token = ? AND ss.expires_at > ?`, t, Date.now());
  return s || null;
}

function roomView(r) {
  const now = Date.now();
  return {
    id: r.id, name: r.name, pin: r.pin, mode: r.mode,
    stage_lock: r.stage_lock ? JSON.parse(r.stage_lock) : null,
    custom_words: r.custom_words ? JSON.parse(r.custom_words) : null,
    allowed_games: JSON.parse(r.allowed_games),
    pass_rate: r.pass_rate, study_required: !!r.study_required,
    capacity: r.capacity, roster_size: r.roster_size,
    opens_at: r.opens_at, closes_at: r.closes_at, locked: !!r.locked, created_at: r.created_at,
    status: now > r.closes_at ? 'closed' : now < r.opens_at ? 'scheduled' : 'open'
  };
}

// 학생에게 보이는 방 정보(교사 전용 필드 제외)
function roomForStudent(r) {
  const v = roomView(r);
  return { id: v.id, name: v.name, pin: v.pin, mode: v.mode, stage_lock: v.stage_lock, custom: !!v.custom_words, allowed_games: v.allowed_games, pass_rate: v.pass_rate, study_required: v.study_required, status: v.status, closes_at: v.closes_at };
}

const requireTeacher = (req, res, next) => {
  const t = teacherFromReq(req);
  if (!t) return next(new HttpError(401, 'LOGIN', '교사 로그인이 필요해요.'));
  req.teacher = t;
  next();
};

function ownRoom(req) {
  const r = get(`SELECT * FROM rooms WHERE id = ? AND teacher_id = ?`, req.params.id, req.teacher.id);
  if (!r) throw new HttpError(404, 'NO_ROOM', '방을 찾을 수 없어요.');
  return r;
}

const requireStudent = (req, res, next) => {
  const t = req.get('x-student-token');
  const s = t && get(`SELECT * FROM students WHERE device_token = ?`, t);
  if (!s) return next(new HttpError(401, 'KICKED', '입장 정보가 없어요. 다시 입장해 주세요.'));
  const room = get(`SELECT * FROM rooms WHERE id = ?`, s.room_id);
  if (!room) return next(new HttpError(410, 'CLOSED', '방이 삭제되었어요.'));
  run(`UPDATE students SET last_seen = ? WHERE id = ?`, Date.now(), s.id);
  req.student = s; req.room = room;
  next();
};

function newPin() {
  const cutoff = Date.now() - 30 * DAY; // 마감 30일 후 재사용
  for (let i = 0; i < 200; i++) {
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    if (!get(`SELECT 1 FROM rooms WHERE pin = ? AND closes_at > ?`, pin, cutoff)) return pin;
  }
  throw new Error('PIN 발급 실패');
}

function shareInfo(req, room) {
  const origin = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return { link: `${origin}/?pin=${room.pin}` };
}

// ───────── 교사 인증 (PRD 4.1) ─────────
function startTeacherSession(res, email, name) {
  email = email.toLowerCase();
  let t = get(`SELECT * FROM teachers WHERE email = ?`, email);
  if (!t) {
    t = { id: id('t_'), email, name: name || email.split('@')[0], created_at: Date.now() };
    run(`INSERT INTO teachers (id, email, name, created_at) VALUES (?, ?, ?, ?)`, t.id, t.email, t.name, t.created_at);
  }
  const tok = token();
  run(`INSERT INTO teacher_sessions (token, teacher_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, tok, t.id, Date.now(), Date.now() + SESSION_DAYS * DAY);
  res.setHeader('Set-Cookie', `tsess=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  return t;
}

app.get('/api/auth/config', (req, res) => res.json({ google: GOOGLE_CLIENT_ID || null, devMagic: DEV_MAGIC }));

app.post('/api/auth/magic', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('이메일 주소를 확인해 주세요.');
  const tok = token();
  run(`INSERT INTO magic_tokens (token, email, expires_at) VALUES (?, ?, ?)`, tok, email, Date.now() + 15 * 60e3);
  const origin = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const link = `${origin}/api/auth/verify?token=${tok}`;
  const sent = await sendMagicMail(email, link);
  console.log(`[magic-link] ${email} → ${link}`);
  res.json({ sent, devLink: DEV_MAGIC ? link : undefined });
}));

async function sendMagicMail(email, link) {
  // 메일 발송 웹훅(예: 학교/기관 메일 릴레이)이 설정된 경우에만 전송. 미설정 시 서버 로그·개발용 링크로 대체.
  if (!process.env.MAIL_WEBHOOK_URL) return false;
  try {
    const r = await fetch(process.env.MAIL_WEBHOOK_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: email, subject: '[영단어 800] 교사 로그인 링크', text: `아래 링크를 누르면 로그인됩니다(15분 유효).\n${link}` })
    });
    return r.ok;
  } catch { return false; }
}

app.get('/api/auth/verify', (req, res) => {
  const m = get(`SELECT * FROM magic_tokens WHERE token = ?`, String(req.query.token || ''));
  if (!m || m.used || m.expires_at < Date.now()) return res.redirect('/teacher.html#login-expired');
  run(`UPDATE magic_tokens SET used = 1 WHERE token = ?`, m.token);
  startTeacherSession(res, m.email);
  res.redirect('/teacher.html');
});

app.post('/api/auth/google', wrap(async (req, res) => {
  if (!GOOGLE_CLIENT_ID) throw bad('Google 로그인이 설정되지 않았어요.');
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(req.body.credential || ''));
  const info = await r.json();
  if (!r.ok || info.aud !== GOOGLE_CLIENT_ID || info.email_verified !== 'true') throw new HttpError(401, 'GOOGLE', 'Google 인증에 실패했어요.');
  const t = startTeacherSession(res, info.email, info.name);
  res.json({ teacher: { id: t.id, email: t.email, name: t.name } });
}));

app.post('/api/auth/logout', (req, res) => {
  const t = cookies(req).tsess;
  if (t) run(`DELETE FROM teacher_sessions WHERE token = ?`, t);
  res.setHeader('Set-Cookie', 'tsess=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireTeacher, (req, res) => res.json({ teacher: { id: req.teacher.id, email: req.teacher.email, name: req.teacher.name } }));

// ───────── 콘텐츠 ─────────
app.get('/api/stages', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ stages: W.STAGES });
});

app.get('/api/stages/:stage/sets/:n', (req, res) => {
  const info = W.stageInfo(req.params.stage);
  const n = Number(req.params.n);
  if (!info || !Number.isInteger(n) || n < 1 || n > info.sets) return res.status(404).json({ error: '없는 세트예요.' });
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ stage: info.key, set: n, words: W.unitWords({ stage: info.key, setFrom: n, setTo: n }).map(W.publicWord) });
});

// ───────── 방 관리 (PRD 4.2) ─────────
function parseRoomInput(b, base = {}) {
  const out = {};
  const name = String(b.name ?? base.name ?? '').trim();
  if (!name || name.length > 30) throw bad('방 이름을 1~30자로 입력하세요.');
  out.name = name;

  out.mode = b.mode === 'period' ? 'period' : 'class';
  const today = kstDate();
  if (out.mode === 'class') {
    out.opens_at = Date.now();
    out.closes_at = kstEnd(today);
  } else {
    const s = String(b.start_date || today), e = String(b.end_date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) throw bad('기간제 방은 시작일과 마감일이 필요해요.');
    if (e < s) throw bad('마감일이 시작일보다 빨라요.');
    if (e < today) throw bad('마감일이 이미 지났어요.');
    if (kstStart(e) - kstStart(s) > 92 * DAY) throw bad('기간은 최대 3개월까지 설정할 수 있어요.');
    out.opens_at = kstStart(s);
    out.closes_at = kstEnd(e);
  }

  if (b.custom_words) {
    const ids = [...new Set(b.custom_words)].filter(x => W.byId.has(x));
    if (ids.length < 6) throw bad('복습 방에는 단어가 6개 이상 필요해요.');
    out.custom_words = JSON.stringify(ids);
    out.stage_lock = JSON.stringify({ stage: 'custom' });
  } else if (b.stage_lock) {
    const info = W.stageInfo(b.stage_lock.stage);
    if (!info) throw bad('단계를 선택하세요.');
    const from = intIn(b.stage_lock.setFrom ?? 1, 1, info.sets, '시작 세트');
    const to = intIn(b.stage_lock.setTo ?? from, from, info.sets, '끝 세트');
    out.stage_lock = JSON.stringify({ stage: info.key, setFrom: from, setTo: to });
    out.custom_words = null;
  } else {
    out.stage_lock = null;
    out.custom_words = null;
  }

  const games = (Array.isArray(b.allowed_games) ? b.allowed_games : ['quiz']).filter(g => GAMES.includes(g));
  if (!games.length) throw bad('허용 게임을 하나 이상 고르세요.');
  out.allowed_games = JSON.stringify(games);
  out.pass_rate = intIn(b.pass_rate ?? 80, 60, 100, '통과 기준');
  out.study_required = b.study_required === false ? 0 : 1;
  out.capacity = intIn(b.capacity ?? 40, 1, 60, '정원');
  out.roster_size = intIn(b.roster_size ?? Math.min(out.capacity, 30), 0, 60, '명단 인원');
  return out;
}

function insertRoom(teacherId, f) {
  const r = { id: id('r_'), teacher_id: teacherId, pin: newPin(), created_at: Date.now(), locked: 0, ...f };
  run(`INSERT INTO rooms (id, teacher_id, name, pin, mode, stage_lock, custom_words, allowed_games, pass_rate, study_required, capacity, roster_size, opens_at, closes_at, locked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r.id, r.teacher_id, r.name, r.pin, r.mode, r.stage_lock, r.custom_words, r.allowed_games, r.pass_rate, r.study_required, r.capacity, r.roster_size, r.opens_at, r.closes_at, r.locked, r.created_at);
  return r;
}

app.get('/api/rooms', requireTeacher, (req, res) => {
  const rooms = all(`SELECT r.*, (SELECT COUNT(*) FROM students s WHERE s.room_id = r.id) AS joined
                     FROM rooms r WHERE r.teacher_id = ? ORDER BY r.created_at DESC`, req.teacher.id);
  res.json({ rooms: rooms.map(r => ({ ...roomView(r), joined: r.joined })) });
});

app.post('/api/rooms', requireTeacher, wrap(async (req, res) => {
  const r = insertRoom(req.teacher.id, parseRoomInput(req.body));
  res.status(201).json({ room: roomView(r), ...shareInfo(req, r) });
}));

app.get('/api/rooms/:id', requireTeacher, wrap(async (req, res) => {
  const r = ownRoom(req);
  const share = shareInfo(req, r);
  const qr = await QRCode.toDataURL(share.link, { margin: 1, width: 480, errorCorrectionLevel: 'M' });
  res.json({ room: roomView(r), ...share, qr });
}));

app.post('/api/rooms/:id/duplicate', requireTeacher, wrap(async (req, res) => {
  const src = roomView(ownRoom(req));
  const input = {
    name: req.body.name || src.name, mode: src.mode,
    start_date: req.body.start_date, end_date: req.body.end_date,
    stage_lock: src.custom_words ? null : src.stage_lock, custom_words: src.custom_words,
    allowed_games: src.allowed_games, pass_rate: src.pass_rate, study_required: src.study_required,
    capacity: src.capacity, roster_size: src.roster_size
  };
  if (src.mode === 'period' && !input.end_date) {
    const len = Math.round((src.closes_at - src.opens_at) / DAY);
    input.start_date = kstDate();
    input.end_date = kstDate(Date.now() + Math.max(0, len - 1) * DAY);
  }
  const r = insertRoom(req.teacher.id, parseRoomInput(input));
  res.status(201).json({ room: roomView(r) });
}));

app.patch('/api/rooms/:id', requireTeacher, wrap(async (req, res) => {
  const r = ownRoom(req);
  const b = req.body;
  if ('locked' in b) {
    run(`UPDATE rooms SET locked = ? WHERE id = ?`, b.locked ? 1 : 0, r.id);
    rt.publish(r.id, 'room.locked', { locked: !!b.locked });
  }
  if (b.close) run(`UPDATE rooms SET closes_at = ? WHERE id = ?`, Date.now() - 1, r.id);
  if ('pass_rate' in b) run(`UPDATE rooms SET pass_rate = ? WHERE id = ?`, intIn(b.pass_rate, 60, 100, '통과 기준'), r.id);
  if ('study_required' in b) run(`UPDATE rooms SET study_required = ? WHERE id = ?`, b.study_required ? 1 : 0, r.id);
  if ('roster_size' in b) run(`UPDATE rooms SET roster_size = ? WHERE id = ?`, intIn(b.roster_size, 0, 60, '명단 인원'), r.id);
  if ('capacity' in b) run(`UPDATE rooms SET capacity = ? WHERE id = ?`, intIn(b.capacity, 1, 60, '정원'), r.id);
  if ('name' in b) {
    const n = String(b.name).trim();
    if (!n || n.length > 30) throw bad('방 이름을 1~30자로 입력하세요.');
    run(`UPDATE rooms SET name = ? WHERE id = ?`, n, r.id);
  }
  if ('allowed_games' in b) {
    const g = (b.allowed_games || []).filter(x => GAMES.includes(x));
    if (!g.length) throw bad('허용 게임을 하나 이상 고르세요.');
    run(`UPDATE rooms SET allowed_games = ? WHERE id = ?`, JSON.stringify(g), r.id);
  }
  const nr = get(`SELECT * FROM rooms WHERE id = ?`, r.id);
  rt.publish(r.id, 'room.updated', roomForStudent(nr));
  res.json({ room: roomView(nr) });
}));

app.delete('/api/rooms/:id', requireTeacher, (req, res) => {
  const r = ownRoom(req);
  run(`DELETE FROM rooms WHERE id = ?`, r.id);
  rt.publish(r.id, 'room.deleted', {});
  res.json({ ok: true });
});

// 학년도 말 일괄 삭제: 마감된 방 기록 전부
app.delete('/api/rooms', requireTeacher, (req, res) => {
  const n = run(`DELETE FROM rooms WHERE teacher_id = ? AND closes_at < ?`, req.teacher.id, Date.now()).changes;
  res.json({ deleted: n });
});

app.post('/api/rooms/:id/start', requireTeacher, (req, res) => {
  const r = roomView(ownRoom(req));
  const game = req.body.game_type;
  if (!r.allowed_games.includes(game)) throw bad('허용되지 않은 게임이에요.');
  rt.publish(r.id, 'room.started', { game_type: game, at: Date.now() });
  res.json({ ok: true });
});

// ───────── 수업 통제 ─────────
app.get('/api/rooms/:id/students', requireTeacher, (req, res) => {
  const r = ownRoom(req);
  const flags = all(`SELECT g.id, g.student_id, g.game_type, g.stage, g.score, g.flag_reason, g.ended_at, s.seat_no, s.nickname
                     FROM game_sessions g JOIN students s ON s.id = g.student_id
                     WHERE g.room_id = ? AND g.flagged = 1 ORDER BY g.ended_at DESC`, r.id);
  const playing = new Set(all(`SELECT DISTINCT student_id FROM game_sessions WHERE room_id = ? AND status = 'playing' AND started_at > ?`, r.id, Date.now() - 5 * 60e3).map(x => x.student_id));
  res.json({ room: roomView(r), rows: R.checklist(r).map(x => ({ ...x, playing: playing.has(x.student_id) })), flags });
});

function ownStudent(req, r) {
  const s = get(`SELECT * FROM students WHERE id = ? AND room_id = ?`, req.params.sid, r.id);
  if (!s) throw new HttpError(404, 'NO_STUDENT', '학생을 찾을 수 없어요.');
  return s;
}

app.post('/api/rooms/:id/students/:sid/kick', requireTeacher, (req, res) => {
  const r = ownRoom(req);
  const s = ownStudent(req, r);
  run(`UPDATE students SET device_token = NULL WHERE id = ?`, s.id);
  rt.publish(r.id, 'student.kicked', {}, `student:${s.id}`);
  rt.publish(r.id, 'student.updated', { student_id: s.id }, 'teacher');
  res.json({ ok: true });
});

app.patch('/api/rooms/:id/students/:sid', requireTeacher, (req, res) => {
  const r = ownRoom(req);
  const s = ownStudent(req, r);
  if ('nickname' in req.body) {
    const nick = String(req.body.nickname).trim();
    const p = nicknameProblem(nick);
    if (p) throw bad(p);
    if (get(`SELECT 1 FROM students WHERE room_id = ? AND nickname = ? AND id != ?`, r.id, nick, s.id)) throw bad('같은 방에 이미 있는 닉네임이에요.');
    run(`UPDATE students SET nickname = ? WHERE id = ?`, nick, s.id);
    rt.publish(r.id, 'student.renamed', { nickname: nick }, `student:${s.id}`);
    rt.publish(r.id, 'leaderboard.updated', {});
  }
  if ('timer_factor' in req.body) {
    const f = Number(req.body.timer_factor) === 1.5 ? 1.5 : 1;
    run(`UPDATE students SET timer_factor = ? WHERE id = ?`, f, s.id);
    rt.publish(r.id, 'student.timer', { timer_factor: f }, `student:${s.id}`);
  }
  if (req.body.clear_warning) run(`UPDATE students SET device_warn_at = NULL WHERE id = ?`, s.id);
  res.json({ ok: true });
});

app.put('/api/rooms/:id/overrides/:seat', requireTeacher, (req, res) => {
  const r = ownRoom(req);
  const seat = intIn(req.params.seat, 1, 60, '번호');
  const status = req.body.status;
  const memo = String(req.body.memo || '').trim();
  if (!['done', 'progress', 'absent'].includes(status)) throw bad('상태 값이 올바르지 않아요.');
  if (!memo) throw bad('수동 변경 사유를 입력하세요.');
  run(`INSERT INTO status_overrides (room_id, seat_no, status, memo, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(room_id, seat_no) DO UPDATE SET status = excluded.status, memo = excluded.memo, updated_at = excluded.updated_at`,
    r.id, seat, status, memo.slice(0, 200), Date.now());
  res.json({ ok: true });
});

app.delete('/api/rooms/:id/overrides/:seat', requireTeacher, (req, res) => {
  const r = ownRoom(req);
  run(`DELETE FROM status_overrides WHERE room_id = ? AND seat_no = ?`, r.id, Number(req.params.seat));
  res.json({ ok: true });
});

app.post('/api/rooms/:id/games/:gid/approve', requireTeacher, (req, res) => {
  const r = ownRoom(req);
  run(`UPDATE game_sessions SET flagged = 0, flag_reason = COALESCE(flag_reason, '') || ' (교사 승인)' WHERE id = ? AND room_id = ?`, req.params.gid, r.id);
  rt.publish(r.id, 'leaderboard.updated', {});
  res.json({ ok: true });
});

// ───────── 리포트·내보내기 (PRD 4.4, 4.5) ─────────
app.get('/api/rooms/:id/report', requireTeacher, (req, res) => {
  const r = ownRoom(req);
  res.json({ room: roomView(r), wrong_top: R.wrongTop(r.id), history: R.history(r), checklist: R.checklist(r) });
});

app.get('/api/rooms/:id/students/:sid/detail', requireTeacher, (req, res) => {
  const r = ownRoom(req);
  const d = R.studentDetail(r, req.params.sid);
  if (!d) throw new HttpError(404, 'NO_STUDENT', '학생을 찾을 수 없어요.');
  res.json(d);
});

app.post('/api/rooms/:id/review-room', requireTeacher, (req, res) => {
  const r = roomView(ownRoom(req));
  const top = R.wrongTop(r.id);
  let ids = top.map(t => t.word_id);
  if (ids.length < 6) throw bad('오답 TOP 단어가 6개 이상 쌓여야 복습 퀴즈를 만들 수 있어요.');
  const nr = insertRoom(req.teacher.id, parseRoomInput({
    name: `${r.name} 복습`.slice(0, 30), mode: 'class', custom_words: ids,
    allowed_games: ['quiz'], pass_rate: r.pass_rate, study_required: r.study_required, capacity: r.capacity, roster_size: r.roster_size
  }));
  res.status(201).json({ room: roomView(nr) });
});

const safeName = r => `${r.name}_${kstDate(r.created_at)}`.replace(/[\\/:*?"<>|\s]+/g, '_');

app.get('/api/rooms/:id/export.xlsx', requireTeacher, wrap(async (req, res) => {
  const r = ownRoom(req);
  const buf = await R.xlsx(r);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName(r) + '.xlsx')}`);
  res.send(Buffer.from(buf));
}));

app.get('/api/rooms/:id/export.csv', requireTeacher, (req, res) => {
  const r = ownRoom(req);
  const sheet = String(req.query.sheet || 'checklist');
  const body = R.csv(r, sheet);
  if (!body) throw bad('sheet는 checklist, history, wrong, neis 중 하나예요.');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName(r)}_${sheet}.csv`)}`);
  res.send(body);
});

// ───────── 랭킹 (PRD 3.5, 5.4) ─────────
function leaderboard(roomId, stage, gameType, date = kstDate()) {
  const games = all(`SELECT g.student_id, g.score, g.correct, g.total, g.max_combo, g.ended_at, s.nickname, s.seat_no
                     FROM game_sessions g JOIN students s ON s.id = g.student_id
                     WHERE g.room_id = ? AND g.stage = ? AND g.game_type = ? AND g.date_kst = ?
                       AND g.mode = 'normal' AND g.status = 'done' AND g.flagged = 0`, roomId, stage, gameType, date);
  const best = new Map();
  for (const g of games) {
    const b = best.get(g.student_id);
    if (!b || g.score > b.score || (g.score === b.score && g.ended_at < b.ended_at)) best.set(g.student_id, g);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.ended_at - b.ended_at)
    .map((g, i) => ({ rank: i + 1, student_id: g.student_id, nickname: g.nickname, seat_no: g.seat_no, score: g.score, accuracy: R.pct(g.correct, g.total), max_combo: g.max_combo }));
}

app.get('/api/rooms/:id/leaderboard', wrap(async (req, res) => {
  const teacher = teacherFromReq(req);
  const tok = req.get('x-student-token');
  const me = tok && get(`SELECT * FROM students WHERE device_token = ? AND room_id = ?`, tok, req.params.id);
  const room = get(`SELECT * FROM rooms WHERE id = ?`, req.params.id);
  if (!room || (!me && !(teacher && teacher.id === room.teacher_id))) throw new HttpError(401, 'LOGIN', '권한이 없어요.');
  const stage = String(req.query.stage || ''), game = String(req.query.game || 'quiz');
  const list = leaderboard(room.id, stage, game);
  const top = list.slice(0, 10).map(x => ({ rank: x.rank, nickname: x.nickname, score: x.score, accuracy: x.accuracy, max_combo: x.max_combo, me: !!me && x.student_id === me.id, id: x.student_id }));
  const mine = me ? list.find(x => x.student_id === me.id) : null;
  res.json({ stage, game_type: game, date: kstDate(), top, me: mine ? { rank: mine.rank, score: mine.score, of: list.length } : null, count: list.length });
}));

// 프로젝터 화면용 요약(참여·완료 인원, 탭 목록)
app.get('/api/rooms/:id/board', requireTeacher, (req, res) => {
  const r = ownRoom(req);
  const v = roomView(r);
  const ck = R.checklist(r);
  const tabs = all(`SELECT stage, game_type, COUNT(*) AS n FROM game_sessions WHERE room_id = ? AND date_kst = ? AND mode = 'normal' AND status = 'done' GROUP BY stage, game_type ORDER BY n DESC`, r.id, kstDate());
  if (v.stage_lock) for (const g of v.allowed_games) if (!tabs.some(t => t.stage === v.stage_lock.stage && t.game_type === g)) tabs.push({ stage: v.stage_lock.stage, game_type: g, n: 0 });
  res.json({
    room: v, joined: ck.filter(x => x.student_id).length, done: ck.filter(x => x.status === 'done').length,
    tabs: tabs.map(t => ({ ...t, label: `${R.stageName(t.stage)} · ${R.GAME_NAMES[t.game_type]}` }))
  });
});

// ───────── 학생 입장 (PRD 3.1) ─────────
function roomByPin(pin) {
  const rooms = all(`SELECT * FROM rooms WHERE pin = ? ORDER BY created_at DESC`, String(pin));
  if (!rooms.length) throw new HttpError(404, 'NO_PIN', '없는 PIN이에요. 숫자 6자리를 다시 확인해 주세요.');
  const r = rooms[0];
  const v = roomView(r);
  if (v.status === 'closed') throw new HttpError(410, 'CLOSED', '이미 마감된 방이에요. 선생님께 새 PIN을 받아 주세요.');
  if (v.status === 'scheduled') throw new HttpError(425, 'NOT_OPEN', `아직 열리지 않은 방이에요. ${kstDate(r.opens_at)}부터 입장할 수 있어요.`);
  return r;
}

app.get('/api/join/:pin', (req, res) => {
  const r = roomByPin(req.params.pin);
  res.json({ room: { name: r.name, capacity: r.capacity, locked: !!r.locked, max_seat: Math.max(40, r.capacity) } });
});

app.post('/api/rooms/:pin/join', (req, res) => {
  const r = roomByPin(req.params.pin);
  const seat = intIn(req.body.seat_no, 1, Math.max(40, r.capacity), '출석번호');
  const nick = String(req.body.nickname || '').trim();
  const devTok = String(req.body.device_token || '');
  const existing = get(`SELECT * FROM students WHERE room_id = ? AND seat_no = ?`, r.id, seat);

  if (existing) {
    // 같은 번호 재입장 → 기존 기록에 이어붙임. 다른 기기면 교사에게 경고.
    const sameDevice = devTok && existing.device_token === devTok;
    if (!sameDevice && r.locked) throw new HttpError(423, 'LOCKED', '선생님이 입장을 잠갔어요.');
    const tok = sameDevice ? devTok : token();
    const now = Date.now();
    run(`UPDATE students SET device_token = ?, last_seen = ?, device_warn_at = ? WHERE id = ?`,
      tok, now, sameDevice ? existing.device_warn_at : now, existing.id);
    if (!sameDevice) {
      rt.publish(r.id, 'student.kicked', { reason: 'other_device' }, `student:${existing.id}`);
      rt.publish(r.id, 'student.device_warning', { seat_no: seat, nickname: existing.nickname }, 'teacher');
    }
    rt.publish(r.id, 'student.joined', { seat_no: seat, nickname: existing.nickname, rejoin: true }, 'teacher');
    return res.json({ token: tok, student: studentView(get(`SELECT * FROM students WHERE id = ?`, existing.id)), room: roomForStudent(r), resumed: true, nickname_kept: existing.nickname !== nick });
  }

  if (r.locked) throw new HttpError(423, 'LOCKED', '선생님이 입장을 잠갔어요.');
  const count = get(`SELECT COUNT(*) AS n FROM students WHERE room_id = ?`, r.id).n;
  if (count >= r.capacity) throw new HttpError(409, 'FULL', `정원(${r.capacity}명)이 가득 찼어요. 선생님께 알려 주세요.`);
  const p = nicknameProblem(nick);
  if (p) throw new HttpError(400, 'BAD_NICK', p);
  const taken = new Set(all(`SELECT nickname FROM students WHERE room_id = ?`, r.id).map(x => x.nickname));
  if (taken.has(nick)) throw new HttpError(409, 'DUP_NICK', '같은 방에 이미 있는 닉네임이에요.', { suggestion: suggestNickname(nick, taken) });

  const s = { id: id('s_'), token: token(), now: Date.now() };
  run(`INSERT INTO students (id, room_id, seat_no, nickname, device_token, joined_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    s.id, r.id, seat, nick, s.token, s.now, s.now);
  rt.publish(r.id, 'student.joined', { seat_no: seat, nickname: nick }, 'teacher');
  res.status(201).json({ token: s.token, student: studentView(get(`SELECT * FROM students WHERE id = ?`, s.id)), room: roomForStudent(r) });
});

const studentView = s => ({ id: s.id, seat_no: s.seat_no, nickname: s.nickname, timer_factor: s.timer_factor });

app.get('/api/student/me', requireStudent, (req, res) => {
  const s = req.student, r = req.room;
  const best = all(`SELECT stage, game_type, MAX(score) AS best, MAX(CAST(correct AS REAL) / total) AS acc
                    FROM game_sessions WHERE student_id = ? AND mode = 'normal' AND status = 'done' AND flagged = 0
                    GROUP BY stage, game_type`, s.id);
  const studied = all(`SELECT stage, sets FROM study_sessions WHERE student_id = ? AND completed = 1 AND mode = 'normal'`, s.id);
  const stages = W.STAGES.map(st => {
    const mine = best.filter(b => b.stage === st.key);
    return {
      ...st,
      best: mine.length ? Math.max(...mine.map(b => b.best)) : null,
      passed: mine.some(b => Math.round(b.acc * 100) >= r.pass_rate),
      studied_sets: [...new Set(studied.filter(x => x.stage === st.key).flatMap(x => { const o = JSON.parse(x.sets); const a = []; for (let i = o.from; i <= o.to; i++) a.push(i); return a; }))]
    };
  });
  const wrongCount = get(`SELECT COUNT(*) AS n FROM wrong_words WHERE student_id = ?`, s.id).n;
  res.json({ student: studentView(s), room: roomForStudent(r), stages, wrong_count: wrongCount });
});

app.get('/api/student/custom-words', requireStudent, (req, res) => {
  const ids = req.room.custom_words ? JSON.parse(req.room.custom_words) : [];
  res.json({ words: ids.map(i => W.byId.get(i)).filter(Boolean).map(W.publicWord) });
});

app.get('/api/student/wrong-words', requireStudent, (req, res) => {
  const rows = all(`SELECT word_id, wrong_count, streak_correct FROM wrong_words WHERE student_id = ? ORDER BY updated_at DESC`, req.student.id);
  res.json({ words: rows.map(r => ({ ...W.publicWord(W.byId.get(r.word_id)), wrong_count: r.wrong_count, streak_correct: r.streak_correct })) });
});

// 학생이 고른 학습 단위를 방 설정에 맞춰 검증
function resolveUnit(room, b) {
  const lock = room.stage_lock ? JSON.parse(room.stage_lock) : null;
  if (room.custom_words) return { stage: 'custom', from: 0, to: 0, words: JSON.parse(room.custom_words).map(i => W.byId.get(i)).filter(Boolean) };
  if (lock) return { stage: lock.stage, from: lock.setFrom, to: lock.setTo, words: W.unitWords({ stage: lock.stage, setFrom: lock.setFrom, setTo: lock.setTo }) };
  const info = W.stageInfo(b.stage);
  if (!info) throw bad('단계를 선택하세요.');
  const from = intIn(b.setFrom, 1, info.sets, '세트'), to = intIn(b.setTo ?? from, from, info.sets, '세트');
  return { stage: info.key, from, to, words: W.unitWords({ stage: info.key, setFrom: from, setTo: to }) };
}

app.post('/api/study-sessions', requireStudent, (req, res) => {
  const b = req.body;
  const mode = b.mode === 'review' ? 'review' : 'normal';
  const unit = mode === 'review' ? { stage: 'review', from: 0, to: 0, words: [] } : resolveUnit(req.room, b);
  const total = mode === 'review' ? intIn(b.total, 1, 800, '카드 수') : unit.words.length;
  const seen = Math.min(total, Math.max(0, Number(b.cards_seen) | 0));
  const completed = seen >= total ? 1 : 0;
  const now = Date.now();
  const sid = id('st_');
  run(`INSERT INTO study_sessions (id, student_id, room_id, stage, sets, mode, cards_seen, total, known_count, duration_sec, completed, completed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sid, req.student.id, req.room.id, unit.stage, JSON.stringify({ from: unit.from, to: unit.to }), mode, seen, total,
    Math.min(seen, Math.max(0, Number(b.known_count) | 0)), Math.min(7200, Math.max(0, Number(b.duration_sec) | 0)), completed, completed ? now : null, now);
  rt.publish(req.room.id, 'student.progress', { student_id: req.student.id }, 'teacher');
  res.status(201).json({ id: sid, completed: !!completed });
});

// ───────── 게임 (PRD 3.4, 7.2) ─────────
// 정답 키는 서버에만 두지만, 오프라인에서도 오답 직후 정답을 보여줘야 하므로 퀴즈 정답은 가볍게 인코딩해 보낸다.
// 점수 자체는 서버가 답안 기록으로 재계산하므로 클라이언트 점수 조작은 반영되지 않는다.
const encodeAnswer = (idx, qi, nonce) => ((idx + 1) * 7919 + qi * 31 + nonce).toString(36);

app.post('/api/games', requireStudent, (req, res) => {
  const r = roomView(req.room), b = req.body;
  if (r.status !== 'open') throw new HttpError(410, 'CLOSED', '마감된 방이에요.');
  const mode = b.mode === 'review' ? 'review' : 'normal';
  const type = mode === 'review' ? 'quiz' : b.game_type;
  if (!GAMES.includes(type)) throw bad('게임 종류를 확인하세요.');
  if (mode === 'normal' && !r.allowed_games.includes(type)) throw bad('이 방에서 허용되지 않은 게임이에요.');

  let unit;
  if (mode === 'review') {
    const ids = [...new Set(Array.isArray(b.word_ids) ? b.word_ids : [])].filter(x => W.byId.has(x)).slice(0, 40);
    if (!ids.length) throw bad('복습할 단어가 없어요.');
    const words = ids.map(x => W.byId.get(x));
    unit = { stage: 'review', from: 0, to: 0, words };
  } else {
    unit = resolveUnit(req.room, b);
  }
  if (unit.words.length < (type === 'quiz' ? 1 : 6) && mode === 'normal') throw bad('단어가 부족해요.');

  const nonce = Math.floor(Math.random() * 1e6);
  let key, pub;
  if (type === 'quiz') {
    const n = mode === 'review' ? Math.min(20, Math.max(unit.words.length, Math.min(10, unit.words.length * 2))) : 20;
    ({ key, pub } = W.makeQuiz(unit.words, n));
    pub = pub.map((q, i) => ({ ...q, k: encodeAnswer(key[i].options.indexOf(key[i].answer), i, nonce) }));
  } else if (type === 'match') ({ key, pub } = W.makeMatch(unit.words));
  else { const f = W.makeFlip(unit.words); key = { ids: f.key, cards: f.pub.cards }; pub = f.pub; }

  const g = { id: id('g_'), now: Date.now() };
  run(`INSERT INTO game_sessions (id, student_id, room_id, stage, sets, game_type, mode, questions, timer_factor, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'playing', ?)`,
    g.id, req.student.id, req.room.id, unit.stage, JSON.stringify({ from: unit.from, to: unit.to }), type, mode, JSON.stringify(key), req.student.timer_factor, g.now);
  res.status(201).json({ id: g.id, game_type: type, mode, stage: unit.stage, timer_factor: req.student.timer_factor, nonce, payload: pub, rules: Scoring.RULES[type] });
});

function gameOf(req) {
  const g = get(`SELECT * FROM game_sessions WHERE id = ? AND student_id = ?`, req.params.gid, req.student.id);
  if (!g) throw new HttpError(404, 'NO_GAME', '게임을 찾을 수 없어요.');
  return g;
}

// 답안 1건을 서버 정답표로 판정해 저장 형태로 바꾼다
function judge(g, key, a) {
  const ms = Math.max(0, Math.min(10 * 60e3, Number(a.ms) | 0));
  const seq = Number(a.n);
  if (!Number.isInteger(seq) || seq < 0 || seq > 400) return null;
  if (g.game_type === 'quiz') {
    const q = Number(a.q);
    const k = key[q];
    if (!k) return null;
    const chosen = a.chosen && k.options.includes(a.chosen) ? a.chosen : null;
    return { seq, q, word_id: k.word_id, chosen, ok: chosen === k.answer ? 1 : 0, ms: Math.min(ms, 7000 * g.timer_factor + 1500) };
  }
  if (g.game_type === 'match') {
    const q = Number(a.q);
    const ids = key[q];
    if (!ids || !ids.includes(a.word_id) || !ids.includes(a.chosen)) return null;
    return { seq, q, word_id: a.word_id, chosen: a.chosen, ok: a.word_id === a.chosen ? 1 : 0, ms };
  }
  const ca = key.cards[Number(a.a)], cb = key.cards[Number(a.b)];
  if (!ca || !cb || ca === cb) return null;
  const ok = ca.id === cb.id && ca.kind !== cb.kind;
  const w = ca.kind === 'word' ? ca : cb.kind === 'word' ? cb : null;
  const other = w === ca ? cb : ca;
  const pairKind = ca.kind !== cb.kind;
  return { seq, q: 0, word_id: pairKind ? w.id : null, chosen: pairKind ? other.id : `${ca.id}|${cb.id}`, ok: ok ? 1 : 0, ms };
}

function storeAnswers(g, list) {
  if (!Array.isArray(list) || !list.length) return 0;
  const key = JSON.parse(g.questions);
  let n = 0;
  tx(() => {
    for (const a of list.slice(0, 400)) {
      const j = judge(g, key, a || {});
      if (!j) continue;
      if (g.game_type === 'quiz' && get(`SELECT 1 FROM answers WHERE game_session_id = ? AND q_index = ?`, g.id, j.q)) continue;
      n += run(`INSERT OR IGNORE INTO answers (game_session_id, seq, q_index, word_id, chosen, is_correct, response_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        g.id, j.seq, j.q, j.word_id, j.chosen, j.ok, j.ms).changes;
    }
  });
  return n;
}

app.post('/api/games/:gid/answers', requireStudent, (req, res) => {
  const g = gameOf(req);
  if (g.status !== 'playing') return res.json({ stored: 0, finished: true });
  res.json({ stored: storeAnswers(g, req.body.answers) });
});

function detectAnomaly(g, rows, result) {
  const reasons = [];
  if (result.score > Scoring.maxScore(g.game_type)) reasons.push('이론상 최대 점수 초과');
  let fast = 0, prev = null;
  for (const a of rows) {
    const gap = g.game_type === 'quiz' ? a.response_ms : (prev === null ? a.response_ms : a.response_ms - prev);
    prev = a.response_ms;
    if (a.is_correct && gap < 300) { if (++fast >= 3) { reasons.push('300ms 미만 연속 정답'); break; } }
    else fast = 0;
  }
  if (g.game_type === 'quiz') {
    const sum = rows.reduce((s, a) => s + a.response_ms, 0);
    if (Date.now() - g.started_at + 3000 < sum) reasons.push('응답 시간 불일치');
  }
  return reasons;
}

function updateWrongWords(studentId, rows) {
  const units = new Map();
  for (const a of rows) {
    if (!a.word_id) continue;
    const k = `${a.q_index}|${a.word_id}`;
    if (!units.has(k)) units.set(k, { w: a.word_id, wrong: false });
    if (!a.is_correct) units.get(k).wrong = true;
  }
  const now = Date.now();
  for (const u of units.values()) {
    const cur = get(`SELECT * FROM wrong_words WHERE student_id = ? AND word_id = ?`, studentId, u.w);
    if (u.wrong) {
      run(`INSERT INTO wrong_words (student_id, word_id, wrong_count, streak_correct, updated_at) VALUES (?, ?, 1, 0, ?)
           ON CONFLICT(student_id, word_id) DO UPDATE SET wrong_count = wrong_count + 1, streak_correct = 0, updated_at = excluded.updated_at`, studentId, u.w, now);
    } else if (cur) {
      // 두 번 연속 맞히면 내 단어장에서 자동 제거
      if (cur.streak_correct + 1 >= 2) run(`DELETE FROM wrong_words WHERE student_id = ? AND word_id = ?`, studentId, u.w);
      else run(`UPDATE wrong_words SET streak_correct = streak_correct + 1, updated_at = ? WHERE student_id = ? AND word_id = ?`, now, studentId, u.w);
    }
  }
}

function wrongList(g, rows) {
  const seen = new Set(), out = [];
  for (const a of rows) {
    if (a.is_correct || !a.word_id) continue;
    const k = `${a.q_index}|${a.word_id}|${a.chosen}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const w = W.byId.get(a.word_id), c = a.chosen && W.byId.get(a.chosen);
    out.push({ word_id: a.word_id, word: w.word, meaning: W.meaningText(w), chosen: c ? { word: c.word, meaning: W.meaningText(c) } : null });
  }
  return out;
}

app.post('/api/games/:gid/finish', requireStudent, (req, res) => {
  let g = gameOf(req);
  if (g.status === 'playing') {
    storeAnswers(g, req.body.answers);
    const rows = all(`SELECT * FROM answers WHERE game_session_id = ? ORDER BY seq`, g.id);
    const result = Scoring.score(g.game_type, rows.map(a => ({ q: a.q_index, ok: !!a.is_correct, ms: Math.round(a.response_ms / g.timer_factor) })));
    const reasons = g.mode === 'normal' ? detectAnomaly(g, rows, result) : [];
    const now = Date.now();
    tx(() => {
      run(`UPDATE game_sessions SET status = 'done', score = ?, correct = ?, total = ?, max_combo = ?, flagged = ?, flag_reason = ?, blur_count = ?, ended_at = ?, date_kst = ? WHERE id = ?`,
        result.score, result.correct, result.total, result.maxCombo, reasons.length ? 1 : 0, reasons.join(', ') || null,
        Math.min(999, Math.max(0, Number(req.body.blur_count) | 0)), now, kstDate(now), g.id);
      updateWrongWords(g.student_id, rows);
    });
    if (g.mode === 'normal') {
      rt.publish(g.room_id, 'leaderboard.updated', { stage: g.stage, game_type: g.game_type });
      rt.publish(g.room_id, 'student.progress', { student_id: g.student_id, flagged: reasons.length > 0 }, 'teacher');
    }
    g = get(`SELECT * FROM game_sessions WHERE id = ?`, g.id);
  }
  const rows = all(`SELECT * FROM answers WHERE game_session_id = ? ORDER BY seq`, g.id);
  const prevBest = get(`SELECT MAX(score) AS b FROM game_sessions WHERE student_id = ? AND stage = ? AND game_type = ? AND mode = 'normal' AND status = 'done' AND flagged = 0 AND id != ? AND ended_at < ?`,
    g.student_id, g.stage, g.game_type, g.id, g.ended_at).b;
  const acc = R.pct(g.correct, g.total);
  let rank = null;
  if (g.mode === 'normal') {
    const lb = leaderboard(g.room_id, g.stage, g.game_type, g.date_kst);
    const me = lb.find(x => x.student_id === g.student_id);
    rank = me ? { rank: me.rank, of: lb.length } : null;
  }
  res.json({
    id: g.id, game_type: g.game_type, mode: g.mode, stage: g.stage,
    score: g.score, correct: g.correct, total: g.total, accuracy: acc, max_combo: g.max_combo,
    new_best: g.mode === 'normal' && !g.flagged && (prevBest === null || g.score > prevBest), prev_best: prevBest,
    passed: acc >= req.room.pass_rate, pass_rate: req.room.pass_rate,
    flagged: !!g.flagged, rank, wrong: wrongList(g, rows),
    words: [...new Set(rows.map(a => a.word_id).filter(Boolean))]
  });
});

// ───────── 폴링 폴백 ─────────
app.get('/api/rooms/:id/events', (req, res) => {
  const since = Number(req.query.since) || 0;
  const tok = req.get('x-student-token');
  const s = tok && get(`SELECT * FROM students WHERE device_token = ? AND room_id = ?`, tok, req.params.id);
  const t = teacherFromReq(req);
  const room = get(`SELECT teacher_id FROM rooms WHERE id = ?`, req.params.id);
  let meta = null;
  if (s) meta = { role: 'student', studentId: s.id, roomId: req.params.id };
  else if (t && room && room.teacher_id === t.id) meta = { role: 'teacher', roomId: req.params.id };
  if (!meta) return res.status(401).json({ error: 'unauthorized', code: tok ? 'KICKED' : 'LOGIN' });
  if (s) run(`UPDATE students SET last_seen = ? WHERE id = ?`, Date.now(), s.id);
  res.json(rt.eventsSince(req.params.id, since, meta));
});

// WebSocket 인증
async function authorizeSocket(params, req) {
  const roomId = params.get('room');
  if (params.get('role') === 'student') {
    const s = get(`SELECT * FROM students WHERE device_token = ? AND room_id = ?`, params.get('token') || '', roomId);
    return s ? { role: 'student', studentId: s.id, roomId } : null;
  }
  const t = teacherFromReq(req);
  const room = t && get(`SELECT teacher_id FROM rooms WHERE id = ?`, roomId);
  return room && room.teacher_id === t.id ? { role: 'teacher', roomId } : null;
}

// ───────── 정적 파일·오류 ─────────
app.use('/audio', express.static(path.join(__dirname, '..', 'var', 'audio'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));

app.use('/api', (req, res) => res.status(404).json({ error: '없는 API예요.' }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '요청 형식이 올바르지 않아요.' });
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' });
});

// 보관 기간: 방 마감 후 1년
function cleanup() {
  const n = run(`DELETE FROM rooms WHERE closes_at < ?`, Date.now() - 365 * DAY).changes;
  run(`DELETE FROM teacher_sessions WHERE expires_at < ?`, Date.now());
  run(`DELETE FROM magic_tokens WHERE expires_at < ?`, Date.now() - DAY);
  if (n) console.log(`[cleanup] 보관 기간이 지난 방 ${n}개 삭제`);
}

module.exports = { app, authorizeSocket, cleanup, leaderboard };
