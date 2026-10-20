import { AppError } from './errors.js';
import { extractionInstructions } from './sources.js';

export const MAX_SOURCE_LENGTH = 20000;
const MAX_RESPONSE_BYTES = 1_000_000;

function readConfig(env) {
  const enabled = env.LLM_ENABLED === 'true';
  const provider = env.LLM_PROVIDER?.trim() || 'openai-compatible';
  const baseUrl = env.LLM_BASE_URL?.trim() || '';
  const model = env.LLM_MODEL?.trim() || '';
  const apiKey = env.LLM_API_KEY?.trim() || '';
  const timeoutMs = Number(env.LLM_TIMEOUT_MS || 45000);
  const missing = [['LLM_BASE_URL', baseUrl], ['LLM_MODEL', model], ['LLM_API_KEY', apiKey]].filter(([, value]) => !value).map(([key]) => key);
  let endpoint, issue = '';
  if (provider !== 'openai-compatible') issue = '暂不支持该接口协议，请使用 openai-compatible。';
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) issue = 'LLM_TIMEOUT_MS 应为 1000—120000 毫秒。';
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw new Error();
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
      endpoint = url.href;
    } catch { issue = 'LLM_BASE_URL 需为 HTTPS 服务根地址；本机服务可用 HTTP，不可包含密钥、查询参数或片段。'; }
  }
  return { enabled, provider, model, apiKey, timeoutMs, missing, endpoint, issue };
}

async function responseJson(response) {
  if (!response.body) throw new AppError('模型服务返回了空响应，请稍后重试。', 502);
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AppError('模型返回内容过大，请缩短原文后重试。', 502);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('模型服务没有返回有效 JSON，请检查接口协议。', 502); }
}

function parseWords(result) {
  const choice = result?.choices?.[0];
  if (choice?.finish_reason === 'length') throw new AppError('模型结果被截断，请缩短原文后重试。', 502);
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new AppError('模型未能处理这段原文，可改用手动录入。', 502);
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new AppError('模型没有返回词条，请检查模型是否支持文本对话。', 502);
  let parsed;
  try { parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1')); }
  catch { throw new AppError('模型返回的词条格式不正确，请重试或手动录入。', 502); }
  if (!Array.isArray(parsed?.words) || parsed.words.length > 100) throw new AppError('模型结果应包含最多 100 个词条。', 502);
  if (!parsed.words.length) throw new AppError('没有整理出词条，请检查原文是否包含英文。', 422);
  return parsed.words.map((word, index) => {
    if (typeof word?.english !== 'string' || !word.english.trim() || word.english.length > 300 || /[\r\n\t]/.test(word.english) || typeof word.meaning !== 'string' || !word.meaning.trim() || word.meaning.length > 5000) {
      throw new AppError(`模型返回的第 ${index + 1} 个词条不完整或过长，请重试。`, 502);
    }
    return { english: word.english.trim(), meaning: word.meaning.trim() };
  });
}

// A provider adapter: input is source text; output is validated, unsaved word rows.
// Future providers can implement this contract without changing import/storage.
export function createLlmService({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = readConfig(env);
  let pending = false;
  function status() {
    let state = 'ready', message = '已配置，整理结果需要核对后保存。';
    if (!config.enabled) { state = 'disabled'; message = '接口已预留，暂未启用。'; }
    else if (config.issue) { state = 'invalid'; message = config.issue; }
    else if (config.missing.length) { state = 'unconfigured'; message = `尚未配置：${config.missing.join('、')}`; }
    return { state, ready: state === 'ready', provider: config.provider, model: config.model, serviceOrigin: config.endpoint ? new URL(config.endpoint).origin : '', message, maxSourceLength: MAX_SOURCE_LENGTH };
  }
  async function extract(text, { source } = {}) {
    const current = status();
    if (!current.ready) throw new AppError(current.message, 503);
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_SOURCE_LENGTH) throw new AppError(`请提供 1—${MAX_SOURCE_LENGTH} 字符的英文原文。`);
    const instructions = extractionInstructions(source);
    if (pending) throw new AppError('已有整理请求进行中，请稍后再试。', 429);
    pending = true;
    const signal = AbortSignal.timeout(config.timeoutMs);
    try {
      const response = await fetchImpl(config.endpoint, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, stream: false, max_completion_tokens: 4096, messages: [{ role: 'system', content: instructions }, { role: 'user', content: text.trim() }] }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new AppError('模型服务拒绝访问，请检查服务端密钥和模型权限。', 502);
        if (response.status === 429) throw new AppError('模型服务额度不足或请求过多，请稍后重试。', 429);
        throw new AppError(`模型服务请求失败（HTTP ${response.status}），请检查服务地址和模型配置。`, 502);
      }
      return parseWords(await responseJson(response));
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') throw new AppError('模型整理超时，请缩短原文后重试。', 504);
      // Never echo upstream payloads or fetch errors: they can include secrets.
      throw new AppError('无法连接模型服务，请检查服务地址和网络。', 502);
    } finally { pending = false; }
  }
  return { status, extract };
}
