'use strict';
// content/stages/*.json → data/words.json (고정 ID, 학년·난이도·세트 부여, 검증)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LEVEL_NAMES = { 1: '초급', 2: '중급', 3: '고급' };
const SET_SIZE = 20;
const POS = new Set(['n.', 'v.', 'adj.', 'adv.', 'prep.', 'conj.', 'pron.', 'int.']);

const headLines = fs.readFileSync(path.join(ROOT, 'content', 'headwords.txt'), 'utf8')
  .split(/\r?\n/).filter(l => /^\d-\d:/.test(l));

const words = [];
const errors = [];
const seen = new Set();
let n = 0;

for (const line of headLines) {
  const [stage, list] = line.split(':');
  const heads = list.split(',').map(s => s.trim()).filter(Boolean);
  const file = path.join(ROOT, 'content', 'stages', `${stage}.json`);
  if (!fs.existsSync(file)) { errors.push(`${stage}: ${file} 없음`); continue; }
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byWord = new Map(entries.map(e => [e.word, e]));
  const [grade, level] = stage.split('-').map(Number);

  heads.forEach((w, i) => {
    const e = byWord.get(w);
    if (!e) { errors.push(`${stage}: '${w}' 항목 없음`); return; }
    if (seen.has(w)) errors.push(`${stage}: '${w}' 중복`);
    seen.add(w);
    if (!POS.has(e.pos)) errors.push(`${w}: 품사 '${e.pos}'`);
    if (!Array.isArray(e.meanings) || !e.meanings.length || e.meanings.length > 2) errors.push(`${w}: 뜻 개수`);
    if (!e.example_en || !e.example_en.includes(e.example_target)) errors.push(`${w}: example_target 불일치`);
    if (e.example_en && e.example_en.split(/\s+/).length > 12) errors.push(`${w}: 예문 12단어 초과`);
    n++;
    const id = 'w' + String(n).padStart(4, '0');
    words.push({
      id, word: w, pos: e.pos, meanings: e.meanings.slice(0, 2), phonetic: e.phonetic || '',
      audio: `${id}.wav`,
      example_en: e.example_en, example_target: e.example_target, example_ko: e.example_ko,
      grade, level, level_name: LEVEL_NAMES[level], stage,
      set: Math.floor(i / SET_SIZE) + 1,
      confusables: (e.confusables || []).map(c => String(c).toLowerCase()).slice(0, 2)
    });
  });
}

if (errors.length) {
  console.error(`검증 오류 ${errors.length}건:\n` + errors.join('\n'));
  if (!process.argv.includes('--force')) process.exit(1);
}
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'words.json'), JSON.stringify(words));
const counts = {};
words.forEach(w => { counts[w.stage] = (counts[w.stage] || 0) + 1; });
console.log(`words.json: ${words.length}단어`, counts);
