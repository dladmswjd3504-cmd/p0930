/* 학생·교사·프로젝터 화면 공통 유틸 */
(function () {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} }
  };

  const SERVER_HINT = '앱 서버에 연결되지 않았어요. start.bat으로 서버를 켠 뒤 http://localhost:3000 주소로 접속해 주세요. (파일을 직접 열거나 Live Server로 열면 작동하지 않아요)';

  class ApiError extends Error {
    constructor(status, body) { super(body.error || '요청을 처리하지 못했어요.'); this.status = status; this.code = body.code; this.body = body; }
  }

  async function api(path, { method = 'GET', body, token, timeout = 10000 } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers['x-student-token'] = token;
    try {
      const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal, credentials: 'same-origin' });
      const isJson = res.headers.get('content-type')?.includes('json');
      // JSON이 아닌 응답 = 앱 서버가 아닌 곳(Live Server·파일 미리보기 등)에서 페이지를 연 경우
      if (!isJson && path.startsWith('/api/')) throw new ApiError(0, { error: SERVER_HINT, code: 'NO_APP_SERVER' });
      const data = isJson ? await res.json() : {};
      if (!res.ok) throw new ApiError(res.status, data);
      return data;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (location.protocol === 'file:') throw new ApiError(0, { error: SERVER_HINT, code: 'NO_APP_SERVER' });
      const err = new ApiError(0, { error: '서버에 연결할 수 없어요. 서버(start.bat)가 켜져 있는지, 인터넷 연결을 확인해 주세요.', code: 'NETWORK' });
      err.offline = true;
      throw err;
    } finally { clearTimeout(t); }
  }

  // 실시간: WebSocket 우선, 막히면(학교 방화벽 등) 폴링으로 자동 전환
  class Realtime {
    constructor({ roomId, role, token, onEvent, onMode }) {
      Object.assign(this, { roomId, role, token, onEvent, onMode });
      this.seq = 0; this.mode = 'connecting'; this.stopped = false; this.wsFails = 0;
      this.connect();
    }
    setMode(m) { if (this.mode !== m) { this.mode = m; this.onMode && this.onMode(m); } }
    connect() {
      if (this.stopped) return;
      if (this.wsFails >= 2 || !('WebSocket' in window)) return this.poll();
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const q = new URLSearchParams({ room: this.roomId, role: this.role });
      if (this.token) q.set('token', this.token);
      let opened = false;
      const ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
      this.ws = ws;
      const guard = setTimeout(() => { if (!opened) ws.close(); }, 4000);
      ws.onopen = () => { opened = true; clearTimeout(guard); this.wsFails = 0; this.setMode('ws'); };
      ws.onmessage = m => {
        const ev = JSON.parse(m.data);
        if (ev.type === 'hello') { if (!this.seq) this.seq = ev.seq; else this.catchUp(); return; }
        if (ev.seq <= this.seq) return;
        this.seq = ev.seq;
        this.onEvent(ev);
      };
      ws.onclose = e => {
        clearTimeout(guard);
        if (this.stopped) return;
        if (e.code === 4001) { this.onEvent({ type: 'unauthorized' }); return; }
        if (!opened) this.wsFails++;
        this.setMode('reconnecting');
        setTimeout(() => this.connect(), opened ? 1000 : 300);
      };
    }
    async catchUp() {
      try {
        const r = await api(`/api/rooms/${this.roomId}/events?since=${this.seq}`, { token: this.token });
        r.events.forEach(ev => { if (ev.seq > this.seq) { this.seq = ev.seq; this.onEvent(ev); } });
        this.seq = Math.max(this.seq, r.seq);
      } catch (e) { if (e.status === 401) this.onEvent({ type: 'unauthorized' }); }
    }
    async poll() {
      this.setMode('poll');
      while (!this.stopped) {
        try {
          const r = await api(`/api/rooms/${this.roomId}/events?since=${this.seq}`, { token: this.token });
          if (!this.seq && !this.primed) { this.primed = true; this.seq = r.seq; }
          else r.events.forEach(ev => { if (ev.seq > this.seq) { this.seq = ev.seq; this.onEvent(ev); } });
          this.seq = Math.max(this.seq, r.seq);
        } catch (e) {
          if (e.status === 401) { this.onEvent({ type: 'unauthorized' }); return; }
        }
        await new Promise(res => setTimeout(res, 1000));
      }
    }
    stop() { this.stopped = true; if (this.ws) this.ws.close(); }
  }

  // TTS: Web Speech API(en-US) → 미지원 시 미리 만든 음성 파일
  const TTS = {
    voice: null,
    init() {
      if (!('speechSynthesis' in window)) return;
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        this.voice = vs.find(v => v.lang === 'en-US' && /Google|Samantha|Aria|Jenny|Zira/i.test(v.name)) || vs.find(v => v.lang === 'en-US') || vs.find(v => v.lang.startsWith('en')) || null;
      };
      pick();
      speechSynthesis.onvoiceschanged = pick;
    },
    speak(text, audioFile) {
      if ('speechSynthesis' in window && (this.voice || speechSynthesis.getVoices().length)) {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'en-US'; u.rate = 0.9;
        if (this.voice) u.voice = this.voice;
        speechSynthesis.speak(u);
        return;
      }
      if (audioFile) new Audio('/audio/' + audioFile).play().catch(() => toast('이 기기에서는 발음을 들을 수 없어요.'));
    }
  };

  // 짧은 효과음(WebAudio), 음소거 가능
  const Sound = {
    ctx: null,
    get muted() { return store.get('muted', false); },
    set muted(v) { store.set('muted', !!v); },
    beep(freqs, dur = 0.09, type = 'sine') {
      if (this.muted) return;
      try {
        this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
        let t = this.ctx.currentTime;
        freqs.forEach(f => {
          const o = this.ctx.createOscillator(), g = this.ctx.createGain();
          o.type = type; o.frequency.value = f;
          g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
          o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + dur);
          t += dur * 0.9;
        });
      } catch {}
    },
    good() { this.beep([660, 880]); },
    bad() { this.beep([220, 180], 0.12, 'square'); },
    tick() { this.beep([520], 0.05); },
    fanfare() { this.beep([523, 659, 784, 1047], 0.12); }
  };

  // 글자 크기 조절(접근성)
  const FontSize = {
    levels: [0.9, 1, 1.15, 1.3],
    apply() { document.documentElement.style.fontSize = (16 * this.levels[store.get('fs', 1)]) + 'px'; },
    step(d) { store.set('fs', Math.max(0, Math.min(this.levels.length - 1, store.get('fs', 1) + d))); this.apply(); }
  };
  FontSize.apply();

  let toastTimer;
  function toast(msg, ms = 2600) {
    let el = $('#toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const GAME_NAMES = { quiz: '스피드 퀴즈', match: '짝 맞추기', flip: '카드 뒤집기' };
  const GAME_ICONS = { quiz: '⚡', match: '🔗', flip: '🃏' };
  const fmtKst = ts => ts ? new Date(ts + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ').replace('-', '/') : '';

  window.App = { $, $$, esc, store, api, ApiError, Realtime, TTS, Sound, FontSize, toast, shuffle, GAME_NAMES, GAME_ICONS, fmtKst };
})();
