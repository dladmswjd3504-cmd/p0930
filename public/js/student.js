/* 학생 앱: 입장 → (단계 선택) → 셀프테스트 암기 → 게임 → 결과·랭킹 → 오답 재학습 */
(function () {
  'use strict';
  const { $, $$, esc, store, api, Realtime, TTS, Sound, FontSize, toast, shuffle, GAME_NAMES, GAME_ICONS } = App;
  const app = $('#app');

  const S = {
    session: store.get('session'),  // { token, roomId, pin }
    me: null, room: null, stages: null, wrongCount: 0,
    unit: null,                     // { stage, setFrom, setTo } | { custom: true }
    unitWords: [], wordMap: new Map(),
    study: null, game: null, inGame: false, screen: '', rt: null, net: 'ws', lastResult: null
  };
  const token = () => S.session && S.session.token;
  const setCache = new Map();

  // ───────── 화면 틀 ─────────
  function topbar() {
    if (!S.me) return '';
    const net = !navigator.onLine ? 'off' : S.net === 'poll' ? 'poll' : '';
    const netLabel = net === 'off' ? '오프라인' : net === 'poll' ? '연결됨(폴링)' : '연결됨';
    return `<header class="topbar">
      <span class="net ${net}" role="img" aria-label="${netLabel}" title="${netLabel}"></span>
      <div class="who">${esc(S.room.name)} <small>${S.me.seat_no}번 · ${esc(S.me.nickname)}</small></div>
      <span class="spacer"></span>
      <button class="icon-btn" data-act="fs-" aria-label="글자 작게">가-</button>
      <button class="icon-btn" data-act="fs+" aria-label="글자 크게">가+</button>
      <button class="icon-btn" data-act="mute" aria-label="효과음 ${Sound.muted ? '켜기' : '끄기'}">${Sound.muted ? '🔇' : '🔊'}</button>
    </header>`;
  }
  function render(name, html, { bar = true } = {}) {
    S.screen = name;
    app.innerHTML = (bar ? topbar() : '') + `<section class="screen" data-screen="${name}">${html}</section>`;
    const h = app.querySelector('h1, h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }
  app.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'fs-') FontSize.step(-1);
    if (a === 'fs+') FontSize.step(1);
    if (a === 'mute') { Sound.muted = !Sound.muted; b.textContent = Sound.muted ? '🔇' : '🔊'; b.setAttribute('aria-label', `효과음 ${Sound.muted ? '켜기' : '끄기'}`); }
  });
  function refreshNet() { const bar = $('.topbar', app); if (bar) bar.outerHTML = topbar(); }
  addEventListener('online', () => { refreshNet(); flushPending(); });
  addEventListener('offline', refreshNet);

  const stageLabel = u => {
    if (!u) return '';
    if (u.custom) return '복습 퀴즈';
    const st = (S.stages || []).find(s => s.key === u.stage);
    const name = st ? st.name : u.stage;
    return u.setFrom === u.setTo ? `${name} · 세트 ${u.setFrom}` : `${name} · 세트 ${u.setFrom}~${u.setTo}`;
  };

  // ───────── 홈·입장 (PRD 3.1) ─────────
  function home(msg = '', pin = '') {
    stopRealtime();
    S.me = null;
    const last = store.get('lastRoom');
    render('home', `
      <div class="hero"><div class="logo" aria-hidden="true">📚</div><h1>영단어 800</h1><p class="muted">외우고, 게임하고, 틀린 건 다시!</p></div>
      <form class="card" id="pinForm" novalidate>
        <div class="field">
          <label for="pin">선생님이 알려준 PIN 6자리</label>
          <input id="pin" class="input pin-input" inputmode="numeric" autocomplete="off" maxlength="6" pattern="[0-9]{6}" value="${esc(pin)}" placeholder="000000" aria-describedby="pinErr">
        </div>
        <p class="error-text" id="pinErr" role="alert">${esc(msg)}</p>
        <button class="btn primary block big" type="submit">입장하기</button>
      </form>
      ${last ? `<button class="btn block" id="resume">이어하기 · ${esc(last.name)} (${last.seat_no}번 ${esc(last.nickname)})</button>` : ''}
      <p class="teacher-link"><a class="btn ghost" href="/teacher.html">교사 관리자</a></p>
    `, { bar: false });
    const input = $('#pin');
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); });
    $('#pinForm').onsubmit = async e => {
      e.preventDefault();
      const p = input.value;
      if (p.length !== 6) { $('#pinErr').textContent = 'PIN은 숫자 6자리예요.'; return; }
      try { const r = await api(`/api/join/${p}`); joinForm(p, r.room); }
      catch (err) { $('#pinErr').textContent = err.message; }
    };
    if (last) $('#resume').onclick = () => joinForm(last.pin, null, last);
    if (!pin) input.focus();
  }

  async function joinForm(pin, room, prefill = {}) {
    if (!room) {
      try { room = (await api(`/api/join/${pin}`)).room; } catch (e) { return home(e.message, pin); }
    }
    render('join', `
      <div class="hero" style="padding-top:1.2rem"><h1>${esc(room.name)}</h1><p class="muted">PIN ${esc(pin)}${room.locked ? ' · <b>입장 잠김</b>' : ''}</p></div>
      <form class="card" id="joinForm" novalidate>
        <div class="field">
          <label for="seat">출석번호</label>
          <input id="seat" class="input" type="number" inputmode="numeric" min="1" max="${room.max_seat}" value="${esc(prefill.seat_no || '')}" placeholder="예: 12">
          <span class="hint">번호는 선생님만 볼 수 있어요.</span>
        </div>
        <div class="field">
          <label for="nick">닉네임 (2~8자)</label>
          <input id="nick" class="input" maxlength="8" autocomplete="off" value="${esc(prefill.nickname || '')}" placeholder="예: 영어천재">
        </div>
        <p class="error-text" id="joinErr" role="alert"></p>
        <div id="suggest"></div>
        <button class="btn primary block big" type="submit">시작하기</button>
      </form>
      <button class="btn ghost" id="back">← PIN 다시 입력</button>
    `, { bar: false });
    $('#back').onclick = () => home('', '');
    const submit = async (nickOverride) => {
      const seat = Number($('#seat').value);
      const nickname = (nickOverride || $('#nick').value).trim();
      $('#joinErr').textContent = ''; $('#suggest').innerHTML = '';
      if (!Number.isInteger(seat) || seat < 1 || seat > room.max_seat) { $('#joinErr').textContent = `출석번호는 1~${room.max_seat} 사이 숫자예요.`; return; }
      try {
        const r = await api(`/api/rooms/${pin}/join`, { method: 'POST', body: { seat_no: seat, nickname, device_token: store.get('tok:' + pin) } });
        S.session = { token: r.token, roomId: r.room.id, pin };
        store.set('session', S.session);
        store.set('tok:' + pin, r.token);
        store.set('lastRoom', { pin, name: r.room.name, seat_no: r.student.seat_no, nickname: r.student.nickname });
        if (r.resumed) toast(r.nickname_kept ? `기존 기록에 이어서 '${r.student.nickname}'(으)로 입장했어요.` : '기존 기록에 이어서 시작해요.');
        await loadMe();
        afterJoin();
      } catch (e) {
        $('#joinErr').textContent = e.message;
        if (e.code === 'DUP_NICK' && e.body.suggestion) {
          $('#suggest').innerHTML = `<button type="button" class="btn block" id="useSug" style="margin-bottom:.8rem">'${esc(e.body.suggestion)}'(으)로 입장하기</button>`;
          $('#useSug').onclick = () => { $('#nick').value = e.body.suggestion; submit(e.body.suggestion); };
        }
      }
    };
    $('#joinForm').onsubmit = e => { e.preventDefault(); submit(); };
    (prefill.seat_no ? $('#nick') : $('#seat')).focus();
  }

  async function loadMe() {
    const r = await api('/api/student/me', { token: token() });
    S.me = r.student; S.room = r.room; S.stages = r.stages; S.wrongCount = r.wrong_count;
    store.set('lastRoom', { pin: S.session.pin, name: r.room.name, seat_no: r.student.seat_no, nickname: r.student.nickname });
  }

  function leave(msg) {
    store.del('session');
    S.session = null;
    home(msg, '');
  }

  // ───────── 실시간 ─────────
  function startRealtime() {
    stopRealtime();
    S.rt = new Realtime({
      roomId: S.room.id, role: 'student', token: token(),
      onMode: m => { S.net = m; refreshNet(); },
      onEvent: onRoomEvent
    });
  }
  function stopRealtime() { if (S.rt) { S.rt.stop(); S.rt = null; } }

  function onRoomEvent(ev) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'room.started':
        if (S.inGame) return;
        if (!S.unit) { toast(`선생님이 ${GAME_NAMES[d.game_type]}을(를) 시작했어요. 단계를 골라 주세요!`); return; }
        if (S.screen === 'study' && S.study && !S.study.review) submitStudy();
        startGame(d.game_type, { teacher: true });
        break;
      case 'student.kicked':
        leave(d.reason === 'other_device' ? '다른 기기에서 같은 번호로 입장해서 이 기기는 나갔어요.' : '선생님이 방에서 내보냈어요.');
        break;
      case 'unauthorized': leave('입장 정보가 없어요. 다시 입장해 주세요.'); break;
      case 'room.deleted': leave('방이 삭제되었어요.'); break;
      case 'student.timer': S.me.timer_factor = d.timer_factor; toast(d.timer_factor > 1 ? '⏱ 타이머가 1.5배로 늘어났어요.' : '⏱ 타이머가 기본으로 돌아왔어요.'); break;
      case 'student.renamed': S.me.nickname = d.nickname; refreshNet(); toast(`선생님이 닉네임을 '${d.nickname}'(으)로 바꿨어요.`); break;
      case 'room.updated': S.room = d; break;
      case 'leaderboard.updated': if (S.screen === 'result' && S.lastResult && S.lastResult.mode === 'normal') loadLeaderboard(S.lastResult); break;
    }
  }

  function afterJoin() {
    startRealtime();
    if (S.room.custom) { S.unit = { custom: true }; return openStudy(); }
    if (S.room.stage_lock) { S.unit = { stage: S.room.stage_lock.stage, setFrom: S.room.stage_lock.setFrom, setTo: S.room.stage_lock.setTo }; return openStudy(); }
    stageSelect();
  }

  // ───────── 단계·세트 선택 (PRD 3.2) ─────────
  function stageSelect() {
    S.unit = null;
    const cards = S.stages.map(s => `
      <button class="stage-card lv${s.level}" data-stage="${s.key}">
        <span class="g">중${s.grade}</span>
        <span class="l">${['', '초급', '중급', '고급'][s.level]}</span>
        <span class="meta">${s.count}단어 · ${s.sets}세트</span>
        <span class="meta">${s.best !== null ? `최고 ${s.best}점` : '기록 없음'} ${s.passed ? '<span class="badge good">✔ 통과</span>' : ''}</span>
      </button>`).join('');
    render('stages', `
      <h2>학년·난이도를 골라요</h2>
      <div class="stage-grid">${cards}</div>
      <button class="btn block" id="mywords">📒 내 단어장 ${S.wrongCount ? `<span class="badge bad">${S.wrongCount}</span>` : ''}</button>
      <div class="actions"><button class="btn ghost" id="out">다른 방으로 나가기</button></div>
    `);
    $$('.stage-card').forEach(b => { b.onclick = () => setSelect(b.dataset.stage); });
    $('#mywords').onclick = myWords;
    $('#out').onclick = () => { store.del('lastRoom'); leave(''); };
  }

  function setSelect(stageKey) {
    const st = S.stages.find(s => s.key === stageKey);
    const items = [];
    for (let n = 1; n <= st.sets; n++) {
      const from = (n - 1) * 20 + 1, to = Math.min(st.count, n * 20);
      items.push(`<button class="set-item" data-set="${n}"><b>세트 ${n}</b><span class="muted">${to - from + 1}단어</span><span class="spacer"></span>${st.studied_sets.includes(n) ? '<span class="badge good">암기 완료</span>' : ''}<span aria-hidden="true">›</span></button>`);
    }
    render('sets', `
      <h2>${esc(st.name)} — 세트 고르기</h2>
      <p class="muted">한 세트는 20단어예요. 외운 뒤 게임에 도전해요.</p>
      <div class="set-list">${items.join('')}</div>
      <div class="actions"><button class="btn" id="back">← 단계 다시 고르기</button></div>
    `);
    $$('.set-item').forEach(b => { b.onclick = () => { S.unit = { stage: stageKey, setFrom: +b.dataset.set, setTo: +b.dataset.set }; openStudy(); }; });
    $('#back').onclick = stageSelect;
  }

  async function loadUnitWords(unit) {
    if (unit.custom) return (await api('/api/student/custom-words', { token: token() })).words;
    const out = [];
    for (let n = unit.setFrom; n <= unit.setTo; n++) {
      const k = `${unit.stage}/${n}`;
      if (!setCache.has(k)) setCache.set(k, (await api(`/api/stages/${unit.stage}/sets/${n}`)).words);
      out.push(...setCache.get(k));
    }
    return out;
  }

  async function openStudy() {
    render('loading', `<p class="muted" style="text-align:center;margin-top:3rem">단어를 불러오는 중…</p>`);
    try {
      S.unitWords = await loadUnitWords(S.unit);
      S.unitWords.forEach(w => S.wordMap.set(w.id, w));
    } catch (e) {
      render('error', `<h2>단어를 불러오지 못했어요</h2><p class="muted">${esc(e.message)}</p><div class="actions"><button class="btn primary" id="retry">다시 시도</button></div>`);
      $('#retry').onclick = openStudy;
      return;
    }
    startStudy(S.unitWords, { review: false });
  }

  // ───────── 셀프테스트 플래시카드 (PRD 3.3) ─────────
  const unitKey = () => S.unit && (S.unit.custom ? `custom:${S.room.id}` : `${S.room.id}:${S.unit.stage}:${S.unit.setFrom}-${S.unit.setTo}`);

  function startStudy(words, { review }) {
    const saved = !review ? store.get('study:' + unitKey()) : null;
    const st = {
      review, words,
      mode: store.get('studyMode', 'hideWord'),
      shuffled: false,
      queue: words.map(w => ({ w, again: false })),
      idx: 0, revealed: false,
      seen: new Set(saved ? saved.seen : []),
      known: new Set(saved ? saved.known : []),
      againAdded: new Set(),
      startedAt: Date.now(),
      prevSec: saved ? saved.sec || 0 : 0
    };
    st.seen.forEach(id => { if (!words.some(w => w.id === id)) st.seen.delete(id); });
    S.study = st;
    renderStudy();
  }

  function persistStudy() {
    const st = S.study;
    if (!st || st.review) return;
    store.set('study:' + unitKey(), { seen: [...st.seen], known: [...st.known], sec: studySec() });
  }
  const studySec = () => S.study.prevSec + Math.round((Date.now() - S.study.startedAt) / 1000);

  function exampleHtml(w, blank) {
    const t = w.example_target, i = w.example_en.indexOf(t);
    if (i < 0) return esc(w.example_en);
    const mid = blank ? `<span class="blank" aria-label="빈칸">${esc(t)}</span>` : `<b>${esc(t)}</b>`;
    return esc(w.example_en.slice(0, i)) + mid + esc(w.example_en.slice(i + t.length));
  }

  function cardHtml(item) {
    const st = S.study, w = item.w;
    const rev = st.revealed || st.mode === 'all';
    const tts = (label, text) => `<button class="tts" data-tts="${esc(text)}" data-audio="${esc(w.audio)}" aria-label="${label} 발음 듣기">🔊</button>`;
    const mean = `<div class="mean">${w.meanings.map(esc).join(', ')}</div>`;
    const wordLine = `<div class="row"><span class="word" lang="en">${esc(w.word)}</span>${tts('단어', w.word)}</div><div class="phon" lang="en">${esc(w.phonetic)}</div>`;
    const again = item.again ? '<span class="badge warn again-tag">한 번 더</span>' : '';
    let body;
    if (st.mode === 'hideWord') {
      body = `${mean}
        <div class="ex" lang="en">${exampleHtml(w, !rev)} ${rev ? tts('예문', w.example_en) : ''}</div>
        ${rev ? `<div class="reveal">${wordLine}</div>` : `<div class="hidden-slot">탭해서 영단어 확인 👆</div>`}`;
    } else if (st.mode === 'hideMeaning') {
      body = `${wordLine}
        <div class="ex"><div lang="en">${exampleHtml(w, false)} ${tts('예문', w.example_en)}</div>${rev ? `<div class="ko reveal">${esc(w.example_ko)}</div>` : ''}</div>
        ${rev ? `<div class="reveal">${mean}</div>` : `<div class="hidden-slot">탭해서 뜻 확인 👆</div>`}`;
    } else {
      body = `${wordLine}${mean}<div class="ex"><div lang="en">${exampleHtml(w, false)} ${tts('예문', w.example_en)}</div><div class="ko">${esc(w.example_ko)}</div></div>`;
    }
    return `${again}<span class="badge brand pos">${esc(w.pos)}</span>${body}`;
  }

  function renderStudy() {
    const st = S.study;
    const item = st.queue[st.idx];
    if (st.mode === 'all') markSeen(item.w.id);
    const total = st.words.length;
    const seenN = st.seen.size, knownN = [...st.known].filter(id => st.words.some(w => w.id === id)).length;
    const required = !st.review && S.room.study_required;
    const ready = !required || seenN >= total;
    const rev = st.revealed || st.mode === 'all';
    const modeBtn = (m, label) => `<button data-mode="${m}" aria-pressed="${st.mode === m}">${label}</button>`;
    render('study', `
      <div class="row"><h2 style="margin:0;font-size:1.15rem">${st.review ? '📒 오답 다시 외우기' : esc(stageLabel(S.unit))}</h2><span class="spacer"></span>
        <button class="btn small" id="shuffle" aria-pressed="${st.shuffled}">🔀 셔플 ${st.shuffled ? '켬' : '끔'}</button></div>
      <div class="mode-tabs" role="group" aria-label="카드 모드">${modeBtn('hideWord', '단어 가리기')}${modeBtn('hideMeaning', '뜻 가리기')}${modeBtn('all', '모두 보기')}</div>
      <div>
        <div class="nav-row" style="margin-bottom:.35rem"><span>확인한 카드 <b>${seenN}/${total}</b> · 알아요 <b>${knownN}</b></span><span>${st.idx + 1} / ${st.queue.length}</span></div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${seenN}"><i style="width:${(seenN / total) * 100}%"></i></div>
      </div>
      <div class="flash" id="flash" tabindex="0" role="button" aria-label="카드 — 탭하거나 스페이스로 공개">${cardHtml(item)}</div>
      ${rev ? `<div class="selfcheck"><button class="btn know" id="know">😀 알아요 <small>(1)</small></button><button class="btn unsure" id="unsure">🤔 헷갈려요 <small>(2)</small></button></div>` : ''}
      <div class="nav-row"><button class="btn small" id="prev" ${st.idx === 0 ? 'disabled' : ''}>← 이전</button><span class="muted">스와이프 · ←/→ · Space</span><button class="btn small" id="next" ${st.idx >= st.queue.length - 1 ? 'disabled' : ''}>다음 →</button></div>
      <div class="actions">
        <button class="btn primary big block" id="ready" ${ready ? '' : 'disabled'}>${st.review ? '✏️ 오답 미니 퀴즈' : '🚀 준비완료! 게임 시작'}</button>
        ${!ready ? `<p class="muted" style="text-align:center;margin:0">카드를 모두 한 번씩 확인하면 게임을 시작할 수 있어요 (${total - seenN}장 남음)</p>` : ''}
        ${!st.review && !S.room.stage_lock && !S.room.custom ? '<button class="btn ghost" id="toStages">단계 다시 고르기</button>' : ''}
        ${st.review ? '<button class="btn ghost" id="exitReview">돌아가기</button>' : ''}
      </div>
    `);
    const flash = $('#flash');
    flash.onclick = e => { if (e.target.closest('.tts')) return; reveal(); };
    $$('.tts', flash).forEach(b => { b.onclick = () => TTS.speak(b.dataset.tts, b.dataset.tts.includes(' ') ? null : b.dataset.audio); });
    $$('[data-mode]').forEach(b => { b.onclick = () => { st.mode = b.dataset.mode; store.set('studyMode', st.mode); st.revealed = false; renderStudy(); }; });
    $('#shuffle').onclick = () => {
      st.shuffled = !st.shuffled;
      const cur = st.queue.slice(st.idx);
      const main = cur.filter(q => !q.again), again = cur.filter(q => q.again);
      const base = st.shuffled ? shuffle(main) : st.words.filter(w => main.some(q => q.w.id === w.id)).map(w => ({ w, again: false }));
      st.queue = st.queue.slice(0, st.idx).concat(base, again);
      st.revealed = false; renderStudy();
    };
    if ($('#know')) $('#know').onclick = () => selfCheck(true);
    if ($('#unsure')) $('#unsure').onclick = () => selfCheck(false);
    $('#prev').onclick = () => go(-1);
    $('#next').onclick = () => go(1);
    $('#ready').onclick = st.review ? reviewQuiz : readyToPlay;
    if ($('#toStages')) $('#toStages').onclick = () => { persistStudy(); stageSelect(); };
    if ($('#exitReview')) $('#exitReview').onclick = backToMain;
    bindSwipe(flash);
  }

  function markSeen(id) { if (!S.study.seen.has(id)) { S.study.seen.add(id); persistStudy(); } }
  function reveal() {
    const st = S.study;
    if (st.mode === 'all') return;
    st.revealed = !st.revealed;
    if (st.revealed) markSeen(st.queue[st.idx].w.id);
    renderStudy();
    $('#flash').focus();
  }
  function go(d) {
    const st = S.study;
    const ni = st.idx + d;
    if (ni < 0 || ni >= st.queue.length) return;
    st.idx = ni; st.revealed = false; renderStudy(); $('#flash').focus();
  }
  function selfCheck(knew) {
    const st = S.study, item = st.queue[st.idx];
    markSeen(item.w.id);
    if (knew) st.known.add(item.w.id);
    else {
      st.known.delete(item.w.id);
      if (!item.again && !st.againAdded.has(item.w.id)) { st.againAdded.add(item.w.id); st.queue.push({ w: item.w, again: true }); }
    }
    persistStudy();
    if (st.idx < st.queue.length - 1) { st.idx++; st.revealed = false; }
    renderStudy();
    $('#flash').focus();
  }
  function bindSwipe(el) {
    let x0 = null, y0 = null;
    el.addEventListener('pointerdown', e => { x0 = e.clientX; y0 = e.clientY; });
    el.addEventListener('pointerup', e => {
      if (x0 === null) return;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) { e.preventDefault(); go(dx < 0 ? 1 : -1); el.dataset.swiped = '1'; setTimeout(() => delete el.dataset.swiped, 50); }
    });
    el.addEventListener('click', e => { if (el.dataset.swiped) e.stopImmediatePropagation(); }, true);
  }
  document.addEventListener('keydown', e => {
    if (S.screen !== 'study' || e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === ' ' && !e.target.matches('button:not(#flash)')) { e.preventDefault(); reveal(); }
    else if ((e.key === '1' || e.key === '2') && (S.study.revealed || S.study.mode === 'all')) selfCheck(e.key === '1');
  });

  function submitStudy() {
    const st = S.study;
    if (!st || st.submitted) return;
    st.submitted = true;
    const body = st.review
      ? { mode: 'review', total: st.words.length, cards_seen: st.seen.size, known_count: st.known.size, duration_sec: studySec() }
      : { ...S.unit, cards_seen: st.seen.size, known_count: [...st.known].length, duration_sec: studySec() };
    queueSend('/api/study-sessions', body);
  }

  function readyToPlay() {
    submitStudy();
    const games = S.room.allowed_games;
    if (games.length === 1) return startGame(games[0]);
    gamePick();
  }

  function gamePick() {
    const desc = {
      quiz: '단어↔뜻 4지선다 20문항 · 문항당 7초',
      match: '영단어 6개와 뜻 6개 연결 · 3라운드 · 라운드당 40초',
      flip: '카드 12장 기억 매칭 · 90초'
    };
    render('gamepick', `
      <h2>게임을 골라요</h2>
      <div class="set-list">${S.room.allowed_games.map(g => `<button class="set-item" data-game="${g}"><span style="font-size:1.6rem">${GAME_ICONS[g]}</span><span><b>${GAME_NAMES[g]}</b><br><small class="muted">${desc[g]}</small></span></button>`).join('')}</div>
      <div class="actions"><button class="btn ghost" id="back">← 암기로 돌아가기</button></div>
    `);
    $$('[data-game]').forEach(b => { b.onclick = () => startGame(b.dataset.game); });
    $('#back').onclick = () => { S.study.submitted = false; renderStudy(); };
  }

  // ───────── 게임 공통 ─────────
  async function startGame(type, { review = false, wordIds = null, teacher = false } = {}) {
    if (S.inGame) return;
    S.inGame = true;
    let g;
    try {
      g = await api('/api/games', { method: 'POST', token: token(), body: review ? { mode: 'review', word_ids: wordIds } : { game_type: type, ...S.unit } });
    } catch (e) {
      S.inGame = false;
      toast(e.offline ? '게임을 시작하려면 인터넷 연결이 필요해요.' : e.message);
      return;
    }
    S.game = { ...g, answers: [], n: 0, blur: 0, streak: 0, wrongStreak: 0, sentUpTo: 0, over: false, timers: [] };
    await countdown(teacher ? '선생님이 게임을 시작했어요!' : GAME_NAMES[g.game_type]);
    ({ quiz: runQuiz, match: runMatch, flip: runFlip })[g.game_type]();
  }

  function countdown(label) {
    return new Promise(res => {
      const el = document.createElement('div');
      el.className = 'countdown';
      el.setAttribute('role', 'alert');
      document.body.appendChild(el);
      let n = 3;
      const tick = () => {
        if (n === 0) { el.remove(); res(); return; }
        el.innerHTML = `<div><small>${esc(label)}</small>${n}</div>`;
        Sound.tick(); n--; setTimeout(tick, 700);
      };
      tick();
    });
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden && S.inGame && S.game) S.game.blur++; });

  function addAnswer(a) {
    const G = S.game;
    a.n = G.n++;
    G.answers.push(a);
    store.set('game:' + G.id, { answers: G.answers, blur: G.blur });
    if (G.answers.length - G.sentUpTo >= 5) {
      const batch = G.answers.slice(G.sentUpTo);
      G.sentUpTo = G.answers.length;
      api(`/api/games/${G.id}/answers`, { method: 'POST', token: token(), body: { answers: batch } }).catch(() => { G.sentUpTo = Math.min(G.sentUpTo, batch[0].n); });
    }
  }

  function liveScore() {
    const G = S.game;
    return Scoring.score(G.game_type, G.answers.map(a => ({ q: a.q, ok: a.ok, ms: a.ms / G.timer_factor })));
  }

  function hud(extra = '') {
    const G = S.game, sc = liveScore();
    const mult = Scoring.comboMult(G.streak);
    return `<div class="hud"><span>${extra}</span><span class="combo" aria-live="polite">${G.streak >= 2 ? `🔥${G.streak}연속${mult > 1 ? ` ×${mult}` : ''}` : ''}</span><span class="score" aria-label="점수">${sc.score.toLocaleString()}</span></div>`;
  }

  // 타이머 막대: rAF로 갱신, 끝나면 onEnd
  function timerBar(el, limitMs, onEnd) {
    const t0 = performance.now();
    let raf, stopped = false;
    const loop = () => {
      if (stopped) return;
      const left = Math.max(0, limitMs - (performance.now() - t0));
      el.firstElementChild.style.width = (left / limitMs) * 100 + '%';
      el.classList.toggle('low', left < limitMs * 0.25);
      const lab = el.nextElementSibling;
      if (lab && lab.classList.contains('tleft')) lab.textContent = Math.ceil(left / 1000) + '초';
      if (left <= 0) { stopped = true; onEnd(); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return { elapsed: () => performance.now() - t0, stop() { stopped = true; cancelAnimationFrame(raf); } };
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));

  async function lockIfNeeded() {
    const G = S.game;
    if (G.wrongStreak < 3) return;
    G.wrongStreak = 0;
    const el = document.createElement('div');
    el.className = 'lock-overlay';
    el.setAttribute('role', 'alert');
    el.innerHTML = '<div>🙅 3번 연속 틀렸어요<br><small>2초 쉬고 천천히 다시!</small></div>';
    document.body.appendChild(el);
    await wait(2000);
    el.remove();
  }

  function hit(ok) {
    const G = S.game;
    if (ok) { G.streak++; G.wrongStreak = 0; Sound.good(); }
    else { G.streak = 0; G.wrongStreak++; Sound.bad(); }
  }

  // ───────── 스피드 퀴즈 ─────────
  function decodeKey(q, nonce) { return (parseInt(q.k, 36) - q.i * 31 - nonce) / 7919 - 1; }

  async function runQuiz() {
    const G = S.game, qs = G.payload;
    const limit = Scoring.RULES.quiz.limitMs * G.timer_factor;
    for (let qi = 0; qi < qs.length; qi++) {
      const q = qs[qi];
      const correctIdx = decodeKey(q, G.nonce);
      render('game', `
        ${hud(`${qi + 1}/${qs.length}`)}
        <div class="row" style="gap:.5rem"><div class="timer" style="flex:1"><i></i></div><span class="tleft muted" style="min-width:2.5em;text-align:right"></span></div>
        <div class="prompt"><div class="p" ${q.dir === 'w2m' ? 'lang="en"' : ''}>${esc(q.prompt.text)}</div><div class="s">${esc(q.prompt.sub || '')}</div></div>
        <p class="muted" style="text-align:center;margin:0">${q.dir === 'w2m' ? '알맞은 뜻을 고르세요' : '알맞은 영단어를 고르세요'}</p>
        <div class="options">${q.options.map((o, i) => `<button class="opt" data-i="${i}" ${q.dir === 'm2w' ? 'lang="en"' : ''}><span class="k">${i + 1}</span><span>${esc(o.text)}</span><span class="mark" aria-hidden="true"></span></button>`).join('')}</div>
        <p class="feedback-line" role="status"></p>
      `, { bar: false });
      const chosen = await new Promise(res => {
        let done = false;
        const finish = v => { if (done) return; done = true; tm.stop(); document.removeEventListener('keydown', onKey); res(v); };
        const tm = timerBar($('.timer'), limit, () => finish({ i: null, ms: limit }));
        const onKey = e => { const n = Number(e.key); if (n >= 1 && n <= 4) finish({ i: n - 1, ms: tm.elapsed() }); };
        document.addEventListener('keydown', onKey);
        $$('.opt').forEach(b => { b.onclick = () => finish({ i: Number(b.dataset.i), ms: tm.elapsed() }); });
        $('.opt').focus();
      });
      const ok = chosen.i === correctIdx;
      addAnswer({ q: q.i, chosen: chosen.i === null ? null : q.options[chosen.i].id, ms: Math.round(chosen.ms), ok });
      hit(ok);
      const btns = $$('.opt');
      btns.forEach(b => { b.disabled = true; });
      btns[correctIdx].classList.add('correct');
      btns[correctIdx].querySelector('.mark').textContent = '✔';
      const fb = $('.feedback-line');
      if (!ok) {
        if (chosen.i !== null) { btns[chosen.i].classList.add('wrong'); btns[chosen.i].querySelector('.mark').textContent = '✘'; }
        fb.innerHTML = `<span style="color:var(--bad)">${chosen.i === null ? '⏰ 시간 초과!' : '✘ 틀렸어요'}</span> 정답: <b>${esc(q.options[correctIdx].text)}</b>`;
      } else fb.innerHTML = `<span style="color:var(--good)">✔ 정답!</span>`;
      $('.hud').outerHTML = hud(`${qi + 1}/${qs.length}`);
      await wait(ok ? 450 : 1000); // 오답 직후 정답 1초 표시
      await lockIfNeeded();
    }
    finishGame();
  }

  // ───────── 짝 맞추기 ─────────
  async function runMatch() {
    const G = S.game;
    const limit = Scoring.RULES.match.limitMs * G.timer_factor;
    for (const round of G.payload) {
      await new Promise(resolve => {
        const done = new Set();
        let selW = null, selM = null, busy = false, ended = false;
        render('game', `
          ${hud(`라운드 ${round.round + 1}/3`)}
          <div class="row" style="gap:.5rem"><div class="timer" style="flex:1"><i></i></div><span class="tleft muted" style="min-width:2.5em;text-align:right"></span></div>
          <p class="muted" style="margin:0;text-align:center">영단어와 뜻을 차례로 눌러 짝을 맞춰요</p>
          <div class="match-cols">
            <div class="col">${round.words.map(w => `<button class="tile" data-w="${w.id}" lang="en">${esc(w.text)}</button>`).join('')}</div>
            <div class="col">${round.meanings.map(m => `<button class="tile" data-m="${m.id}">${esc(m.text)}</button>`).join('')}</div>
          </div>
          <p class="feedback-line" role="status"></p>
        `, { bar: false });
        const endRound = () => { if (ended) return; ended = true; tm.stop(); setTimeout(resolve, 500); };
        const tm = timerBar($('.timer'), limit, endRound);
        const paint = () => {
          $$('[data-w]').forEach(b => { b.classList.toggle('sel', b.dataset.w === selW); b.classList.toggle('done', done.has(b.dataset.w)); b.disabled = done.has(b.dataset.w); });
          $$('[data-m]').forEach(b => { b.classList.toggle('sel', b.dataset.m === selM); b.classList.toggle('done', done.has(b.dataset.m)); b.disabled = done.has(b.dataset.m); });
        };
        const tryPair = async () => {
          if (!selW || !selM) return;
          busy = true;
          const ok = selW === selM;
          addAnswer({ q: round.round, word_id: selW, chosen: selM, ms: Math.round(tm.elapsed()), ok });
          hit(ok);
          const wb = $(`[data-w="${selW}"]`), mb = $(`[data-m="${selM}"]`);
          if (ok) { done.add(selW); $('.feedback-line').innerHTML = '<span style="color:var(--good)">✔ 짝 완성!</span>'; }
          else {
            wb.classList.add('wrong'); mb.classList.add('wrong');
            const right = $(`[data-m="${selW}"]`);
            right.classList.add('hint');
            $('.feedback-line').innerHTML = `<span style="color:var(--bad)">✘</span> <b lang="en">${esc(wb.textContent)}</b> = ${esc(right.textContent)}`;
            await wait(1000);
            wb.classList.remove('wrong'); mb.classList.remove('wrong'); right.classList.remove('hint');
          }
          selW = selM = null;
          $('.hud').outerHTML = hud(`라운드 ${round.round + 1}/3`);
          paint();
          if (!ok) await lockIfNeeded();
          busy = false;
          if (done.size === round.words.length) { Sound.fanfare(); endRound(); }
        };
        $$('[data-w]').forEach(b => { b.onclick = () => { if (busy || ended) return; selW = selW === b.dataset.w ? null : b.dataset.w; paint(); tryPair(); }; });
        $$('[data-m]').forEach(b => { b.onclick = () => { if (busy || ended) return; selM = selM === b.dataset.m ? null : b.dataset.m; paint(); tryPair(); }; });
        $('[data-w]').focus();
      });
    }
    finishGame();
  }

  // ───────── 카드 뒤집기 ─────────
  function runFlip() {
    const G = S.game, cards = G.payload.cards;
    const limit = Scoring.RULES.flip.limitMs * G.timer_factor;
    const done = new Set();
    let up = [], busy = false, ended = false, attempts = 0;
    render('game', `
      ${hud('<span id="att">뒤집기 0회</span>')}
      <div class="row" style="gap:.5rem"><div class="timer" style="flex:1"><i></i></div><span class="tleft muted" style="min-width:2.5em;text-align:right"></span></div>
      <div class="flip-grid">${cards.map(c => `<button class="fcard ${c.kind}" data-pos="${c.pos}" aria-label="카드 ${c.pos + 1}"><span class="in"><span class="face back" aria-hidden="true">?</span><span class="face front" ${c.kind === 'word' ? 'lang="en"' : ''}>${esc(c.text)}</span></span></button>`).join('')}</div>
      <p class="feedback-line" role="status"></p>
    `, { bar: false });
    const end = () => { if (ended) return; ended = true; tm.stop(); setTimeout(finishGame, 600); };
    const tm = timerBar($('.timer'), limit, end);
    $$('.fcard').forEach(b => {
      b.onclick = async () => {
        const pos = Number(b.dataset.pos);
        if (busy || ended || done.has(pos) || up.includes(pos)) return;
        up.push(pos);
        b.classList.add('up');
        b.setAttribute('aria-label', `카드 ${pos + 1}: ${cards[pos].text}`);
        Sound.tick();
        if (up.length < 2) return;
        busy = true;
        const [a, c] = up.map(p => cards[p]);
        const ok = a.id === c.id && a.kind !== c.kind;
        attempts++;
        addAnswer({ q: 0, a: a.pos, b: c.pos, ms: Math.round(tm.elapsed()), ok });
        hit(ok);
        const els = up.map(p => $(`.fcard[data-pos="${p}"]`));
        if (ok) { up.forEach(p => done.add(p)); els.forEach(e => e.classList.add('done')); $('.feedback-line').innerHTML = '<span style="color:var(--good)">✔ 짝 찾음!</span>'; }
        else {
          els.forEach(e => e.classList.add('miss'));
          const w = a.kind === 'word' ? a : c.kind === 'word' ? c : null;
          if (w && a.kind !== c.kind) {
            const m = cards.find(x => x.id === w.id && x.kind === 'meaning');
            $('.feedback-line').innerHTML = `<span style="color:var(--bad)">✘</span> <b lang="en">${esc(w.text)}</b> = ${esc(m.text)}`;
          } else $('.feedback-line').innerHTML = '<span style="color:var(--bad)">✘ 영단어와 뜻을 짝지어요</span>';
          await wait(900);
          els.forEach(e => { e.classList.remove('up', 'miss'); e.setAttribute('aria-label', `카드 ${Number(e.dataset.pos) + 1}`); });
        }
        up = [];
        $('.hud').outerHTML = hud(`<span id="att">뒤집기 ${attempts}회</span>`);
        busy = false;
        if (done.size === cards.length) { Sound.fanfare(); end(); }
      };
    });
    $('.fcard').focus();
  }

  // ───────── 종료·전송 (오프라인이면 기기에 저장 후 재전송) ─────────
  async function finishGame() {
    const G = S.game;
    if (G.over) return;
    G.over = true;
    const pending = { id: G.id, answers: G.answers, blur: G.blur, mode: G.mode, token: token() };
    const list = store.get('pendingFinish', []).filter(p => p.id !== G.id);
    list.push(pending);
    store.set('pendingFinish', list);
    render('sending', `<div style="text-align:center;margin-top:3rem"><p style="font-size:2rem">⏳</p><h2>결과를 보내는 중…</h2><p class="muted" id="sendMsg"></p></div>`, { bar: false });
    let tries = 0;
    while (true) {
      try {
        const r = await api(`/api/games/${G.id}/finish`, { method: 'POST', token: token(), body: { answers: G.answers, blur_count: G.blur } });
        dropPending(G.id);
        store.del('game:' + G.id);
        S.inGame = false;
        return showResult(r);
      } catch (e) {
        if (!e.offline) { dropPending(G.id); S.inGame = false; toast(e.message); return backToMain(); }
        tries++;
        const m = $('#sendMsg');
        if (m) m.textContent = '인터넷 연결이 끊겼어요. 결과는 이 기기에 저장해 두었고, 연결되면 자동으로 보내요.';
        await wait(Math.min(10000, 1500 * tries));
      }
    }
  }
  function dropPending(id) { store.set('pendingFinish', store.get('pendingFinish', []).filter(p => p.id !== id)); }

  // 앱을 다시 열었을 때 못 보낸 결과 전송
  async function flushPending() {
    for (const p of store.get('pendingFinish', [])) {
      if (S.game && S.game.id === p.id && S.inGame) continue;
      try { await api(`/api/games/${p.id}/finish`, { method: 'POST', token: p.token, body: { answers: p.answers, blur_count: p.blur } }); dropPending(p.id); toast('저장해 둔 게임 결과를 보냈어요.'); }
      catch (e) { if (!e.offline) dropPending(p.id); }
    }
    for (const q of store.get('sendQueue', [])) {
      try { await api(q.path, { method: 'POST', token: q.token, body: q.body }); store.set('sendQueue', store.get('sendQueue', []).filter(x => x.key !== q.key)); }
      catch (e) { if (!e.offline) store.set('sendQueue', store.get('sendQueue', []).filter(x => x.key !== q.key)); }
    }
  }
  function queueSend(path, body) {
    api(path, { method: 'POST', token: token(), body }).catch(e => {
      if (e.offline) store.set('sendQueue', [...store.get('sendQueue', []), { key: Date.now() + Math.random(), path, body, token: token() }]);
    });
  }

  // ───────── 결과·랭킹 (PRD 3.5) ─────────
  function showResult(r) {
    S.lastResult = r;
    const review = r.mode === 'review';
    if (r.new_best || (r.passed && !review)) Sound.fanfare();
    render('result', `
      <div class="result-hero">
        <p class="muted" style="margin:0">${review ? '오답 미니 퀴즈 (랭킹 미반영)' : `${GAME_ICONS[r.game_type]} ${GAME_NAMES[r.game_type]} · ${esc(stageLabel(S.unit))}`}</p>
        <div class="big">${r.score.toLocaleString()}<small style="font-size:1.2rem">점</small></div>
        <div class="row" style="justify-content:center;margin-top:.4rem">
          ${r.new_best ? '<span class="badge warn">🏆 내 최고 기록 갱신!</span>' : r.prev_best !== null && !review ? `<span class="badge">내 최고 ${r.prev_best}점</span>` : ''}
          ${review ? '' : r.passed ? `<span class="badge good">✔ 통과 (기준 ${r.pass_rate}%)</span>` : `<span class="badge bad">✘ 통과 기준 ${r.pass_rate}% 미달</span>`}
          ${r.flagged ? '<span class="badge warn">⚠ 기록 확인 중 — 선생님 확인 후 랭킹 반영</span>' : ''}
        </div>
      </div>
      <div class="stats">
        <div class="stat"><b>${r.accuracy}%</b><span>정답률 (${r.correct}/${r.total})</span></div>
        <div class="stat"><b>${r.max_combo}</b><span>최고 콤보</span></div>
        <div class="stat"><b>${r.rank ? `${r.rank.rank}위` : '-'}</b><span>${r.rank ? `오늘 ${r.rank.of}명 중` : '순위'}</span></div>
      </div>
      ${review ? '' : `<section><h3>오늘의 TOP 10 <small class="muted">(${GAME_NAMES[r.game_type]})</small></h3><ol class="lb" id="lb"><li class="muted">불러오는 중…</li></ol><p id="myrank" class="muted"></p></section>`}
      <div class="actions">
        ${r.wrong.length ? `<button class="btn primary big" id="wrongNote">📒 오답노트 보기 (${r.wrong.length})</button>` : ''}
        ${review ? '' : `<button class="btn ${r.wrong.length ? '' : 'primary big'}" id="again">🔁 다시 도전</button>`}
        ${!review && S.room.allowed_games.length > 1 ? '<button class="btn" id="other">다른 게임</button>' : ''}
        <button class="btn ghost" id="toMain">${review ? '돌아가기' : '암기 화면으로'}</button>
      </div>
    `);
    if (!review) loadLeaderboard(r);
    if ($('#wrongNote')) $('#wrongNote').onclick = () => wrongNote(r);
    if ($('#again')) $('#again').onclick = () => startGame(r.game_type);
    if ($('#other')) $('#other').onclick = gamePick;
    $('#toMain').onclick = backToMain;
  }

  async function loadLeaderboard(r) {
    try {
      const lb = await api(`/api/rooms/${S.room.id}/leaderboard?stage=${encodeURIComponent(r.stage)}&game=${r.game_type}`, { token: token() });
      const el = $('#lb');
      if (!el) return;
      el.innerHTML = lb.top.length ? lb.top.map(x => `<li class="${x.me ? 'me' : ''}"><span class="rk">${['🥇', '🥈', '🥉'][x.rank - 1] || x.rank}</span><span>${esc(x.nickname)}${x.me ? ' (나)' : ''}</span><span class="sc">${x.score.toLocaleString()}</span></li>`).join('') : '<li class="muted">아직 기록이 없어요.</li>';
      $('#myrank').textContent = lb.me && lb.me.rank > 10 ? `내 순위: ${lb.me.rank}위 / ${lb.me.of}명 · ${lb.me.score}점` : '';
    } catch {}
  }

  // ───────── 오답노트·재학습 (PRD 3.6) ─────────
  function wrongNote(r) {
    render('wrong', `
      <h2>📒 오답노트</h2>
      <p class="muted">내가 고른 답과 정답을 비교해 봐요.</p>
      <div class="wrong-list">${r.wrong.map(w => `
        <div class="wrong-item">
          <div class="w" lang="en">${esc(w.word)} <span class="muted" style="font-weight:600;font-size:.95rem">${esc(w.meaning)}</span></div>
          <div class="pair">${w.chosen ? `<span class="x">✘ 내가 고른 답: <span lang="en">${esc(w.chosen.word)}</span> (${esc(w.chosen.meaning)})</span>` : '<span class="x">✘ 시간 초과</span>'}</div>
          <div class="pair"><span class="o">✔ 정답: <span lang="en">${esc(w.word)}</span> = ${esc(w.meaning)}</span></div>
        </div>`).join('')}</div>
      <div class="actions">
        <button class="btn primary big" id="relearn">📖 오답만 다시 외우기</button>
        <button class="btn ghost" id="back">← 결과로</button>
      </div>
    `);
    $('#relearn').onclick = () => reviewStudy([...new Set(r.wrong.map(w => w.word_id))]);
    $('#back').onclick = () => showResult(r);
  }

  async function reviewStudy(ids) {
    let words = ids.map(id => S.wordMap.get(id));
    if (words.some(w => !w)) {
      try { (await api('/api/student/wrong-words', { token: token() })).words.forEach(w => S.wordMap.set(w.id, w)); } catch {}
      words = ids.map(id => S.wordMap.get(id)).filter(Boolean);
    }
    if (!words.length) return toast('복습할 단어가 없어요.');
    S.returnUnit = S.unit;
    startStudy(words, { review: true });
  }

  function reviewQuiz() {
    submitStudy();
    startGame('quiz', { review: true, wordIds: S.study.words.map(w => w.id) });
  }

  async function myWords() {
    let words = [];
    try { words = (await api('/api/student/wrong-words', { token: token() })).words; } catch (e) { return toast(e.message); }
    words.forEach(w => S.wordMap.set(w.id, w));
    render('mywords', `
      <h2>📒 내 단어장</h2>
      <p class="muted">게임에서 틀린 단어가 쌓여요. 이후 두 번 연속 맞히면 자동으로 빠져요.</p>
      ${words.length ? `<div class="wrong-list">${words.map(w => `<div class="wrong-item"><div class="w"><span lang="en">${esc(w.word)}</span> <span class="muted" style="font-weight:600">${esc(w.meanings.join(', '))}</span></div><div class="pair muted">틀린 횟수 ${w.wrong_count} · 연속 정답 ${w.streak_correct}/2</div></div>`).join('')}</div>` : '<div class="card muted" style="text-align:center">아직 틀린 단어가 없어요 👍</div>'}
      <div class="actions">
        ${words.length ? `<button class="btn primary big" id="study">📖 내 단어장 외우기 (${Math.min(words.length, 40)}개)</button>` : ''}
        <button class="btn ghost" id="back">← 돌아가기</button>
      </div>
    `);
    if ($('#study')) $('#study').onclick = () => reviewStudy(words.slice(0, 40).map(w => w.id));
    $('#back').onclick = backToMain;
  }

  async function backToMain() {
    S.inGame = false;
    try { await loadMe(); } catch (e) { if (e.status === 401 || e.status === 410) return leave(e.message); }
    if (S.returnUnit) { S.unit = S.returnUnit; S.returnUnit = null; }
    if (S.unit && S.unitWords.length) return startStudy(S.unitWords, { review: false });
    if (S.room.custom || S.room.stage_lock) return afterJoin();
    stageSelect();
  }

  // ───────── 시작 ─────────
  async function boot() {
    TTS.init();
    const pin = new URLSearchParams(location.search).get('pin') || '';
    flushPending();
    if (S.session && (!pin || pin === S.session.pin)) {
      try { await loadMe(); return afterJoin(); }
      catch (e) {
        if (e.offline) return home('인터넷 연결을 확인해 주세요.', S.session.pin);
        store.del('session'); S.session = null;
        if (pin) return joinForm(pin);
        return home(e.status === 410 ? e.message : '', '');
      }
    }
    if (/^\d{6}$/.test(pin)) {
      history.replaceState(null, '', '/');
      return joinForm(pin);
    }
    home();
  }
  boot();
})();
