/* 교사 관리자: 로그인 · 방 생성/공유 · 수업 통제 · 체크표 · 리포트 · 내보내기 */
(function () {
  'use strict';
  const { $, $$, esc, store, api, Realtime, toast, GAME_NAMES, fmtKst } = App;
  const root = $('#root');
  const T = { me: null, rooms: [], stages: [], room: null, detail: null, tab: store.get('t.tab', 'students'), rt: null, filter: 'all', refreshTimer: null };
  const STATUS = { done: '완료', progress: '진행 중', absent: '미참여' };
  const LEVELS = ['', '초급', '중급', '고급'];
  const stageName = k => k === 'custom' ? '복습 퀴즈' : (T.stages.find(s => s.key === k) || {}).name || k || '-';
  const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const roomStatus = r => r.status === 'closed' ? '<span class="badge">마감</span>' : r.status === 'scheduled' ? '<span class="badge warn">시작 전</span>' : '<span class="badge good">진행 중</span>';

  function modal(html, onMount) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(back);
    const close = () => { back.remove(); document.removeEventListener('keydown', onEsc); };
    const onEsc = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onEsc);
    back.addEventListener('click', e => { if (e.target === back) close(); });
    const f = back.querySelector('input, select, textarea, button');
    if (f) f.focus();
    onMount && onMount(back.firstElementChild, close);
    return close;
  }

  // ───────── 로그인 (PRD 4.1) ─────────
  async function login(msg = '') {
    const cfg = await api('/api/auth/config').catch(() => ({}));
    root.innerHTML = `
      <div class="login-wrap">
        <div style="text-align:center;margin-bottom:1.2rem"><div style="font-size:2.6rem">🧑‍🏫</div><h1>교사 관리자 로그인</h1><p class="muted">반별 방 관리와 수행평가 자료는 교사 로그인 후 이용할 수 있어요.</p></div>
        <div class="card">
          ${cfg.google ? '<div id="gbtn" style="display:flex;justify-content:center;margin-bottom:1rem"></div><p class="muted" style="text-align:center;margin:.2rem 0 1rem">또는</p>' : ''}
          <form id="magic">
            <div class="field"><label for="email">학교 이메일</label><input id="email" class="input" type="email" autocomplete="email" required placeholder="teacher@school.kr"></div>
            <p class="error-text" id="err" role="alert">${esc(msg)}</p>
            <button class="btn primary block">로그인 링크 받기</button>
          </form>
          <div id="sent"></div>
        </div>
        <p style="text-align:center"><a href="/">← 학생 화면으로</a></p>
      </div>`;
    $('#magic').onsubmit = async e => {
      e.preventDefault();
      try {
        const r = await api('/api/auth/magic', { method: 'POST', body: { email: $('#email').value } });
        $('#sent').innerHTML = `<p style="margin-top:1rem">${r.sent ? '📧 메일로 로그인 링크를 보냈어요. 15분 안에 눌러 주세요.' : '📧 로그인 링크를 만들었어요.'}</p>
          ${r.devLink ? `<p class="muted" style="font-size:.85rem">개발 모드: 메일 발송이 설정되지 않아 링크를 바로 보여 드려요.</p><a class="btn block" href="${esc(r.devLink)}">이 링크로 로그인</a>` : ''}`;
      } catch (err) { $('#err').textContent = err.message; }
    };
    if (cfg.google) {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = () => {
        google.accounts.id.initialize({
          client_id: cfg.google,
          callback: async resp => {
            try { await api('/api/auth/google', { method: 'POST', body: { credential: resp.credential } }); boot(); }
            catch (e) { $('#err').textContent = e.message; }
          }
        });
        google.accounts.id.renderButton($('#gbtn'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ko' });
      };
      document.head.appendChild(s);
    }
  }

  // ───────── 틀 ─────────
  function shell() {
    root.innerHTML = `
      <header class="t-header">
        <span class="brand">📚 영단어 800 · 교사</span><span class="spacer"></span>
        <span class="muted">${esc(T.me.name)} (${esc(T.me.email)})</span>
        <button class="btn small" id="logout">로그아웃</button>
      </header>
      <div class="t-layout">
        <aside class="t-side">
          <button class="btn primary block" id="newRoom">＋ 새 방 만들기</button>
          <nav class="room-list" id="roomList" aria-label="방 목록"></nav>
          <button class="btn small ghost block" id="purge" style="margin-top:1rem">마감된 방 기록 모두 삭제</button>
        </aside>
        <main class="t-main" id="main"></main>
      </div>`;
    $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); };
    $('#newRoom').onclick = () => roomForm();
    $('#purge').onclick = () => modal(`
      <h2>마감된 방 기록 삭제</h2><p>마감된 모든 방과 학생 기록을 <b>영구 삭제</b>해요. 학년도 말 정리용이며 되돌릴 수 없어요.</p>
      <div class="row"><span class="spacer"></span><button class="btn" data-x>취소</button><button class="btn danger" data-ok>영구 삭제</button></div>`,
      (m, close) => {
        m.querySelector('[data-x]').onclick = close;
        m.querySelector('[data-ok]').onclick = async () => { const r = await api('/api/rooms', { method: 'DELETE' }); close(); toast(`${r.deleted}개 방을 삭제했어요.`); await loadRooms(); if (T.room && !T.rooms.some(x => x.id === T.room.id)) { T.room = null; emptyMain(); } };
      });
  }

  async function loadRooms() {
    T.rooms = (await api('/api/rooms')).rooms;
    $('#roomList').innerHTML = T.rooms.length ? T.rooms.map(r => `
      <button class="room-item" data-id="${r.id}" aria-current="${T.room && T.room.id === r.id}">
        <span class="n">${esc(r.name)}</span>
        <span class="m">${roomStatus(r)} PIN ${r.pin} · ${r.joined}명 · ${fmtKst(r.created_at).slice(0, 5)}</span>
      </button>`).join('') : '<p class="muted">아직 만든 방이 없어요.</p>';
    $$('.room-item').forEach(b => { b.onclick = () => openRoom(b.dataset.id); });
  }

  function emptyMain() {
    $('#main').innerHTML = `<div class="empty"><div style="font-size:3rem">🏫</div><h2>방을 만들어 수업을 시작하세요</h2><p>방을 만들면 PIN·링크·QR이 바로 나와요.</p><button class="btn primary" id="mk">＋ 새 방 만들기</button></div>`;
    $('#mk').onclick = () => roomForm();
  }

  // ───────── 방 생성 (PRD 4.2) ─────────
  function roomForm() {
    const today = kstToday();
    const week = new Date(Date.now() + 9 * 3600e3 + 6 * 864e5).toISOString().slice(0, 10);
    modal(`
      <h2>새 방 만들기</h2>
      <form id="rf">
        <div class="field"><label for="rname">방 이름</label><input id="rname" class="input" maxlength="30" value="2학년 3반" required></div>
        <div class="field"><span class="label">운영 방식</span>
          <div class="choice-row"><label><input type="radio" name="mode" value="class" checked> 수업용 (오늘 23:59 마감)</label><label><input type="radio" name="mode" value="period"> 기간제</label></div></div>
        <div class="form-grid" id="dates" hidden>
          <div class="field"><label for="sd">시작일</label><input id="sd" class="input" type="date" value="${today}"></div>
          <div class="field"><label for="ed">마감일</label><input id="ed" class="input" type="date" value="${week}"></div>
        </div>
        <div class="field"><span class="label">단계</span>
          <div class="choice-row"><label><input type="radio" name="lock" value="1" checked> 고정 (반 전체 같은 단어)</label><label><input type="radio" name="lock" value="0"> 학생 자유 선택</label></div></div>
        <div class="form-grid" id="lockBox">
          <div class="field"><label for="grade">학년·난이도</label><select id="grade" class="input">${T.stages.map(s => `<option value="${s.key}" ${s.key === '2-2' ? 'selected' : ''}>${s.name} (${s.count}단어)</option>`).join('')}</select></div>
          <div class="field"><span class="label">세트 범위</span><div class="row" style="flex-wrap:nowrap"><select id="sf" class="input"></select><span>~</span><select id="st" class="input"></select></div><span class="hint">세트 1개 = 20단어</span></div>
        </div>
        <div class="field"><span class="label">허용 게임</span>
          <div class="choice-row">${Object.entries(GAME_NAMES).map(([k, v]) => `<label><input type="checkbox" name="games" value="${k}" ${k === 'quiz' ? 'checked' : ''}> ${v}</label>`).join('')}</div></div>
        <div class="form-grid">
          <div class="field"><label for="pr">통과 기준 <b id="prv">80%</b></label><input id="pr" type="range" min="60" max="100" step="5" value="80"></div>
          <div class="field"><span class="label">암기 완료 필수</span><div class="choice-row"><label><input type="checkbox" id="sr" checked> 카드를 모두 확인해야 게임 시작</label></div></div>
          <div class="field"><label for="cap">정원 (1~60)</label><input id="cap" class="input" type="number" min="1" max="60" value="40"></div>
          <div class="field"><label for="ros">명단 인원 (번호 1~N)</label><input id="ros" class="input" type="number" min="0" max="60" value="30"><span class="hint">체크표 '미참여' 판정에 써요.</span></div>
        </div>
        <p class="error-text" id="rerr" role="alert"></p>
        <div class="row"><span class="spacer"></span><button type="button" class="btn" data-x>취소</button><button class="btn primary">방 만들기</button></div>
      </form>`, (m, close) => {
      const fillSets = () => {
        const s = T.stages.find(x => x.key === $('#grade', m).value);
        const opts = Array.from({ length: s.sets }, (_, i) => `<option value="${i + 1}">세트 ${i + 1}</option>`).join('');
        $('#sf', m).innerHTML = opts; $('#st', m).innerHTML = opts;
      };
      fillSets();
      $('#grade', m).onchange = fillSets;
      $('#sf', m).onchange = () => { if (+$('#st', m).value < +$('#sf', m).value) $('#st', m).value = $('#sf', m).value; };
      $$('[name=mode]', m).forEach(r => { r.onchange = () => { $('#dates', m).hidden = $('[name=mode]:checked', m).value !== 'period'; }; });
      $$('[name=lock]', m).forEach(r => { r.onchange = () => { $('#lockBox', m).hidden = $('[name=lock]:checked', m).value !== '1'; }; });
      $('#pr', m).oninput = () => { $('#prv', m).textContent = $('#pr', m).value + '%'; };
      $('[data-x]', m).onclick = close;
      $('#rf', m).onsubmit = async e => {
        e.preventDefault();
        const locked = $('[name=lock]:checked', m).value === '1';
        const body = {
          name: $('#rname', m).value, mode: $('[name=mode]:checked', m).value,
          start_date: $('#sd', m).value, end_date: $('#ed', m).value,
          stage_lock: locked ? { stage: $('#grade', m).value, setFrom: +$('#sf', m).value, setTo: +$('#st', m).value } : null,
          allowed_games: $$('[name=games]:checked', m).map(x => x.value),
          pass_rate: +$('#pr', m).value, study_required: $('#sr', m).checked,
          capacity: +$('#cap', m).value, roster_size: +$('#ros', m).value
        };
        try {
          const r = await api('/api/rooms', { method: 'POST', body });
          close();
          await loadRooms();
          T.tab = 'share';
          openRoom(r.room.id);
        } catch (err) { $('#rerr', m).textContent = err.message; }
      };
    });
  }

  // ───────── 방 상세 ─────────
  async function openRoom(id) {
    stopRt();
    const d = await api(`/api/rooms/${id}`);
    T.room = d.room; T.detail = d;
    $$('.room-item').forEach(b => b.setAttribute('aria-current', b.dataset.id === id));
    renderRoom();
    if (d.room.status !== 'closed') {
      T.rt = new Realtime({
        roomId: id, role: 'teacher',
        onMode: m => { const el = $('#rtmode'); if (el) el.innerHTML = m === 'ws' ? '<span class="dot on"></span>실시간' : m === 'poll' ? '<span class="dot on" style="background:var(--warn)"></span>실시간(폴링)' : '<span class="dot"></span>연결 중'; },
        onEvent: ev => {
          if (ev.type === 'student.device_warning') toast(`⚠ ${ev.data.seat_no}번(${ev.data.nickname})이 다른 기기에서 입장했어요.`, 5000);
          if (ev.type === 'student.joined' && !ev.data.rejoin) toast(`${ev.data.seat_no}번 ${ev.data.nickname} 입장`);
          if (['student.joined', 'student.progress', 'student.updated', 'leaderboard.updated'].includes(ev.type)) scheduleRefresh();
          if (ev.type === 'unauthorized') login('다시 로그인해 주세요.');
        }
      });
    }
  }
  function stopRt() { if (T.rt) { T.rt.stop(); T.rt = null; } }
  function scheduleRefresh() {
    clearTimeout(T.refreshTimer);
    T.refreshTimer = setTimeout(() => { if (['students', 'checklist', 'report'].includes(T.tab)) renderTab(); }, 400);
  }

  function renderRoom() {
    const r = T.room;
    const lock = r.custom_words ? `복습 퀴즈 (${r.custom_words.length}단어)` : r.stage_lock ? `${stageName(r.stage_lock.stage)} · 세트 ${r.stage_lock.setFrom}${r.stage_lock.setTo !== r.stage_lock.setFrom ? '~' + r.stage_lock.setTo : ''}` : '학생 자유 선택';
    const open = r.status === 'open';
    $('#main').innerHTML = `
      <div class="room-head">
        <h1>${esc(r.name)}</h1>${roomStatus(r)}
        <span class="pin-big" aria-label="PIN">${r.pin}</span>
        <span class="muted">${r.mode === 'class' ? '수업용' : `기간제 ~${fmtKst(r.closes_at).slice(0, 5)}`} · ${esc(lock)} · 통과 ${r.pass_rate}% · ${r.allowed_games.map(g => GAME_NAMES[g]).join(', ')}</span>
        <span class="spacer"></span><span id="rtmode" class="muted" style="font-size:.85rem"></span>
      </div>
      <div class="controls">
        <button class="btn primary" id="fsShare" ${open ? '' : 'disabled'}>📺 전체화면으로 띄우기</button>
        <a class="btn" href="/board.html?room=${r.id}" target="_blank" rel="noopener">🏆 프로젝터 모드</a>
        <button class="btn" id="startAll" ${open ? '' : 'disabled'}>▶ 게임 일제 시작</button>
        <button class="btn" id="lock" ${open ? '' : 'disabled'} aria-pressed="${r.locked}">${r.locked ? '🔒 입장 잠금 해제' : '🔓 입장 잠금'}</button>
        <span class="spacer"></span>
        <button class="btn small" id="dup">방 복제</button>
        ${open ? '<button class="btn small" id="close">방 마감</button>' : ''}
        <button class="btn small danger" id="del">기록 영구 삭제</button>
      </div>
      <div class="tabs" role="tablist">
        ${[['share', '공유'], ['students', '학생 현황'], ['checklist', '달성 체크표'], ['report', '학습 리포트'], ['export', '내보내기'], ['settings', '설정']].map(([k, v]) => `<button role="tab" data-tab="${k}" aria-selected="${T.tab === k}">${v}</button>`).join('')}
      </div>
      <div id="tab" role="tabpanel"></div>`;
    $$('[data-tab]').forEach(b => { b.onclick = () => { T.tab = b.dataset.tab; store.set('t.tab', T.tab); $$('[data-tab]').forEach(x => x.setAttribute('aria-selected', x === b)); renderTab(); }; });
    $('#fsShare').onclick = fullscreenShare;
    $('#startAll').onclick = startAll;
    $('#lock').onclick = async () => { const d = await api(`/api/rooms/${r.id}`, { method: 'PATCH', body: { locked: !r.locked } }); T.room = d.room; toast(d.room.locked ? '입장을 잠갔어요. 이미 들어온 학생은 계속할 수 있어요.' : '입장 잠금을 풀었어요.'); renderRoom(); };
    $('#dup').onclick = duplicateRoom;
    if ($('#close')) $('#close').onclick = () => confirmBox('방 마감', '지금 방을 마감할까요? 학생은 더 이상 게임을 시작할 수 없어요. 기록은 남아요.', '마감', async () => { const d = await api(`/api/rooms/${r.id}`, { method: 'PATCH', body: { close: true } }); T.room = d.room; await loadRooms(); renderRoom(); });
    $('#del').onclick = () => confirmBox('기록 영구 삭제', `'${r.name}' 방과 모든 학생 기록을 영구 삭제해요. 되돌릴 수 없어요.`, '영구 삭제', async () => { await api(`/api/rooms/${r.id}`, { method: 'DELETE' }); stopRt(); T.room = null; await loadRooms(); emptyMain(); toast('삭제했어요.'); }, true);
    renderTab();
  }

  function confirmBox(title, text, okLabel, fn, danger) {
    modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="row"><span class="spacer"></span><button class="btn" data-x>취소</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button></div>`,
      (m, close) => { $('[data-x]', m).onclick = close; $('[data-ok]', m).onclick = async () => { try { await fn(); close(); } catch (e) { toast(e.message); } }; });
  }

  function startAll() {
    const games = T.room.allowed_games;
    const go = async g => { await api(`/api/rooms/${T.room.id}/start`, { method: 'POST', body: { game_type: g } }); toast(`▶ ${GAME_NAMES[g]} 일제 시작 신호를 보냈어요.`); };
    if (games.length === 1) return confirmBox('게임 일제 시작', `입장한 학생 모두에게 ${GAME_NAMES[games[0]]}을(를) 시작시켜요.`, '시작', () => go(games[0]));
    modal(`<h2>게임 일제 시작</h2><p>어떤 게임을 시작할까요?</p><div style="display:grid;gap:.5rem">${games.map(g => `<button class="btn" data-g="${g}">${GAME_NAMES[g]}</button>`).join('')}</div>`,
      (m, close) => $$('[data-g]', m).forEach(b => { b.onclick = async () => { await go(b.dataset.g); close(); }; }));
  }

  function duplicateRoom() {
    modal(`<h2>방 복제</h2><p class="muted">지금 방 설정 그대로 새 방을 만들어요 (새 PIN 발급).</p>
      <div class="field"><label for="dn">새 방 이름</label><input id="dn" class="input" maxlength="30" value="${esc(T.room.name)}"></div>
      <p class="error-text" id="de"></p>
      <div class="row"><span class="spacer"></span><button class="btn" data-x>취소</button><button class="btn primary" data-ok>복제</button></div>`,
      (m, close) => {
        $('[data-x]', m).onclick = close;
        $('[data-ok]', m).onclick = async () => {
          try { const r = await api(`/api/rooms/${T.room.id}/duplicate`, { method: 'POST', body: { name: $('#dn', m).value } }); close(); await loadRooms(); T.tab = 'share'; openRoom(r.room.id); }
          catch (e) { $('#de', m).textContent = e.message; }
        };
      });
  }

  function fullscreenShare() {
    const d = T.detail;
    const el = document.createElement('div');
    el.className = 'fullscreen-share';
    el.innerHTML = `<button class="btn close">닫기 (Esc)</button>
      <div><div style="font-size:2rem;opacity:.8">${esc(d.room.name)} · 입장 PIN</div><div class="pin">${d.room.pin}</div>
      <img src="${d.qr}" alt="입장 QR 코드"><div class="url">${esc(d.link.replace(/^https?:\/\//, ''))}</div></div>`;
    document.body.appendChild(el);
    el.requestFullscreen && el.requestFullscreen().catch(() => {});
    const close = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); el.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    el.querySelector('.close').onclick = close;
    document.addEventListener('fullscreenchange', function h() { if (!document.fullscreenElement) { el.remove(); document.removeEventListener('fullscreenchange', h); } });
  }

  async function renderTab() {
    const el = $('#tab');
    if (!el) return;
    try {
      ({ share: tabShare, students: tabStudents, checklist: tabChecklist, report: tabReport, export: tabExport, settings: tabSettings })[T.tab](el);
    } catch (e) { el.innerHTML = `<p class="error-text">${esc(e.message)}</p>`; }
  }

  function tabShare(el) {
    const d = T.detail;
    el.innerHTML = `<div class="card share">
      <img src="${d.qr}" alt="입장 QR 코드">
      <div>
        <p class="muted" style="margin:0">입장 PIN</p><div class="pin-big" style="font-size:3rem">${d.room.pin}</div>
        <div class="field" style="margin-top:1rem"><label for="lnk">접속 링크 (PIN 포함)</label><div class="linkbox"><input id="lnk" class="input" readonly value="${esc(d.link)}"><button class="btn" id="copy">복사</button></div>
        <span class="hint">클래스룸·하이클래스에 올리면 학생이 PIN 입력 없이 바로 들어와요.</span></div>
        <button class="btn primary" id="fs2">📺 전체화면으로 띄우기</button>
      </div></div>`;
    $('#copy').onclick = async () => { try { await navigator.clipboard.writeText(d.link); toast('링크를 복사했어요.'); } catch { $('#lnk').select(); document.execCommand('copy'); toast('링크를 복사했어요.'); } };
    $('#fs2').onclick = fullscreenShare;
  }

  // ───────── 학생 현황 (수업 통제) ─────────
  async function tabStudents(el) {
    const d = await api(`/api/rooms/${T.room.id}/students`);
    const rows = d.rows.filter(r => r.student_id);
    const now = Date.now();
    el.innerHTML = `
      <div class="kpi">
        <div><b>${rows.length}</b><span>입장 / 정원 ${T.room.capacity}</span></div>
        <div><b>${rows.filter(r => r.status === 'done').length}</b><span>완료</span></div>
        <div><b>${rows.filter(r => r.playing).length}</b><span>지금 게임 중</span></div>
        <div><b>${rows.filter(r => r.device_warn_at).length}</b><span>다른 기기 경고</span></div>
      </div>
      ${d.flags.length ? `<div class="card" style="margin-bottom:1rem;border-color:var(--warn)"><h3>⚠ 확인이 필요한 기록 (랭킹 보류)</h3>
        <table class="tbl"><thead><tr><th>번호</th><th>닉네임</th><th>게임</th><th class="num">점수</th><th>사유</th><th>시각</th><th></th></tr></thead><tbody>
        ${d.flags.map(f => `<tr><td>${f.seat_no}</td><td>${esc(f.nickname)}</td><td>${stageName(f.stage)} · ${GAME_NAMES[f.game_type]}</td><td class="num">${f.score}</td><td>${esc(f.flag_reason)}</td><td>${fmtKst(f.ended_at)}</td><td><button class="btn small" data-approve="${f.id}">정상 승인</button></td></tr>`).join('')}
        </tbody></table></div>` : ''}
      ${rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>번호</th><th>닉네임</th><th>상태</th><th>암기</th><th class="num">최고 점수</th><th class="num">정답률</th><th>최근 활동</th><th>알림</th><th>타이머</th><th></th></tr></thead><tbody>
        ${rows.map(r => `<tr>
          <td>${r.seat_no}</td><td><b>${esc(r.nickname)}</b></td>
          <td><span class="badge st-${r.status}">${STATUS[r.status]}</span>${r.playing ? ' <span class="badge brand">게임 중</span>' : ''}</td>
          <td>${r.study_done ? '✔' : ''}</td><td class="num">${r.best_score ?? '-'}</td><td class="num">${r.best_accuracy !== null ? r.best_accuracy + '%' : '-'}</td>
          <td><span class="dot ${r.last_seen && now - r.last_seen < 90e3 ? 'on' : ''}"></span>${fmtKst(r.last_seen)}</td>
          <td>${r.device_warn_at ? `<span class="badge warn" title="${fmtKst(r.device_warn_at)}">다른 기기 입장</span> <button class="btn small ghost" data-clear="${r.student_id}" aria-label="경고 지우기">✕</button>` : ''}</td>
          <td><label style="display:inline-flex;gap:.3em;align-items:center"><input type="checkbox" data-timer="${r.student_id}" ${r.timer_factor > 1 ? 'checked' : ''}> 1.5배</label></td>
          <td style="white-space:nowrap"><button class="btn small" data-rename="${r.student_id}" data-nick="${esc(r.nickname)}">닉네임 변경</button> <button class="btn small danger" data-kick="${r.student_id}" data-nick="${esc(r.nickname)}">내보내기</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">아직 입장한 학생이 없어요. [공유] 탭의 QR을 띄워 주세요.</div>'}`;
    const sid = T.room.id;
    $$('[data-approve]', el).forEach(b => { b.onclick = async () => { await api(`/api/rooms/${sid}/games/${b.dataset.approve}/approve`, { method: 'POST' }); renderTab(); }; });
    $$('[data-clear]', el).forEach(b => { b.onclick = async () => { await api(`/api/rooms/${sid}/students/${b.dataset.clear}`, { method: 'PATCH', body: { clear_warning: true } }); renderTab(); }; });
    $$('[data-timer]', el).forEach(b => { b.onchange = async () => { await api(`/api/rooms/${sid}/students/${b.dataset.timer}`, { method: 'PATCH', body: { timer_factor: b.checked ? 1.5 : 1 } }); toast(b.checked ? '타이머 1.5배 여유를 적용했어요.' : '타이머를 기본으로 돌렸어요.'); }; });
    $$('[data-kick]', el).forEach(b => { b.onclick = () => confirmBox('학생 내보내기', `${b.dataset.nick} 학생을 내보낼까요? 기록은 남고, 다시 입장하면 이어서 할 수 있어요.`, '내보내기', async () => { await api(`/api/rooms/${sid}/students/${b.dataset.kick}/kick`, { method: 'POST' }); renderTab(); }, true); });
    $$('[data-rename]', el).forEach(b => {
      b.onclick = () => modal(`<h2>닉네임 강제 변경</h2><div class="field"><label for="nn">새 닉네임</label><input id="nn" class="input" maxlength="8" value="" placeholder="2~8자"></div><p class="error-text" id="ne"></p>
        <div class="row"><span class="spacer"></span><button class="btn" data-x>취소</button><button class="btn primary" data-ok>변경</button></div>`, (m, close) => {
        $('[data-x]', m).onclick = close;
        $('[data-ok]', m).onclick = async () => {
          try { await api(`/api/rooms/${sid}/students/${b.dataset.rename}`, { method: 'PATCH', body: { nickname: $('#nn', m).value } }); close(); renderTab(); }
          catch (e) { $('#ne', m).textContent = e.message; }
        };
      });
    });
  }

  // ───────── 달성 체크표 (PRD 4.5) ─────────
  async function tabChecklist(el) {
    const d = await api(`/api/rooms/${T.room.id}/students`);
    const rows = d.rows;
    const count = s => rows.filter(r => r.status === s).length;
    const shown = T.filter === 'all' ? rows : rows.filter(r => r.status === T.filter);
    el.innerHTML = `
      <div class="filters" role="group" aria-label="상태 필터">
        ${[['all', `전체 ${rows.length}`], ['done', `완료 ${count('done')}`], ['progress', `진행 중 ${count('progress')}`], ['absent', `미참여 ${count('absent')}`]].map(([k, v]) => `<button class="chip" data-f="${k}" aria-pressed="${T.filter === k}">${v}</button>`).join('')}
        <span class="spacer"></span><span class="muted" style="font-size:.85rem">완료 = 암기 완료${T.room.study_required ? '' : '(필수 아님)'} + 정답률 ${T.room.pass_rate}% 이상 1회</span>
      </div>
      <div class="table-wrap"><table class="tbl checklist"><thead><tr><th>번호</th><th>닉네임</th><th>상태</th><th>암기 완료</th><th>통과</th><th class="num">최고 점수</th><th class="num">최고 정답률</th><th>완료 시각</th><th>수동 변경</th></tr></thead><tbody>
      ${shown.map(r => `<tr class="${r.status}">
        <td>${r.seat_no}</td><td>${esc(r.nickname) || '<span class="muted">-</span>'}</td>
        <td><span class="badge st-${r.status}">${r.status === 'done' ? '✔ ' : r.status === 'progress' ? '… ' : '– '}${STATUS[r.status]}</span>${r.override ? ` <span class="badge" title="${esc(r.override.memo)}">수동</span>` : ''}</td>
        <td>${r.study_done ? '✔' : ''}</td><td>${r.passed ? '✔' : ''}</td>
        <td class="num">${r.best_score ?? ''}</td><td class="num">${r.best_accuracy !== null ? r.best_accuracy + '%' : ''}</td><td>${fmtKst(r.completed_at)}</td>
        <td><button class="btn small" data-ov="${r.seat_no}">변경</button>${r.override ? ` <span class="muted" style="font-size:.8rem">${esc(r.override.memo)}</span>` : ''}</td>
      </tr>`).join('')}
      </tbody></table></div>
      <p class="muted" style="font-size:.85rem">명단 인원(1~${T.room.roster_size}번) 기준. 명단 인원은 [설정] 탭에서 바꿀 수 있어요.</p>`;
    $$('[data-f]', el).forEach(b => { b.onclick = () => { T.filter = b.dataset.f; tabChecklist(el); }; });
    $$('[data-ov]', el).forEach(b => {
      const r = rows.find(x => x.seat_no === +b.dataset.ov);
      b.onclick = () => modal(`<h2>${r.seat_no}번 상태 수동 변경</h2>
        <p class="muted">자동 판정: ${STATUS[r.auto_status]}</p>
        <div class="field"><label for="os">상태</label><select id="os" class="input">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="om">사유 메모 (필수)</label><textarea id="om" class="input" rows="2" maxlength="200" placeholder="예: 종이 시험으로 대체">${esc(r.override ? r.override.memo : '')}</textarea></div>
        <p class="error-text" id="oe"></p>
        <div class="row">${r.override ? '<button class="btn small ghost" data-reset>자동 판정으로 되돌리기</button>' : ''}<span class="spacer"></span><button class="btn" data-x>취소</button><button class="btn primary" data-ok>저장</button></div>`,
        (m, close) => {
          $('[data-x]', m).onclick = close;
          if ($('[data-reset]', m)) $('[data-reset]', m).onclick = async () => { await api(`/api/rooms/${T.room.id}/overrides/${r.seat_no}`, { method: 'DELETE' }); close(); tabChecklist(el); };
          $('[data-ok]', m).onclick = async () => {
            try { await api(`/api/rooms/${T.room.id}/overrides/${r.seat_no}`, { method: 'PUT', body: { status: $('#os', m).value, memo: $('#om', m).value } }); close(); tabChecklist(el); }
            catch (e) { $('#oe', m).textContent = e.message; }
          };
        });
    });
  }

  // ───────── 학습 분석 리포트 (PRD 4.4) ─────────
  async function tabReport(el) {
    const d = await api(`/api/rooms/${T.room.id}/report`);
    el.innerHTML = `
      <div class="grid2">
        <section class="card">
          <div class="row"><h3 style="margin:0">오답 TOP 10</h3><span class="spacer"></span><button class="btn small primary" id="mkReview" ${d.wrong_top.length >= 6 ? '' : 'disabled'}>이 단어로 복습 퀴즈 만들기</button></div>
          <p class="muted" style="font-size:.85rem">오답률 = 오답 수 ÷ 출제 수 · 5회 이상 출제된 단어만</p>
          ${d.wrong_top.length ? `<table class="tbl"><thead><tr><th>#</th><th>단어</th><th class="num">오답률</th><th class="num">출제</th><th>가장 많이 고른 오답</th></tr></thead><tbody>
            ${d.wrong_top.map((w, i) => `<tr><td>${i + 1}</td><td><b lang="en">${esc(w.word)}</b> <span class="muted">${esc(w.meaning)}</span></td><td class="num"><b>${w.rate}%</b></td><td class="num">${w.asked}</td><td>${w.top_wrong ? `<span lang="en">${esc(w.top_wrong.word)}</span> <span class="muted">(${esc(w.top_wrong.meaning)}) ×${w.top_wrong.count}</span>` : '-'}</td></tr>`).join('')}
          </tbody></table>` : '<p class="muted">아직 데이터가 부족해요. (단어별 5회 이상 출제되면 나타나요)</p>'}
        </section>
        <section class="card">
          <h3>개인별 이력</h3>
          <p class="muted" style="font-size:.85rem">학생을 누르면 누적 오답과 점수 추이를 볼 수 있어요.</p>
          <div class="table-wrap" style="max-height:520px"><table class="tbl"><thead><tr><th>번호</th><th>닉네임</th><th>단계·게임</th><th class="num">최고</th><th class="num">최근</th><th class="num">정답률</th><th class="num">시도</th><th class="num">암기</th><th>완료</th></tr></thead><tbody>
            ${d.history.map(h => `<tr data-sid="${h.student_id}" style="cursor:pointer" tabindex="0">
              <td>${h.seat_no}</td><td><b>${esc(h.nickname)}</b></td><td>${h.stage ? `${stageName(h.stage)} · ${GAME_NAMES[h.game_type]}` : '<span class="muted">게임 기록 없음</span>'}${h.flagged ? ' <span class="badge warn">보류 ' + h.flagged + '</span>' : ''}${h.blur ? ` <span class="badge" title="게임 중 탭 이탈">이탈 ${h.blur}</span>` : ''}</td>
              <td class="num">${h.best_score ?? '-'}</td><td class="num">${h.last_score ?? '-'}</td><td class="num">${h.accuracy !== null ? h.accuracy + '%' : '-'}</td><td class="num">${h.attempts}</td><td class="num">${Math.round(h.study_sec / 60)}분</td><td>${fmtKst(h.completed_at)}</td></tr>`).join('')}
          </tbody></table></div>
        </section>
      </div>`;
    $('#mkReview').onclick = () => confirmBox('복습 퀴즈 방 만들기', `오답 TOP ${d.wrong_top.length} 단어로 새 수업용 방을 만들어요.`, '만들기', async () => { const r = await api(`/api/rooms/${T.room.id}/review-room`, { method: 'POST' }); await loadRooms(); T.tab = 'share'; openRoom(r.room.id); });
    $$('[data-sid]', el).forEach(tr => { const f = () => studentDetail(tr.dataset.sid); tr.onclick = f; tr.onkeydown = e => { if (e.key === 'Enter') f(); }; });
  }

  async function studentDetail(sid) {
    const d = await api(`/api/rooms/${T.room.id}/students/${sid}/detail`);
    const games = d.games.filter(g => g.mode === 'normal');
    modal(`
      <div class="row"><h2 style="margin:0">${d.student.seat_no}번 ${esc(d.student.nickname)}</h2><span class="spacer"></span><button class="btn small" data-x>닫기</button></div>
      <h3 style="margin-top:1rem">시도별 점수 추이</h3>
      ${games.length ? trendSvg(games) : '<p class="muted">게임 기록이 없어요.</p>'}
      <h3>누적 오답 단어 (${d.wrong.length})</h3>
      ${d.wrong.length ? `<table class="tbl"><thead><tr><th>단어</th><th>뜻</th><th class="num">틀린 횟수</th></tr></thead><tbody>${d.wrong.map(w => `<tr><td lang="en"><b>${esc(w.word)}</b></td><td>${esc(w.meaning)}</td><td class="num">${w.wrong_count}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">없어요 👍</p>'}
      <h3 style="margin-top:1rem">게임 기록</h3>
      <table class="tbl"><thead><tr><th>시각</th><th>게임</th><th class="num">점수</th><th class="num">정답</th><th>비고</th></tr></thead><tbody>
      ${d.games.map(g => `<tr><td>${fmtKst(g.ended_at)}</td><td>${g.mode === 'review' ? '오답 미니 퀴즈' : `${stageName(g.stage)} · ${GAME_NAMES[g.game_type]}`}</td><td class="num">${g.score}</td><td class="num">${g.correct}/${g.total}</td><td>${g.flagged ? `<span class="badge warn">${esc(g.flag_reason)}</span>` : ''}${g.blur_count ? ` <span class="badge">탭 이탈 ${g.blur_count}</span>` : ''}</td></tr>`).join('')}
      </tbody></table>`, (m, close) => { $('[data-x]', m).onclick = close; });
  }

  function trendSvg(games) {
    const W = 460, H = 160, P = 28;
    const max = Math.max(...games.map(g => g.score), 1);
    const x = i => P + (games.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (games.length - 1));
    const y = v => H - P - (v / max) * (H - 2 * P);
    const pts = games.map((g, i) => `${x(i)},${y(g.score)}`).join(' ');
    return `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="점수 추이: ${games.map(g => g.score).join(', ')}">
      <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="var(--line)"/>
      <text x="${P}" y="${P - 10}" font-size="11" fill="var(--muted)">최고 ${max}점</text>
      <polyline points="${pts}" fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-linejoin="round"/>
      ${games.map((g, i) => `<circle cx="${x(i)}" cy="${y(g.score)}" r="4" fill="${g.flagged ? 'var(--warn)' : 'var(--brand)'}"><title>${i + 1}회차 ${GAME_NAMES[g.game_type]} ${g.score}점</title></circle>`).join('')}
      <text x="${P}" y="${H - 8}" font-size="11" fill="var(--muted)">1회차</text><text x="${W - P}" y="${H - 8}" font-size="11" fill="var(--muted)" text-anchor="end">${games.length}회차</text>
    </svg>`;
  }

  function tabExport(el) {
    const id = T.room.id;
    el.innerHTML = `<div class="card">
      <h3>수행평가 자료 내려받기</h3>
      <p class="muted">체크표 · 개인별 이력 · 오답 TOP 10 · 나이스 입력용(번호, 상태, 점수)을 담아요. 번호↔실명 매핑은 내려받은 파일에서만 해 주세요(서버에 실명을 저장하지 않아요).</p>
      <div class="row" style="margin:1rem 0"><a class="btn primary big" href="/api/rooms/${id}/export.xlsx">📗 엑셀(.xlsx) 전체 내려받기</a></div>
      <h4>CSV로 받기</h4>
      <div class="row">
        <a class="btn" href="/api/rooms/${id}/export.csv?sheet=checklist">체크표</a>
        <a class="btn" href="/api/rooms/${id}/export.csv?sheet=history">개인별 이력</a>
        <a class="btn" href="/api/rooms/${id}/export.csv?sheet=wrong">오답 TOP 10</a>
        <a class="btn" href="/api/rooms/${id}/export.csv?sheet=neis">나이스 입력용</a>
      </div></div>`;
  }

  function tabSettings(el) {
    const r = T.room;
    el.innerHTML = `<form class="card" id="sf" style="max-width:640px">
      <div class="field"><label for="n">방 이름</label><input id="n" class="input" maxlength="30" value="${esc(r.name)}"></div>
      <div class="field"><span class="label">허용 게임</span><div class="choice-row">${Object.entries(GAME_NAMES).map(([k, v]) => `<label><input type="checkbox" name="g" value="${k}" ${r.allowed_games.includes(k) ? 'checked' : ''}> ${v}</label>`).join('')}</div></div>
      <div class="form-grid">
        <div class="field"><label for="p">통과 기준 <b id="pv">${r.pass_rate}%</b></label><input id="p" type="range" min="60" max="100" step="5" value="${r.pass_rate}"></div>
        <div class="field"><span class="label">암기 완료 필수</span><div class="choice-row"><label><input type="checkbox" id="s" ${r.study_required ? 'checked' : ''}> 켜기</label></div></div>
        <div class="field"><label for="c">정원</label><input id="c" class="input" type="number" min="1" max="60" value="${r.capacity}"></div>
        <div class="field"><label for="ro">명단 인원 (번호 1~N)</label><input id="ro" class="input" type="number" min="0" max="60" value="${r.roster_size}"></div>
      </div>
      <p class="muted" style="font-size:.85rem">단계·운영 방식은 수업 중 바꿀 수 없어요. 바꾸려면 [방 복제] 후 새로 만드세요.</p>
      <p class="error-text" id="se"></p>
      <button class="btn primary">저장</button></form>`;
    $('#p').oninput = () => { $('#pv').textContent = $('#p').value + '%'; };
    $('#sf').onsubmit = async e => {
      e.preventDefault();
      try {
        const d = await api(`/api/rooms/${r.id}`, { method: 'PATCH', body: { name: $('#n').value, allowed_games: $$('[name=g]:checked').map(x => x.value), pass_rate: +$('#p').value, study_required: $('#s').checked, capacity: +$('#c').value, roster_size: +$('#ro').value } });
        T.room = d.room; T.detail.room = d.room; toast('저장했어요.'); loadRooms(); renderRoom();
      } catch (err) { $('#se').textContent = err.message; }
    };
  }

  // ───────── 시작 ─────────
  async function boot() {
    if (location.hash === '#login-expired') { history.replaceState(null, '', location.pathname); return login('로그인 링크가 만료되었거나 이미 사용되었어요.'); }
    try { T.me = (await api('/api/me')).teacher; } catch (e) { return login(e.status === 401 ? '' : e.message); }
    T.stages = (await api('/api/stages')).stages;
    shell();
    await loadRooms();
    const open = T.rooms.find(r => r.status === 'open');
    if (open) openRoom(open.id); else emptyMain();
  }
  boot();
})();
