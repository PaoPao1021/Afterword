import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccess, passwordHash } from '../lib/access.js';
import { createApp } from '../server.js';
import { request as httpRequest } from 'node:http';

const password = 'afterword-test-password';
const hash = await passwordHash(password);
const origin = 'https://words.example';
const env = { AFTERWORD_PUBLIC_ORIGIN: origin, AFTERWORD_PASSWORD_HASH: hash };
const request = (cookie = '') => ({ method: 'GET', headers: { host: 'words.example', cookie } });

test('private deployment fails closed for incomplete or unsafe configuration', async () => {
  for (const config of [
    { HOST: '0.0.0.0' }, { HOST: '::' }, { AFTERWORD_PUBLIC_ORIGIN: origin },
    { AFTERWORD_PASSWORD_HASH: hash }, { ...env, AFTERWORD_PUBLIC_ORIGIN: 'http://words.example' },
    { ...env, AFTERWORD_PUBLIC_ORIGIN: `${origin}/path` }, { ...env, AFTERWORD_PASSWORD_HASH: 'plain-password' },
  ]) assert.throws(() => createAccess({ env: config }));
  assert.equal(createAccess().enabled, false);
  assert.equal(createAccess({ env: { ...env, HOST: '0.0.0.0' } }).enabled, true);
  await assert.rejects(passwordHash('short'));
  await assert.rejects(passwordHash('a'.repeat(257)));
});

test('remote access validates host and exact origin without trusting forwarded headers', () => {
  const access = createAccess({ env });
  access.checkRequest(request());
  for (const headers of [
    { host: 'evil.example', 'x-forwarded-host': 'words.example' },
    { host: 'words.example', origin: 'https://evil.example' },
    { host: 'words.example', 'sec-fetch-site': 'cross-site' },
  ]) assert.throws(() => access.checkRequest({ method: 'GET', headers }), { status: 403 });
  assert.throws(() => access.checkRequest({ method: 'POST', headers: { host: 'words.example' } }), { status: 403 });
  access.checkRequest({ method: 'POST', headers: { host: 'words.example', origin } });
});

test('sessions rotate, expire, revoke and never accept attacker-selected tokens', async () => {
  let time = 1000;
  const access = createAccess({ env, clock: () => time });
  assert.equal(access.authenticated(request('__Host-afterword=chosen')), false);
  const first = await access.login(password, request());
  assert.match(first, /Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200/);
  assert.equal(access.authenticated(request(first)), true);
  const second = await access.login(password, request(first));
  assert.notEqual(second, first);
  assert.equal(access.authenticated(request(first)), false);
  time += 60 * 60 * 1000;
  assert.equal(access.authenticated(request(second)), false);
  const third = await access.login(password, request());
  for (let interval = 0; interval < 23; interval++) { time += 30 * 60 * 1000; assert.equal(access.authenticated(request(third)), true); }
  time += 30 * 60 * 1000;
  assert.equal(access.authenticated(request(third)), false);
  const fourth = await access.login(password, request());
  assert.match(access.logout(request(fourth)), /Max-Age=0/);
  assert.equal(access.authenticated(request(fourth)), false);
});

test('login attempts are bounded and recover after the window', async () => {
  let time = 1000;
  const access = createAccess({ env, clock: () => time });
  for (let index = 0; index < 5; index++) await assert.rejects(access.login('incorrect', request()), { status: 401 });
  await assert.rejects(access.login(password, request()), { status: 429 });
  time += 60000;
  assert.ok(await access.login(password, request()));
});

test('private HTTP protects data, supports login/logout and denies cross-site writes', async context => {
  const { server } = createApp({ dataPath: ':memory:', access: createAccess({ env }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, options = {}) => new Promise((resolve, reject) => {
    const pending = httpRequest(base + path, { method: options.method || 'GET', headers: { Host: 'words.example', ...options.headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])) })));
    });
    pending.on('error', reject);
    pending.end(options.body?.toString());
  });
  assert.equal((await send('/')).headers.get('location'), '/login');
  for (const path of ['/api/overview', '/api/backup', '/api/llm/status']) assert.equal((await send(path)).status, 401);
  assert.equal((await send('/healthz')).status, 200);
  const loginPage = await send('/login');
  assert.equal(loginPage.headers.get('cache-control'), 'no-store');
  assert.match(loginPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok(loginPage.headers.get('strict-transport-security'));
  assert.ok(!(await loginPage.text()).includes(hash));
  assert.equal((await send('/login.css')).status, 200);
  const login = await send('/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }) });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const overview = await send('/api/overview', { headers: { Cookie: cookie } });
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).access.enabled, true);
  assert.equal((await send('/api/papers', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await send('/api/papers', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ examMonth: '2026-06' }) })).status, 200);
  assert.equal((await send('/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  assert.equal((await send('/api/backup', { headers: { Cookie: cookie } })).status, 401);
});

test('HTTP rejects oversized bodies, remains healthy, and includes safe request IDs', async context => {
  const { server } = createApp({ dataPath: ':memory:' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const body of [JSON.stringify({ padding: 'a'.repeat(130000) }), new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('a'.repeat(130000))); controller.close(); } })]) {
    const response = await fetch(base + '/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half' });
    assert.equal(response.status, 413);
    const result = await response.json();
    assert.equal(response.headers.get('x-request-id'), result.requestId);
  }
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { status: 'ok' });
  assert.equal((await fetch(base + '/api/overview')).status, 200);
});
