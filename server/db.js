'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'var');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'voca800.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teachers (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS teacher_sessions (
  token TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS magic_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pin TEXT NOT NULL,
  mode TEXT NOT NULL,                 -- 'class' (수업용) | 'period' (기간제)
  stage_lock TEXT,                    -- JSON {stage, setFrom, setTo} | null (자유 선택)
  custom_words TEXT,                  -- JSON [word_id] (복습 퀴즈 방) | null
  allowed_games TEXT NOT NULL,        -- JSON ['quiz','match','flip']
  pass_rate INTEGER NOT NULL,
  study_required INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  roster_size INTEGER NOT NULL,
  opens_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_pin ON rooms(pin);
CREATE INDEX IF NOT EXISTS rooms_teacher ON rooms(teacher_id);

CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seat_no INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  device_token TEXT,
  joined_at INTEGER NOT NULL,
  last_seen INTEGER,
  timer_factor REAL NOT NULL DEFAULT 1,
  device_warn_at INTEGER,
  UNIQUE(room_id, seat_no)
);
CREATE INDEX IF NOT EXISTS students_token ON students(device_token);

CREATE TABLE IF NOT EXISTS study_sessions (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  sets TEXT NOT NULL,
  mode TEXT NOT NULL,                 -- 'normal' | 'review'
  cards_seen INTEGER NOT NULL,
  total INTEGER NOT NULL,
  known_count INTEGER NOT NULL,
  duration_sec INTEGER NOT NULL,
  completed INTEGER NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS study_student ON study_sessions(student_id);

CREATE TABLE IF NOT EXISTS game_sessions (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  sets TEXT NOT NULL,
  game_type TEXT NOT NULL,            -- 'quiz' | 'match' | 'flip'
  mode TEXT NOT NULL,                 -- 'normal' | 'review'
  questions TEXT NOT NULL,            -- server-side answer key (JSON)
  timer_factor REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL,               -- 'playing' | 'done'
  score INTEGER, correct INTEGER, total INTEGER, max_combo INTEGER,
  flagged INTEGER NOT NULL DEFAULT 0,
  flag_reason TEXT,
  blur_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  date_kst TEXT
);
CREATE INDEX IF NOT EXISTS games_room ON game_sessions(room_id, date_kst, stage, game_type);
CREATE INDEX IF NOT EXISTS games_student ON game_sessions(student_id);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,               -- 클라이언트 답안 순번(묶음·재전송 중복 제거)
  q_index INTEGER NOT NULL,
  word_id TEXT,
  chosen TEXT,
  is_correct INTEGER NOT NULL,
  response_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS answers_game_seq ON answers(game_session_id, seq);

CREATE TABLE IF NOT EXISTS wrong_words (
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  word_id TEXT NOT NULL,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  streak_correct INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (student_id, word_id)
);

CREATE TABLE IF NOT EXISTS status_overrides (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seat_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  memo TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, seat_no)
);
`);

function all(sql, ...p) { return db.prepare(sql).all(...p); }
function get(sql, ...p) { return db.prepare(sql).get(...p); }
function run(sql, ...p) { return db.prepare(sql).run(...p); }
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, all, get, run, tx };
