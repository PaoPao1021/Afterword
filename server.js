import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, AppError } from './lib/store.js';
import { createLlmService } from './lib/llm.js';
import { paperSource, sourceProfiles } from './lib/sources.js';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { createAccess, loginPage } from './lib/access.js';

const root = dirname(fileURLToPath(import.meta.url));
async function requestBody(request, limit) {
  const chunks = []; let bytes = 0;
  const oversized = () => { request.resume(); throw new AppError('请求内容过大，请分批处理', 413); };
  if (Number(request.headers['content-length']) > limit) oversized();
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) oversized();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createApp({ dataPath = join(root, 'data', 'cet6.sqlite'), llm = createLlmService(), access = createAccess() } = {}) {
  const store = new Store(dataPath);
  const server = createServer({ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (req, res) => {
    const requestId = randomUUID();
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (access.enabled) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      access.checkRequest(req);
      const url = new URL(req.url, `http://${req.headers.host}`), path = url.pathname;
      if (req.method === 'GET' && path === '/healthz') {
        store.get('SELECT 1');
        return json(200, { status: 'ok' });
      }
      if (access.enabled && path === '/login' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(loginPage());
      }
      if (access.enabled && path === '/login.css' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }); return res.end(await readFile(join(root, 'public/login.css')));
      }
      if (access.enabled && path === '/auth/login' && req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') throw new AppError('登录表单格式无效', 415);
        const form = new URLSearchParams(await requestBody(req, 4096));
        try {
          res.setHeader('Set-Cookie', await access.login(form.get('password'), req));
          res.writeHead(303, { Location: '/' }); return res.end();
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          if (error.status === 429) res.setHeader('Retry-After', '60');
          res.writeHead(error.status, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(loginPage(error.message));
        }
      }
      if (!access.authenticated(req)) {
        if (path.startsWith('/api/')) return json(401, { error: '登录已过期，请重新登录；未提交的内容仍保留在当前页面', requestId });
        res.writeHead(303, { Location: '/login' }); return res.end();
      }
      let body = {};
      if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        if (req.method !== 'DELETE' && !req.headers['content-type']?.startsWith('application/json')) throw new AppError('需要 JSON 请求', 415);
        const limit = path.startsWith('/api/backup/') ? 30_000_000 : path.startsWith('/api/import/') ? 8_000_000 : 128_000;
        const raw = await requestBody(req, limit);
        try { body = raw ? JSON.parse(raw) : {}; } catch { throw new AppError('JSON 内容无法解析'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('无效请求');
      }
      if (req.method === 'POST' && path === '/api/logout') { res.setHeader('Set-Cookie', access.logout(req)); return json(200, { loggedOut: true }); }
      if (req.method === 'GET' && path === '/api/overview') return json(200, { ...store.overview(), access: { enabled: access.enabled } });
      if (req.method === 'PUT' && path === '/api/preferences') return json(200, store.setPreferences(body));
      if (req.method === 'PUT' && /^\/api\/words\/[^/]+\/details$/.test(path)) return json(200, store.setWordDetails(decodeURIComponent(path.split('/')[3]), body));
      if (req.method === 'GET' && path === '/api/source-types') return json(200, { version: 1, profiles: sourceProfiles() });
      if (req.method === 'GET' && path === '/api/llm/status') return json(200, llm.status());
      if (req.method === 'POST' && path === '/api/llm/preview') {
        if (typeof body.paperId !== 'string' || !body.paperId || body.paperId.length > 100) throw new AppError('请先选择一套试卷');
        const source = paperSource(store.paper(body.paperId));
        const rows = await llm.extract(body.text, { source });
        return json(200, { ...store.preview({ paperId: body.paperId, rows }), generatedBy: 'model' });
      }
      if (req.method === 'POST' && path === '/api/papers') return json(200, store.createPaper(body));
      if (req.method === 'DELETE' && /^\/api\/papers\/[^/]+$/.test(path)) return json(200, store.deletePaper(decodeURIComponent(path.split('/').pop())));
      if (req.method === 'PUT' && /^\/api\/entries\/[^/]+$/.test(path)) return json(200, store.editEntry(decodeURIComponent(path.split('/').pop()), body));
      if (req.method === 'DELETE' && /^\/api\/entries\/[^/]+$/.test(path)) return json(200, store.deleteEntry(decodeURIComponent(path.split('/').pop())));
      if (req.method === 'POST' && path === '/api/import/preview') return json(200, store.preview(body));
      if (req.method === 'POST' && path === '/api/import/confirm') return json(200, store.confirmImport(body));
      if (req.method === 'POST' && path === '/api/session') return json(200, store.startSession(body));
      if (req.method === 'POST' && path === '/api/session/action') return json(200, store.sessionAction(body));
      if (req.method === 'GET' && path === '/api/backup') {
        res.setHeader('Content-Disposition', `attachment; filename="cet6-backup-${new Date().toISOString().slice(0, 10)}.json"`);
        return json(200, store.backup());
      }
      if (req.method === 'POST' && path === '/api/backup/preview') return json(200, store.validateBackup(body));
      if (req.method === 'POST' && path === '/api/backup/restore') return json(200, store.restore(body));
      const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/draft-cache.js': ['draft-cache.js', 'text/javascript; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/review.js': ['../lib/review.js', 'text/javascript; charset=utf-8'], '/word-list.js': ['../lib/word-list.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/practice.css': ['practice.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (req.method === 'GET' && assets[path]) {
        const [file, type] = assets[path]; const content = await readFile(join(root, 'public', file));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); return res.end(content);
      }
      throw new AppError('没有找到这个页面或接口', 404);
    } catch (error) {
      const expected = error instanceof AppError;
      if (!expected) console.error(JSON.stringify({ event: 'request_failed', requestId, type: error.name }));
      if (error.status === 413) res.setHeader('Connection', 'close');
      if (!res.headersSent) json(expected ? error.status : 500, { error: expected ? error.message : '处理失败，请稍后重试；请使用请求编号排查', requestId });
      else res.end();
    }
  });
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.on('close', () => store.close());
  return { server, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { loadEnvFile(join(root, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 须为 1—65535 的整数');
  const access = createAccess({ env: process.env });
  const { server } = createApp({ dataPath: process.env.CET6_DATA_PATH || join(root, 'data', 'cet6.sqlite'), access });
  server.listen(port, access.host, () => console.log(`Afterword 已启动\n${access.enabled ? 'Private: ' + access.origin : 'Local: http://127.0.0.1:' + port}\n数据保存在 ${process.env.CET6_DATA_PATH || join(root, 'data', 'cet6.sqlite')}`));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用。请访问已有服务，或使用 PORT=3211 npm start。` : error); process.exit(1); });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 150000).unref();
  });
}
