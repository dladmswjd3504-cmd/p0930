'use strict';
// 공개 서버 설정(메일 없음 + 교사 인증 코드)에서 로그인 링크 발급 규칙
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voca800-auth-'));
process.env.DB_FILE = path.join(tmp, 'auth.db');
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'production';
process.env.TEACHER_ACCESS_CODE = 'sch00l-code';
const http = require('http');
const { app } = require('../server/app');

let base, server;
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };

test.before(async () => { server = http.createServer(app); await new Promise(r => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.closeAllConnections(); server.close(); });

test('config tells the login form to ask for a code', async () => {
  const r = await (await fetch(base + '/api/auth/config')).json();
  assert.equal(r.needCode, true);
});

test('wrong or missing code gets no login link', async () => {
  const a = await post('/api/auth/magic', { email: 't@school.kr' });
  assert.equal(a.status, 403);
  assert.equal(a.data.devLink, undefined);
  const b = await post('/api/auth/magic', { email: 't@school.kr', code: 'wrong' });
  assert.equal(b.status, 403);
});

test('correct code returns a working login link', async () => {
  const r = await post('/api/auth/magic', { email: 't@school.kr', code: 'sch00l-code' });
  assert.equal(r.status, 200);
  const v = await fetch(r.data.devLink.replace(/^https?:\/\/[^/]+/, base), { redirect: 'manual' });
  assert.equal(v.status, 302);
  assert.match(v.headers.get('set-cookie'), /^tsess=.*Secure/);
});

test('repeated wrong codes are rate limited', async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await post('/api/auth/magic', { email: 't@school.kr', code: 'nope' + i });
  assert.equal(last.status, 429);
});
