'use strict';
const crypto = require('crypto');

const KST = 9 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;

const id = (p = '') => p + crypto.randomBytes(9).toString('base64url');
const token = () => crypto.randomBytes(24).toString('base64url');

// 'YYYY-MM-DD' (KST)
const kstDate = (ts = Date.now()) => new Date(ts + KST).toISOString().slice(0, 10);
// KST 날짜 문자열의 00:00 / 23:59:59.999 → epoch ms
const kstStart = d => Date.parse(d + 'T00:00:00.000Z') - KST;
const kstEnd = d => kstStart(d) + DAY - 1;

// 닉네임 금칙어 — 공백·특수문자·숫자를 지우고 비교한다
const BANNED = [
  '시발', '씨발', 'ㅅㅂ', 'ㅆㅂ', '씨바', '시바', '병신', 'ㅂㅅ', '븅신', '빙신', '좆', 'ㅈ같', '존나', '졸라', 'ㅈㄴ',
  '개새', '새끼', 'ㅅㄲ', '미친', 'ㅁㅊ', '지랄', 'ㅈㄹ', '닥쳐', '꺼져', '엠창', '느금', '니애미', '니미', '애미', '애비',
  '섹스', '야동', '보지', '자지', '찐따', '장애', '틀딱', '한남', '김치녀', '또라이', '멍청', '바보', '등신', '호로',
  'fuck', 'shit', 'bitch', 'sex', 'porn', 'dick', 'pussy', 'asshole', 'bastard', 'damn', 'nigger', 'nigga', 'fck', 'stupid', 'idiot'
];
function nicknameProblem(nick) {
  if (typeof nick !== 'string') return '닉네임을 입력하세요.';
  const n = nick.trim();
  if ([...n].length < 2 || [...n].length > 8) return '닉네임은 2~8자로 입력하세요.';
  if (!/^[0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ_ ]+$/.test(n)) return '한글·영문·숫자만 쓸 수 있어요.';
  const norm = n.toLowerCase().replace(/[^a-z가-힣ㄱ-ㅎㅏ-ㅣ]/g, '');
  if (BANNED.some(b => norm.includes(b))) return '사용할 수 없는 닉네임이에요. 다른 닉네임을 써 주세요.';
  return null;
}

function suggestNickname(base, taken) {
  const chars = [...base.trim()];
  for (let k = 2; k < 100; k++) {
    const suffix = String(k);
    const cand = chars.slice(0, 8 - suffix.length).join('') + suffix;
    if (!taken.has(cand)) return cand;
  }
  return null;
}

class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

module.exports = { id, token, kstDate, kstStart, kstEnd, DAY, KST, nicknameProblem, suggestNickname, HttpError };
