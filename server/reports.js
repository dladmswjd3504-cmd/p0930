'use strict';
const ExcelJS = require('exceljs');
const { all, get } = require('./db');
const W = require('./words');

const GAME_NAMES = { quiz: '스피드 퀴즈', match: '짝 맞추기', flip: '카드 뒤집기' };
const STATUS = { done: '완료', progress: '진행 중', absent: '미참여' };

const stageName = key => key === 'custom' ? '복습 퀴즈' : (W.stageInfo(key) || {}).name || key;
const pct = (c, t) => (t ? Math.round((c / t) * 100) : 0);
const fmtTime = ts => ts ? new Date(ts + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '';

function roomGames(roomId) {
  return all(`SELECT * FROM game_sessions WHERE room_id = ? AND mode = 'normal' AND status = 'done' ORDER BY ended_at`, roomId);
}

// PRD 4.5 — 완료: 암기 완료 + 정답률 ≥ 통과 기준 1회 이상
function checklist(room) {
  const students = all(`SELECT * FROM students WHERE room_id = ? ORDER BY seat_no`, room.id);
  const games = roomGames(room.id);
  const studies = all(`SELECT * FROM study_sessions WHERE room_id = ? AND mode = 'normal'`, room.id);
  const overrides = new Map(all(`SELECT * FROM status_overrides WHERE room_id = ?`, room.id).map(o => [o.seat_no, o]));
  const bySeat = new Map(students.map(s => [s.seat_no, s]));
  const maxSeat = Math.max(room.roster_size, ...students.map(s => s.seat_no), 0);

  const rows = [];
  for (let seat = 1; seat <= maxSeat; seat++) {
    const s = bySeat.get(seat);
    if (!s && seat > room.roster_size) continue;
    let status = 'absent', completedAt = null, best = null, bestAcc = null, studyDone = false, passed = false;
    if (s) {
      status = 'progress';
      const st = studies.filter(x => x.student_id === s.id);
      const doneStudy = st.filter(x => x.completed).map(x => x.completed_at).sort((a, b) => a - b)[0];
      studyDone = !!doneStudy;
      const mine = games.filter(g => g.student_id === s.id && !g.flagged);
      const passing = mine.filter(g => pct(g.correct, g.total) >= room.pass_rate).map(g => g.ended_at);
      passed = passing.length > 0;
      mine.forEach(g => {
        if (best === null || g.score > best) best = g.score;
        const a = pct(g.correct, g.total);
        if (bestAcc === null || a > bestAcc) bestAcc = a;
      });
      if (passed && (studyDone || !room.study_required)) {
        status = 'done';
        completedAt = Math.max(passing[0], room.study_required ? doneStudy : 0);
      }
    }
    const ov = overrides.get(seat);
    rows.push({
      seat_no: seat, student_id: s ? s.id : null, nickname: s ? s.nickname : '',
      status: ov ? ov.status : status, auto_status: status,
      override: ov ? { status: ov.status, memo: ov.memo, updated_at: ov.updated_at } : null,
      study_done: studyDone, passed, best_score: best, best_accuracy: bestAcc, completed_at: completedAt,
      device_warn_at: s ? s.device_warn_at : null, timer_factor: s ? s.timer_factor : 1,
      joined_at: s ? s.joined_at : null, last_seen: s ? s.last_seen : null
    });
  }
  return rows;
}

function history(room) {
  const students = all(`SELECT * FROM students WHERE room_id = ? ORDER BY seat_no`, room.id);
  const games = roomGames(room.id);
  const studies = all(`SELECT student_id, SUM(duration_sec) AS sec FROM study_sessions WHERE room_id = ? GROUP BY student_id`, room.id);
  const studySec = new Map(studies.map(s => [s.student_id, s.sec]));
  const done = new Map(checklist(room).map(r => [r.student_id, r.completed_at]));
  const rows = [];
  for (const s of students) {
    const mine = games.filter(g => g.student_id === s.id);
    const groups = new Map();
    mine.forEach(g => {
      const k = g.stage + '|' + g.game_type;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(g);
    });
    const base = { student_id: s.id, seat_no: s.seat_no, nickname: s.nickname, study_sec: studySec.get(s.id) || 0, completed_at: done.get(s.id) || null };
    if (!groups.size) { rows.push({ ...base, stage: '', game_type: '', best_score: null, last_score: null, accuracy: null, attempts: 0, flagged: 0, blur: 0 }); continue; }
    for (const list of groups.values()) {
      const ok = list.filter(g => !g.flagged);
      const best = ok.length ? ok.reduce((a, b) => (b.score > a.score ? b : a)) : null;
      const last = list[list.length - 1];
      rows.push({
        ...base, stage: list[0].stage, game_type: list[0].game_type,
        best_score: best ? best.score : null, last_score: last.score,
        accuracy: best ? pct(best.correct, best.total) : null,
        attempts: list.length,
        flagged: list.filter(g => g.flagged).length,
        blur: list.reduce((a, g) => a + (g.blur_count || 0), 0)
      });
    }
  }
  return rows;
}

// PRD 4.4 — 단어별 오답률(최소 5회 출제), 가장 많이 고른 오답 보기
function wrongTop(roomId, limit = 10) {
  const rows = all(`
    SELECT a.game_session_id AS g, a.q_index AS q, a.word_id AS w, a.chosen AS c, a.is_correct AS ok
    FROM answers a JOIN game_sessions s ON s.id = a.game_session_id
    WHERE s.room_id = ? AND s.mode = 'normal' AND s.status = 'done' AND a.word_id IS NOT NULL`, roomId);
  const units = new Map();
  for (const r of rows) {
    const k = `${r.g}|${r.q}|${r.w}`;
    if (!units.has(k)) units.set(k, { w: r.w, wrong: false, chosen: [] });
    const u = units.get(k);
    if (!r.ok) { u.wrong = true; if (r.c && r.c !== r.w) u.chosen.push(r.c); }
  }
  const stat = new Map();
  for (const u of units.values()) {
    if (!stat.has(u.w)) stat.set(u.w, { asked: 0, wrong: 0, picks: new Map() });
    const s = stat.get(u.w);
    s.asked++;
    if (u.wrong) s.wrong++;
    u.chosen.forEach(c => s.picks.set(c, (s.picks.get(c) || 0) + 1));
  }
  return [...stat.entries()]
    .filter(([, s]) => s.asked >= 5 && s.wrong > 0)
    .map(([wid, s]) => {
      const w = W.byId.get(wid);
      const top = [...s.picks.entries()].sort((a, b) => b[1] - a[1])[0];
      const tw = top && W.byId.get(top[0]);
      return {
        word_id: wid, word: w ? w.word : wid, meaning: w ? W.meaningText(w) : '',
        asked: s.asked, wrong: s.wrong, rate: Math.round((s.wrong / s.asked) * 100),
        top_wrong: tw ? { word_id: tw.id, word: tw.word, meaning: W.meaningText(tw), count: top[1] } : null
      };
    })
    .sort((a, b) => b.rate - a.rate || b.wrong - a.wrong)
    .slice(0, limit);
}

function studentDetail(room, studentId) {
  const s = get(`SELECT * FROM students WHERE id = ? AND room_id = ?`, studentId, room.id);
  if (!s) return null;
  const games = all(`SELECT id, stage, game_type, mode, score, correct, total, max_combo, flagged, flag_reason, blur_count, started_at, ended_at
                     FROM game_sessions WHERE student_id = ? AND status = 'done' ORDER BY ended_at`, s.id);
  const wrong = all(`SELECT word_id, wrong_count, streak_correct FROM wrong_words WHERE student_id = ? ORDER BY wrong_count DESC`, s.id)
    .map(r => { const w = W.byId.get(r.word_id); return { ...r, word: w && w.word, meaning: w && W.meaningText(w) }; });
  const studies = all(`SELECT stage, sets, mode, cards_seen, total, known_count, duration_sec, completed, created_at FROM study_sessions WHERE student_id = ? ORDER BY created_at`, s.id);
  return { student: s, games, wrong, studies };
}

// 엑셀·CSV 공통 표
function tables(room) {
  const ck = checklist(room);
  const hist = history(room);
  const top = wrongTop(room.id);
  return {
    checklist: {
      title: '체크표',
      head: ['번호', '닉네임', '상태', '암기 완료', '통과', '최고 점수', '최고 정답률(%)', '완료 시각', '수동 변경 사유'],
      rows: ck.map(r => [r.seat_no, r.nickname, STATUS[r.status], r.study_done ? 'O' : '', r.passed ? 'O' : '', r.best_score ?? '', r.best_accuracy ?? '', fmtTime(r.completed_at), r.override ? r.override.memo : ''])
    },
    neis: {
      title: '나이스 입력용',
      head: ['번호', '상태', '점수'],
      rows: ck.map(r => [r.seat_no, STATUS[r.status], r.best_score ?? 0])
    },
    history: {
      title: '개인별 이력',
      head: ['번호', '닉네임', '단계', '게임', '최고 점수', '최근 점수', '정답률(%)', '시도 횟수', '암기 소요(분)', '완료 시각', '보류 기록', '탭 이탈'],
      rows: hist.map(r => [r.seat_no, r.nickname, r.stage ? stageName(r.stage) : '', GAME_NAMES[r.game_type] || '', r.best_score ?? '', r.last_score ?? '', r.accuracy ?? '', r.attempts, Math.round((r.study_sec / 60) * 10) / 10, fmtTime(r.completed_at), r.flagged || '', r.blur || ''])
    },
    wrong: {
      title: '오답 TOP 10',
      head: ['순위', '단어', '뜻', '출제 수', '오답 수', '오답률(%)', '가장 많이 고른 오답'],
      rows: top.map((t, i) => [i + 1, t.word, t.meaning, t.asked, t.wrong, t.rate, t.top_wrong ? `${t.top_wrong.word} (${t.top_wrong.meaning}) ×${t.top_wrong.count}` : ''])
    }
  };
}

async function xlsx(room) {
  const t = tables(room);
  const wb = new ExcelJS.Workbook();
  wb.creator = '영단어 800';
  wb.created = new Date();
  for (const key of ['checklist', 'history', 'wrong', 'neis']) {
    const sh = wb.addWorksheet(t[key].title);
    sh.addRow(t[key].head);
    t[key].rows.forEach(r => sh.addRow(r));
    sh.getRow(1).font = { bold: true };
    sh.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF9' } };
    sh.views = [{ state: 'frozen', ySplit: 1 }];
    sh.columns.forEach((c, i) => { c.width = Math.max(8, ...[t[key].head[i], ...t[key].rows.map(r => r[i])].map(v => String(v ?? '').length * 1.6 + 2)); });
  }
  return wb.xlsx.writeBuffer();
}

function csv(room, sheet) {
  const t = tables(room)[sheet];
  if (!t) return null;
  const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [t.head, ...t.rows].map(r => r.map(esc).join(',')).join('\r\n');
}

module.exports = { checklist, history, wrongTop, studentDetail, xlsx, csv, tables, GAME_NAMES, stageName, pct };
