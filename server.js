import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, AppError } from './lib/store.js';
import { createLlmService } from './lib/llm.js';
import { paperSource, sourceProfiles } from './lib/sources.js';
import { loadEnvFile } from 'node:process';

const root = dirname(fileURLToPath(import.meta.url));
export function createApp({ dataPath = join(root, 'data', 'cet6.sqlite'), llm = createLlmService() } = {}) {
  const store = new Store(dataPath);
  const server = createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new AppError('仅支持本机访问', 403);
      if (req.headers.origin && ![`http://${host}`].includes(req.headers.origin)) throw new AppError('不允许跨站请求', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('不允许跨站请求', 403);
      const url = new URL(req.url, `http://${host}`), path = url.pathname;
      let body = {};
      if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        if (req.method !== 'DELETE' && !req.headers['content-type']?.startsWith('application/json')) throw new AppError('需要 JSON 请求', 415);
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 30_000_000) throw new AppError('请求超过 30 MB，请分批处理', 413); chunks.push(chunk); }
        const raw = Buffer.concat(chunks).toString('utf8');
        try { body = raw ? JSON.parse(raw) : {}; } catch { throw new AppError('JSON 内容无法解析'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('无效请求');
      }
      if (req.method === 'GET' && path === '/api/overview') return json(200, store.overview());
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
      const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/review.js': ['../lib/review.js', 'text/javascript; charset=utf-8'], '/word-list.js': ['../lib/word-list.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/practice.css': ['practice.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (req.method === 'GET' && assets[path]) {
        const [file, type] = assets[path]; const content = await readFile(join(root, 'public', file));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); return res.end(content);
      }
      throw new AppError('没有找到这个页面或接口', 404);
    } catch (error) {
      if (!(error instanceof AppError)) console.error(error);
      if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : '保存失败，请稍后重试；已有数据未被覆盖' });
      else res.end();
    }
  });
  server.on('close', () => store.close());
  return { server, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { loadEnvFile(join(root, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const port = Number(process.env.PORT || 3210);
  const { server } = createApp({ dataPath: process.env.CET6_DATA_PATH || join(root, 'data', 'cet6.sqlite') });
  server.listen(port, '127.0.0.1', () => console.log(`Afterword 已启动\nLocal: http://127.0.0.1:${port}\n数据保存在 ${process.env.CET6_DATA_PATH || join(root, 'data', 'cet6.sqlite')}`));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用。请访问已有服务，或使用 PORT=3211 npm start。` : error); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
