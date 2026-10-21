import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from './errors.js';

const derive = promisify(scrypt);
const cookieName = '__Host-afterword';
const sessionLifetime = 12 * 60 * 60 * 1000;
const idleLifetime = 60 * 60 * 1000;
const hashPattern = /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const scryptOptions = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 256) throw new Error('密码须至少 12 个字符，最多 256 字节');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, scryptOptions);
  return `scrypt$131072$8$1$${salt}$${key.toString('hex')}`;
}

export function createAccess({ env = {}, clock = Date.now } = {}) {
  const origin = env.AFTERWORD_PUBLIC_ORIGIN?.trim() || '';
  const hash = env.AFTERWORD_PASSWORD_HASH?.trim() || '';
  let publicUrl;
  if (origin || hash) {
    try {
      publicUrl = new URL(origin);
      if (publicUrl.protocol !== 'https:' || publicUrl.origin !== origin || !hashPattern.test(hash)) throw new Error();
    } catch { throw new Error('远程模式必须同时配置纯 HTTPS origin 和有效 AFTERWORD_PASSWORD_HASH；拒绝无认证启动'); }
  }
  const host = env.HOST || '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(host) || (host !== '127.0.0.1' && !publicUrl)) throw new Error('非本机监听必须先配置 HTTPS 与登录密码');
  const sessions = new Map();
  let attempts = 0, windowEnd = 0, authenticating = false;
  const cookie = (token, seconds) => `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
  const tokenOf = request => (request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  function checkRequest(request) {
    const requestHost = request.headers.host || '';
    if (publicUrl ? requestHost !== publicUrl.host : !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(requestHost)) throw new AppError('不允许此访问地址', 403);
    const expectedOrigin = origin || `http://${requestHost}`;
    const writes = !['GET', 'HEAD'].includes(request.method);
    if ((request.headers.origin && request.headers.origin !== expectedOrigin) || (publicUrl && writes && request.headers.origin !== expectedOrigin) || request.headers['sec-fetch-site'] === 'cross-site') throw new AppError('不允许跨站请求', 403);
  }
  function authenticated(request) {
    if (!publicUrl) return true;
    const token = tokenOf(request), session = sessions.get(token);
    if (!session) return false;
    const time = clock();
    if (session.expires <= time || session.touched + idleLifetime <= time) { sessions.delete(token); return false; }
    session.touched = time;
    return true;
  }
  async function login(password, request) {
    if (!publicUrl) throw new AppError('本机模式无需登录', 400);
    if (clock() >= windowEnd) { attempts = 0; windowEnd = clock() + 60000; }
    if (attempts >= 5 || authenticating) throw new AppError('登录尝试过于频繁，请一分钟后再试', 429);
    attempts++;
    if (typeof password !== 'string' || Buffer.byteLength(password) > 256) throw new AppError('密码不正确', 401);
    authenticating = true;
    try {
      const [, salt, expected] = hash.match(hashPattern);
      const actual = await derive(password, salt, 64, scryptOptions);
      if (!timingSafeEqual(actual, Buffer.from(expected, 'hex'))) throw new AppError('密码不正确', 401);
      for (const [token, session] of sessions) if (session.expires <= clock() || session.touched + idleLifetime <= clock()) sessions.delete(token);
      sessions.delete(tokenOf(request));
      if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
      const token = randomBytes(32).toString('hex');
      sessions.set(token, { expires: clock() + sessionLifetime, touched: clock() });
      return cookie(token, sessionLifetime / 1000);
    } finally { authenticating = false; }
  }
  function logout(request) { sessions.delete(tokenOf(request)); return cookie('', 0); }
  return { enabled: !!publicUrl, origin, host, checkRequest, authenticated, login, logout };
}

export function loginPage(message = '') {
  const safeMessage = message.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · Afterword</title><link rel="stylesheet" href="/login.css"></head><body><main><p class="brand">AFTERWORD</p><h1>回到你的词库</h1><p>这是你的私人学习空间。登录后，在电脑与 Pad 继续学习。</p><form action="/auth/login" method="post"><label for="password">访问密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required autofocus><p role="alert">${safeMessage}</p><button type="submit">进入学习</button></form><small>登录状态最长保留 12 小时，闲置 1 小时后需重新登录。</small></main></body></html>`;
}
