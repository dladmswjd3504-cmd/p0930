/* 점수 규칙 — 서버(재계산)와 브라우저(즉시 표시)가 같은 파일을 쓴다. PRD 3.4 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Scoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RULES = {
    quiz:  { questions: 20, limitMs: 7000,  base: 100, perSec: 10 },
    match: { rounds: 3, pairs: 6, limitMs: 40000, base: 80, perSec: 10 },
    flip:  { pairs: 6, limitMs: 90000, base: 100, flipBonusPerSaved: 20, flipBonusFreeAttempts: 18 }
  };

  // 3연속 정답부터 ×1.2, 5연속부터 ×1.5
  function comboMult(streak) { return streak >= 5 ? 1.5 : streak >= 3 ? 1.2 : 1; }

  // answers: [{q, ok, ms}] — ms는 타이머 배율로 정규화된 값(quiz: 문항 내 경과, match: 라운드 내 경과, flip: 게임 내 경과)
  function score(type, answers) {
    var s = 0, streak = 0, maxCombo = 0, correct = 0, wrong = 0;
    var r = RULES[type];
    function hit(base) { streak++; if (streak > maxCombo) maxCombo = streak; correct++; s += Math.round(base * comboMult(streak)); }
    function miss() { streak = 0; wrong++; }

    if (type === 'quiz') {
      answers.forEach(function (a) {
        if (a.ok) hit(r.base + Math.floor(Math.max(0, r.limitMs - a.ms) / 1000) * r.perSec);
        else miss();
      });
      return { score: s, correct: correct, total: r.questions, maxCombo: maxCombo };
    }

    if (type === 'match') {
      for (var round = 0; round < r.rounds; round++) {
        var ra = answers.filter(function (a) { return a.q === round; });
        var got = 0, last = 0;
        ra.forEach(function (a) {
          if (a.ok) { hit(r.base); got++; last = a.ms; } else miss();
        });
        if (got === r.pairs) s += Math.floor(Math.max(0, r.limitMs - last) / 1000) * r.perSec;
      }
      // 정답률 = 맞힌 짝 ÷ (전체 짝 + 틀린 시도)
      return { score: s, correct: correct, total: r.rounds * r.pairs + wrong, maxCombo: maxCombo };
    }

    if (type === 'flip') {
      var attempts = 0;
      answers.forEach(function (a) { attempts++; if (a.ok) hit(r.base); else miss(); });
      if (correct === r.pairs) s += Math.max(0, r.flipBonusFreeAttempts - attempts) * r.flipBonusPerSaved;
      // 기억 게임은 헛뒤집기가 자연스러우므로 정답률 = 찾은 짝 ÷ 6
      return { score: s, correct: correct, total: r.pairs, maxCombo: maxCombo, attempts: attempts };
    }
    throw new Error('unknown game type ' + type);
  }

  function maxScore(type) {
    var r = RULES[type], a = [], i;
    if (type === 'quiz') for (i = 0; i < r.questions; i++) a.push({ q: i, ok: true, ms: 0 });
    if (type === 'match') for (i = 0; i < r.rounds * r.pairs; i++) a.push({ q: Math.floor(i / r.pairs), ok: true, ms: 0 });
    if (type === 'flip') for (i = 0; i < r.pairs; i++) a.push({ q: 0, ok: true, ms: 0 });
    return score(type, a).score;
  }

  return { RULES: RULES, comboMult: comboMult, score: score, maxScore: maxScore };
});
