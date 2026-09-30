'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORDS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'words.json'), 'utf8'));
const byId = new Map(WORDS.map(w => [w.id, w]));
const byText = new Map(WORDS.map(w => [w.word, w]));
const byStage = new Map();
for (const w of WORDS) {
  if (!byStage.has(w.stage)) byStage.set(w.stage, []);
  byStage.get(w.stage).push(w);
}

const STAGES = [];
for (const g of [1, 2, 3]) for (const l of [1, 2, 3]) {
  const key = `${g}-${l}`;
  const list = byStage.get(key) || [];
  STAGES.push({
    key, grade: g, level: l,
    name: `중${g} ${['', '초급', '중급', '고급'][l]}`,
    count: list.length,
    sets: Math.max(1, Math.ceil(list.length / 20))
  });
}
const stageInfo = key => STAGES.find(s => s.key === key);

function publicWord(w) {
  const { id, word, pos, meanings, phonetic, audio, example_en, example_target, example_ko, grade, level, stage, set } = w;
  return { id, word, pos, meanings, phonetic, audio, example_en, example_target, example_ko, grade, level, stage, set };
}

// 학습 단위 = (단계, 세트 범위) 또는 복습 방의 지정 단어 목록
function unitWords(unit) {
  if (unit.wordIds) return unit.wordIds.map(id => byId.get(id)).filter(Boolean);
  const list = byStage.get(unit.stage) || [];
  return list.filter(w => w.set >= unit.setFrom && w.set <= unit.setTo);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const meaningText = w => w.meanings.join(', ');

// 오답 보기: 헷갈리는 단어(confusables) 우선 → 같은 단계·같은 품사 → 같은 단계
function distractors(target, k) {
  const out = [];
  const used = new Set([target.id]);
  const bad = new Set(target.meanings);
  const ok = w => w && !used.has(w.id) && !w.meanings.some(m => bad.has(m));
  const take = w => { out.push(w); used.add(w.id); };
  for (const c of target.confusables || []) {
    const w = byText.get(c);
    if (out.length < 1 && ok(w)) take(w);
  }
  const same = shuffle((byStage.get(target.stage) || []).slice());
  for (const w of same) { if (out.length >= k) break; if (w.pos === target.pos && ok(w)) take(w); }
  for (const w of same) { if (out.length >= k) break; if (ok(w)) take(w); }
  return out;
}

// 서버 보관용 정답표(key)와 클라이언트 전송용(pub)을 함께 만든다
function makeQuiz(words, count = 20) {
  const order = [];
  while (order.length < count) {
    const batch = shuffle(words.slice());
    if (order.length && batch[0].id === order[order.length - 1].id && batch.length > 1) batch.push(batch.shift());
    order.push(...batch);
  }
  const key = [], pub = [];
  order.slice(0, count).forEach((w, i) => {
    const dir = crypto.randomInt(2) ? 'w2m' : 'm2w';
    const opts = shuffle([w, ...distractors(w, 3)]);
    key.push({ word_id: w.id, options: opts.map(o => o.id), answer: w.id });
    pub.push({
      i, dir, word_id: w.id,
      prompt: dir === 'w2m' ? { text: w.word, sub: w.phonetic } : { text: meaningText(w), sub: w.pos },
      options: opts.map(o => ({ id: o.id, text: dir === 'w2m' ? meaningText(o) : o.word }))
    });
  });
  return { key, pub };
}

function makeMatch(words, rounds = 3, pairs = 6) {
  const pool = [];
  while (pool.length < rounds * pairs) pool.push(...shuffle(words.slice()));
  const key = [], pub = [];
  for (let r = 0; r < rounds; r++) {
    const ws = [];
    for (const w of pool) { if (ws.length >= pairs) break; if (!ws.includes(w)) ws.push(w); }
    ws.forEach(w => pool.splice(pool.indexOf(w), 1));
    key.push(ws.map(w => w.id));
    pub.push({
      round: r,
      words: shuffle(ws.map(w => ({ id: w.id, text: w.word }))),
      meanings: shuffle(ws.map(w => ({ id: w.id, text: meaningText(w) })))
    });
  }
  return { key, pub };
}

function makeFlip(words, pairs = 6) {
  const ws = shuffle(words.slice()).slice(0, pairs);
  const cards = shuffle([
    ...ws.map(w => ({ id: w.id, kind: 'word', text: w.word })),
    ...ws.map(w => ({ id: w.id, kind: 'meaning', text: meaningText(w) }))
  ]).map((c, i) => ({ ...c, pos: i }));
  return { key: ws.map(w => w.id), pub: { cards } };
}

module.exports = { WORDS, byId, byStage, STAGES, stageInfo, publicWord, unitWords, makeQuiz, makeMatch, makeFlip, shuffle, meaningText };
