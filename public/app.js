import { isReviewDue } from './review.js';
import { filterWords, wordTable } from './word-list.js';
import { createDraftCache, hasDraftContent } from './draft-cache.js';

const $ = (selector, root = document) => root.querySelector(selector);
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = {
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  pen: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14z"/>',
  book: '<path d="M3 5h6a3 3 0 0 1 3 3v13a4 4 0 0 0-4-2H3zM21 5h-6a3 3 0 0 0-3 3v13a4 4 0 0 1 4-2h5z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/>',
  settings: '<path d="M5 7h14M5 17h14"/><circle cx="9" cy="7" r="3" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="3" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 15v5h16v-5"/>',
  leaf: '<path d="M20 3C6 2 2 9 5 16s16 5 15-13ZM5 21l10-12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.book}</svg>`;
const statusName = { new: '未学习', unfamiliar: '不熟悉', mastered: '已掌握' };
const phaseName = { browse: '浏览词条', en: '英译中', zh: '中译英', choice: '选义初识', recall: '主动回忆', reverse: '反向回忆', spell: '拼写巩固', done: '本组小结' };
const main = $('#main'), modal = $('#modal');
let data = { papers: [], words: [], session: null };
let filter = 'all', query = '', paperQuery = '', draft = null, restoreData = null, busy = false, toastTimer;
let previousRoute = '', pendingNavigation = false;
let practicePanel = 'context';
let modelStatus = { ready: false, state: 'disabled', message: '接口已预留，暂未启用。', maxSourceLength: 20000 };
const draftCache = createDraftCache(() => window.sessionStorage);
const recoveredDraft = draftCache.load();
draft = recoveredDraft.draft;
let draftTimer;
let draftMessage = recoveredDraft.state === 'restored' ? '已恢复本标签页草稿。预览修改已保留，保存前需要重新检查。' : recoveredDraft.state === 'expired' ? '旧草稿超过 7 天，已清理；已入库的内容不受影响。' : ['unavailable', 'invalid'].includes(recoveredDraft.state) ? '浏览器临时草稿不可用或无法恢复，请勿依赖刷新恢复。' : '未入库的草稿会临时保存在当前标签页。';

function persistDraft() {
  clearTimeout(draftTimer);
  const saved = draftCache.save(draft);
  draftMessage = !saved ? '临时保存失败（内容过大或浏览器限制），请保留此页面并尽快确认入库。' : hasDraftContent(draft) ? '草稿已临时保存到当前标签页；尚未加入词库。' : '暂无未保存的录入草稿。';
  if ($('#draft-status')) $('#draft-status').textContent = draftMessage;
}
function queueDraftSave() {
  clearTimeout(draftTimer);
  if ($('#draft-status')) $('#draft-status').textContent = '正在临时保存草稿…';
  draftTimer = setTimeout(persistDraft, 300);
}

async function api(path, body, method = 'POST') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 140000);
  let response, result;
  try {
    response = await fetch(`/api${path}`, { ...(body === undefined ? { method: 'GET' } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: controller.signal });
    if (response.status === 401 && !$('#auth-notice')) {
      const notice = document.createElement('div');
      notice.id = 'auth-notice'; notice.setAttribute('role', 'alert');
      notice.innerHTML = '登录已过期，当前输入仍保留。<a href="/login" target="_blank" rel="noopener">在新页面重新登录</a>后回来重试。';
      document.body.append(notice);
    }
    try { result = await response.json(); } catch { throw new Error(`服务返回异常（HTTP ${response.status}），请保留当前输入，稍后重试`); }
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('连接中断或超时，未自动重试；保存结果可能已生效，请重新连接后核对');
    throw error;
  } finally { clearTimeout(timeout); }
  if (response.ok && path === '/overview') $('#auth-notice')?.remove();
  if (!response.ok) { const error = new Error(result.error || '操作失败，请重试'); error.status = response.status; throw error; }
  return result;
}
async function refresh() {
  const [overview, status] = await Promise.all([api('/overview'), api('/llm/status').catch(() => ({ ready: false, state: 'unavailable', message: '接口状态暂时不可用，请重启服务后刷新。', maxSourceLength: 20000 }))]);
  data = overview; modelStatus = status;
}
function toast(text) {
  const element = $('#toast'); element.textContent = text; element.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('show'), 4500);
}
function route() {
  const [path, search = ''] = (location.hash.slice(1) || '/home').split('?');
  return { path, params: new URLSearchParams(search), paperId: path.startsWith('/papers/') ? path.split('/')[2] : null };
}
function go(path) { if (location.hash === `#${path}`) render(); else location.hash = path; }
function activeSession() { return data.session && data.session.phase !== 'done'; }
function button(label, action, style = '', extra = '', glyph = '') { return `<button class="button ${style}" data-action="${action}" ${extra}>${glyph ? icon(glyph) : ''}${label}</button>`; }
function heading(title, subtitle, action = '') { return `<div class="page-heading"><div><h1>${h(title)}</h1><p class="subtext">${h(subtitle)}</p></div>${action}</div>`; }
function searchInput(id, placeholder, value = '') { return `<label class="search">${icon('search')}<span class="visually-hidden">${placeholder}</span><input id="${id}" type="search" placeholder="${placeholder}" value="${h(value)}" autocomplete="off"></label>`; }
function statusTag(value) { return `<span class="status ${value}">${statusName[value]}</span>`; }
function reviewNote(word) {
  if (word.status === 'new') return '学完后安排下次复习';
  if (isReviewDue(word)) return word.due_at ? '已到期 · 待复习' : '待复习 · 尚无复习计划';
  return `下次复习 ${new Date(word.due_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}
function reviewSummary() {
  if (!data.words.length || activeSession()) return '';
  const due = data.words.filter(word => isReviewDue(word)).length;
  const fresh = data.words.filter(word => word.status === 'new').length;
  const upcoming = data.words.filter(word => word.status !== 'new' && !isReviewDue(word)).sort((first, second) => Date.parse(first.due_at) - Date.parse(second.due_at));
  return `<section class="review-summary" aria-label="复习安排"><div><h2>${due ? `${due} 个词条到期` : '暂时没有到期词条'}</h2><p>${fresh} 个未学习${upcoming.length ? ` · ${h(reviewNote(upcoming[0]))}` : ''}</p></div><div class="actions">${due ? button('复习到期词', 'review-due', 'primary') : ''}${fresh ? button('学习新词', 'review-new', due ? '' : 'primary') : button('自由复习', 'start-dialog')}</div></section>`;
}
function resumeBanner() {
  if (!activeSession()) return '';
  const s = data.session;
  return `<div class="resume-banner"><div>有一组复习尚未完成<p>${s.items.length} 个词条 · 正在${phaseName[s.phase]} · 进度已保存</p></div><a class="button small" href="#/study">继续复习 ${icon('arrow')}</a></div>`;
}
function renderNav() {
  const path = route().path;
  const links = [['/home', 'grid', '今日学习'], ['/papers', 'book', '试卷词书'], ['/words', 'layers', '我的词库'], ['/study', 'play', '专注学习'], ['/records', 'clock', '学习记录'], ['/import', 'plus', '录入词条'], ['/settings', 'settings', '偏好与备份']];
  $('#nav').innerHTML = links.map(([href, glyph, title]) => `<a class="nav-link ${path === href || (href === '/papers' && path.startsWith('/papers/')) ? 'active' : ''}" href="#${href}" title="${title}" ${path === href || (href === '/papers' && path.startsWith('/papers/')) ? 'aria-current="page"' : ''}>${icon(glyph)}<span class="nav-text">${title}</span>${href === '/papers' ? `<span class="nav-count">${data.papers.length}</span>` : ''}</a>`).join('');
  $('#breadcrumb').textContent = route().paperId ? `试卷 / ${data.papers.find(p => p.id === route().paperId)?.label || '试卷详情'}` : links.find(([href]) => href === path)?.[2] || 'Afterword';
}
function render() {
  const { path, paperId } = route();
  if (previousRoute !== path) { filter = 'all'; query = ''; previousRoute = path; }
  renderNav();
  document.body.classList.toggle('immersive', path === '/study' && activeSession() && data.session.mode === 'context');
  document.body.dataset.theme = data.preferences?.theme || 'sky';
  if (path === '/home') renderHome();
  else if (path === '/records') renderRecords();
  else if (path === '/papers') renderPapers();
  else if (path === '/words' || paperId) renderWords(paperId);
  else if (path === '/import') renderImport();
  else if (path === '/study') renderStudy();
  else if (path === '/settings') renderSettings();
  else { go('/papers'); }
  if (path === '/study' && data.session?.phase === 'done') main.insertAdjacentHTML('afterbegin', reviewSummary());
  if (path === '/home' || path === '/records') main.insertAdjacentHTML('beforeend', reviewCalendar());
  updateStudyAvailability();
}
function renderHome() {
  const due = data.words.filter(word => isReviewDue(word)).length;
  const fresh = data.words.filter(word => word.status === 'new').length;
  const today = data.stats.today;
  const goal = data.preferences.dailyGoal;
  const dayWord = data.words.find(word => word.details.starred) || data.words.find(word => isReviewDue(word)) || data.words[0];
  const day = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  main.innerHTML = `<div class="home-heading"><div><p class="eyebrow">A LITTLE, EVERY DAY</p><h1>让单词，留在记忆里。</h1><p class="subtext">${h(day)} · 先复习，再遇见新词。</p></div><a class="button" href="#/settings">${icon('settings')} 学习偏好</a></div>${resumeBanner()}<section class="home-grid"><div class="sky-scene"><div class="scene-top"><span>AFTERWORD / 今日一词</span>${dayWord ? button('听发音', 'pronounce', 'text small', `data-id="${dayWord.id}"`) : ''}</div><div class="daily-word"><p class="eyebrow">MAKE IT YOURS.</p><h2>${dayWord ? h(dayWord.english) : 'a fresh start'}</h2><p>${dayWord ? h([...new Set(dayWord.sources.flatMap(source => source.meanings))].join('；')) : '从你读过的试卷，开始积累自己的词库。'}</p>${dayWord?.details.example ? `<blockquote>${h(dayWord.details.example)}</blockquote>` : ''}</div><div class="scene-bottom"><span>在自己的语境里，记住每一次相遇。</span>${dayWord ? button('词条详情', 'word-detail', 'text', `data-id="${dayWord.id}"`, 'arrow') : button('录入第一组词', 'import', 'primary', '', 'arrow')}</div></div><section class="today-plan" aria-label="今日学习计划"><div class="section-heading"><h2>今天，慢慢来。</h2><span class="helper-note">已连续 ${data.stats.streak} 天</span></div><div class="plan-number"><strong>${today.learned + today.reviewed}</strong><span> / ${goal} 词</span></div><progress max="${goal}" value="${Math.min(goal, today.learned + today.reviewed)}" aria-label="今日目标完成量"></progress><p class="helper-note">新学 ${today.learned} · 复习 ${today.reviewed}${today.learned + today.reviewed >= goal ? ' · 今日目标已达成' : ''}</p><button class="plan-action" data-action="review-due" ${!due && !activeSession() ? 'disabled' : ''}><span>复习旧词<small>到期优先，巩固记忆</small></span><strong>${due}</strong>${icon('arrow')}</button><button class="plan-action" data-action="review-new" ${!fresh && !activeSession() ? 'disabled' : ''}><span>学习新词<small>分轮回忆，逐步熟悉</small></span><strong>${fresh}</strong>${icon('arrow')}</button><a class="quiet-link" href="#/study">自由选词 / 拼写专项 ${icon('arrow')}</a><a class="quiet-link" href="#/records">查看学习记录 ${icon('clock')}</a></section></section><section class="home-bottom"><div><p class="eyebrow">YOUR COLLECTION</p><h2>你的试卷，就是你的词书。</h2><p class="subtext">${data.papers.length} 套试卷 · ${data.words.length} 个词条 · ${data.words.filter(word => word.status === 'mastered').length} 个已掌握</p></div><a class="button" href="#/papers">打开词书 ${icon('arrow')}</a></section>`;
}
function renderRecords() {
  const stats = data.stats;
  main.innerHTML = `${heading('每一点进步，都算数。', '完成记忆与所选拼写后计入记录；同一天重复练习同一词只计一次。')}<div class="record-totals"><div><strong>${stats.today.learned}</strong><span>今日新学</span></div><div><strong>${stats.today.reviewed}</strong><span>今日复习</span></div><div><strong>${stats.streak}</strong><span>连续学习天数</span></div><div><strong>${stats.totalSessions}</strong><span>产生完成记录的组数</span></div></div><section class="panel"><h2>最近 14 天</h2><div class="activity-grid">${stats.days.map(day => `<div class="activity-day ${day.learned + day.reviewed ? 'has-activity' : ''}"><span>${day.day.slice(5).replace('-', '/')}</span><strong>${day.learned + day.reviewed}</strong><small>新 ${day.learned} / 复 ${day.reviewed}</small></div>`).join('')}</div><p class="helper-note">北京时间凌晨 4 点切换学习日。旧版学习没有逐日记录，不补造历史数据。</p></section>${reviewSummary()}`;
}
function reviewCalendar() {
  const forecast = data.forecast;
  const maximum = Math.max(1, ...forecast.days.map(day => day.count));
  return `<section class="review-calendar" aria-labelledby="calendar-title"><div class="section-heading"><div><p class="eyebrow">A GENTLE RHYTHM</p><h2 id="calendar-title">七日复习日历</h2></div>${button('更新日历', 'refresh-calendar', 'text')}</div><p class="calendar-summary">现在可复习 <strong>${forecast.dueNow}</strong> 词 <span>· 今日稍后到期 ${forecast.laterToday} 词</span></p><div class="calendar-days">${forecast.days.map((day, index) => `<button class="calendar-day ${index === 0 ? 'is-today' : ''}" data-action="calendar-day" data-day="${day.day}" aria-label="${day.day}，${day.count} 个待复习词条，查看列表"><span>${index === 0 ? '今天' : index === 1 ? '明天' : new Date(day.day + 'T00:00:00Z').toLocaleDateString('zh-CN', { weekday: 'short', timeZone: 'UTC' })}<small>${day.day.slice(5).replace('-', '/')}</small></span><strong>${day.count}<small>词</small></strong><progress max="${maximum}" value="${day.count}" aria-hidden="true"></progress></button>`).join('')}</div><p class="helper-note">今天含此前积压 ${forecast.overdue} 词、未安排日期的旧词 ${forecast.unscheduled} 词；七日后另有 ${forecast.later} 词。按北京时间凌晨 4 点分日。</p><p class="helper-note">仅展示当前已学词的下一次到期日，不预测新词或后续轮次；学习后会重新安排。点日期可查看词条。</p></section>`;
}
function calendarDay(dayKey, page = 0) {
  const day = data.forecast.days.find(item => item.day === dayKey);
  if (!day) { closeModal(); render(); toast('学习日已切换，日历已更新'); return; }
  const lastPage = Math.max(0, Math.ceil(day.count / 50) - 1);
  const currentPage = Math.max(0, Math.min(lastPage, page));
  const wordMap = new Map(data.words.map(word => [word.id, word]));
  const words = day.wordIds.slice(currentPage * 50, (currentPage + 1) * 50).map(id => wordMap.get(id)).filter(Boolean);
  const today = day === data.forecast.days[0];
  showModal(`${day.day} · 待复习词条`, `<p class="modal-description">共 ${day.count} 词${today ? `，其中现在可复习 ${data.forecast.dueNow} 词。` : '，尚未到期，不会提前改动复习计划。'}</p><div class="calendar-word-list">${words.map(word => `<button data-action="word-detail" data-id="${word.id}"><span><strong>${h(word.english)}</strong><small>${h([...new Set(word.sources.flatMap(source => source.meanings))].join('；'))}</small></span>${icon('arrow')}</button>`).join('') || '<p class="helper-note">这一天暂无待复习词条。完成学习后，这里会出现下一次复习安排。</p>'}</div>${lastPage ? `<div class="calendar-pagination">${button('上一页', 'calendar-day', '', `data-day="${day.day}" data-page="${currentPage - 1}" ${currentPage === 0 ? 'disabled' : ''}`)}<span>${currentPage + 1} / ${lastPage + 1}</span>${button('下一页', 'calendar-day', '', `data-day="${day.day}" data-page="${currentPage + 1}" ${currentPage === lastPage ? 'disabled' : ''}`)}</div>` : ''}<div class="modal-actions">${button('返回日历', 'close-modal')}${today && data.forecast.dueNow ? button('开始到期复习', 'calendar-review', 'primary') : ''}</div>`);
  $('#modal-title').tabIndex = -1;
  $('#modal-title').focus();
}
function renderPapers() {
  main.innerHTML = `${heading('试卷', '按考试年月整理单词和短语。', `<div class="actions">${data.words.length ? button('开始复习', 'start-dialog') : ''}${button('新建试卷', 'new-paper', 'primary', '', 'plus')}</div>`)}
    ${resumeBanner()}${reviewSummary()}
    <div class="library-summary" aria-label="词库概览"><span><strong>${data.papers.length}</strong> 套试卷</span><span><strong>${data.words.length}</strong> 个词条</span><span>已掌握 <strong>${data.words.filter(w => w.status === 'mastered').length}</strong> 个</span></div>
    <section aria-label="试卷列表"><div class="section-heading"><span class="sort-note">按考试时间从新到旧</span>${searchInput('paper-search', '搜索年月或套卷', paperQuery)}</div><div class="paper-list" id="paper-grid"></div></section>`;
  renderPaperGrid();
}
function renderPaperGrid() {
  const papers = data.papers.filter(p => `${p.label} ${p.exam_month}`.includes(paperQuery.trim()));
  $('#paper-grid').innerHTML = papers.length ? `<div class="paper-list-head" aria-hidden="true"><span>考试 / 套卷</span><span>词条</span><span>已掌握</span><span></span></div>` + papers.map(p => `<a class="paper-row" href="#/papers/${p.id}"><div class="paper-name">${icon('file')}<div><h3>${Number(p.exam_month.slice(0, 4))} 年 ${Number(p.exam_month.slice(5))} 月</h3><p>${p.volume ? `第 ${p.volume} 套` : '未注明套卷'}</p></div></div><span class="paper-count"><span class="mobile-label">词条 </span>${p.count}</span><span class="paper-progress"><span class="mobile-label">已掌握 </span>${p.mastered}<span class="paper-total"> / ${p.count}</span></span>${icon('arrow')}</a>`).join('') : `<div class="empty-panel"><h3>${data.papers.length ? '没有找到试卷' : '还没有试卷'}</h3><p>${data.papers.length ? '试试考试年份或月份。' : '新建一套试卷，再粘贴需要复习的词汇。'}</p>${data.papers.length ? '' : button('新建试卷', 'new-paper', '', '', 'plus')}</div>`;
}
function renderWords(paperId) {
  const paper = paperId && data.papers.find(p => p.id === paperId);
  if (paperId && !paper) { main.innerHTML = `${heading('这套试卷已不存在', '可以返回试卷列表，或从备份恢复。')}<a class="button" href="#/papers">返回试卷</a>`; return; }
  const words = data.words.filter(w => !paperId || w.sources.some(s => s.paperId === paperId));
  main.innerHTML = `${paper ? `<a class="back" href="#/papers">${icon('back')} 返回试卷</a>` : ''}${heading(paper?.label || '全部词条', paper ? `${words.length} 个词条 · 已掌握 ${words.filter(w => w.status === 'mastered').length} 个 · 录入 ${new Date(paper.created_at).toLocaleDateString('zh-CN')}` : '查看所有试卷的词条，按掌握程度筛选。', `<div class="actions">${button('录入词条', 'import', '', paper ? `data-paper="${paperId}"` : '', 'plus')}${button('开始复习', 'start-dialog', 'primary', paper ? `data-paper="${paperId}"` : '', 'play')}</div>`)}${resumeBanner()}
    <div class="toolbar"><div class="tabs" role="group" aria-label="掌握程度筛选">${[['all', '全部词条'], ['due', '到期复习'], ['new', '未学习'], ['unfamiliar', '不熟悉'], ['mastered', '已掌握'], ['starred', '已收藏']].map(([value, label]) => `<button class="tab ${filter === value ? 'active' : ''}" data-action="filter" data-value="${value}" aria-pressed="${filter === value}">${label}</button>`).join('')}</div>${searchInput('word-search', '搜索英文或中文释义', query)}</div>
    <div class="word-list"><div class="word-header"><span>英文</span><span>释义与来源</span><span>掌握程度</span><span>管理</span></div><div id="word-rows"></div></div><div class="toolbar"><p class="helper-note" id="word-count"></p><div class="actions">${button('导出当前词表', 'export-words', '', '', 'download')}${paper ? button('删除这套试卷', 'delete-paper', 'text', `data-id="${paperId}"`) : ''}</div></div><p class="helper-note">导出当前搜索与筛选结果，为英文、中文两列 TXT；完整来源和复习进度请使用数据备份。</p>`;
  renderWordRows();
}
function renderWordRows() {
  const { paperId } = route();
  const words = filterWords(data.words, { paperId, filter, query });
  $('#word-rows').innerHTML = words.map(w => {
    const sources = w.sources.filter(s => !paperId || s.paperId === paperId);
    const meanings = [...new Set(sources.flatMap(s => s.meanings))];
    return `<div class="word-row"><div class="word-en">${h(w.english)}</div><div><div class="word-meaning">${meanings.map(h).join('；')}</div><div class="word-sources">${sources.map(s => h(s.label)).join(' / ')}</div><p class="word-review ${isReviewDue(w) ? 'due' : ''}">${h(reviewNote(w))}</p></div>${statusTag(w.status)}<button class="row-action" data-action="word-detail" data-id="${w.id}" aria-label="管理 ${h(w.english)}">查看</button></div>`;
  }).join('') || '<div class="no-results">没有匹配的词条。可以调整筛选，或先录入一些词汇。</div>';
  $('#word-count').textContent = `共 ${words.length} 个词条`;
  $('[data-action="export-words"]').disabled = !words.length;
}
function renderImport() {
  const requested = route().params.get('paper');
  if (!draft) draft = { paperId: requested || data.papers[0]?.id || '', text: '', modelText: '', preview: null, dirty: false, requestId: null };
  if (requested && draft.paperId !== requested) {
    if (hasDraftContent(draft)) { history.replaceState(null, '', '#/import'); toast('已保留未保存草稿；如需改归档，请在试卷选择框中切换'); }
    else draft.paperId = requested;
  }
  if (draft.paperId && !data.papers.some(p => p.id === draft.paperId)) {
    draft.paperId = ''; draft.dirty = !!draft.preview; draft.requestId = null;
    history.replaceState(null, '', '#/import');
    toast('原试卷已不存在，输入内容已保留，请重新选择归档试卷');
  }
  main.innerHTML = `${heading('录入词条', '粘贴词汇表，检查后保存。')}
    <section class="draft-status-bar" aria-label="录入草稿"><div><p id="draft-status" role="status">${h(draftMessage)}</p><p class="helper-note">仅当前浏览器标签页临时保存，不跨设备、不含在词库备份中。关闭或清理浏览器后可能丢失；最长保留 7 天。共用电脑请在离开前清空。</p></div>${button('清空草稿', 'clear-draft', 'text')}</section>
    <section class="import-form" aria-label="录入词条">
      <div class="field"><label for="import-paper">试卷</label><div class="import-paper"><select id="import-paper"><option value="">请选择一套试卷</option>${data.papers.map(p => `<option value="${p.id}" ${p.id === draft.paperId ? 'selected' : ''}>${h(p.label)}</option>`).join('')}</select>${button('新建试卷', 'new-paper', '', 'data-context="import"', 'plus')}</div></div>
      <div class="import-label"><label for="import-text">英文与中文释义</label>${button('填入示例', 'sample', 'text small')}</div>
      <textarea id="import-text" class="import-source" spellcheck="false" placeholder="accumulate = 积累；积聚&#10;in the long run = 从长远来看&#10;&#10;也可以粘贴两列表格。">${h(draft.text)}</textarea>
      <div class="import-help"><details class="format-help"><summary>支持哪些格式？</summary><p>每行「英文 = 中文释义」，或粘贴 Markdown 表格、从表格复制的英文和中文两列。无法识别的行会在预览中标出。</p>${button('复制给大模型的整理要求', 'copy-prompt', 'text small')}</details>${button('预览词条', 'parse', 'primary', '', 'arrow')}</div>
    </section>
    <details class="model-import"><summary>用大模型整理原文 <span class="model-state">${modelStatus.ready ? '已配置' : '未启用'}</span></summary>
      <p class="helper-note">${modelStatus.ready ? `将原文发送到 ${h(modelStatus.serviceOrigin)}，使用 ${h(modelStatus.model)} 整理词汇。调用可能产生服务商费用，结果需核对后保存。` : `${h(modelStatus.message)} 手动录入不受影响。`}</p>
      <label for="model-text">英文原文</label><textarea id="model-text" maxlength="20000" placeholder="以后接入模型后，可在这里粘贴文章或试题原文。" ${modelStatus.ready ? '' : 'disabled'}>${h(draft.modelText || '')}</textarea>
      <div class="import-help"><p>每次最多 20,000 字符。</p>${button('整理并预览', 'model-preview', 'primary', modelStatus.ready ? '' : 'disabled')}</div><p id="model-feedback" class="helper-note" role="status"></p>
    </details><div id="import-preview"></div>`;
  renderPreview();
}
function renderPreview() {
  const target = $('#import-preview'); if (!target || !draft?.preview) return;
  const { rows, counts, ignored } = draft.preview;
  target.innerHTML = `<section class="panel"><div class="panel-title"><h2>${draft.preview.generatedBy === 'model' ? '核对模型整理结果' : '检查词条'}</h2><span class="helper-note">${rows.length} 行内容${ignored ? ` · 已识别 ${ignored} 行表头 / 格式标记` : ''}</span></div><div class="preview-info">${[['added', '新增', ''], ['duplicate', '重复跳过', ''], ['conflict', '释义冲突', 'warn'], ['invalid', '需要修改', 'error'], ['excluded', '已排除', '']].filter(([key]) => counts[key] > 0).map(([key, label, style]) => `<span class="${style}">${label} ${counts[key]}</span>`).join('')}</div><div class="preview-scroll"><table class="preview-table"><thead><tr><th>保留</th><th>英文</th><th>中文释义</th><th>检查结果</th></tr></thead><tbody>${rows.map((r, index) => `<tr class="${r.kind}" data-row="${index}"><td><input type="checkbox" data-field="included" aria-label="保留第 ${r.line} 行" ${!r.excluded ? 'checked' : ''}><span class="helper-note"> ${r.line}</span></td><td><input data-field="english" aria-label="第 ${r.line} 行英文" value="${h(r.english)}" maxlength="300"></td><td><textarea data-field="meaning" aria-label="第 ${r.line} 行中文释义" maxlength="5000">${h(r.meaning)}</textarea>${r.error ? `<p class="raw-line">原始行：${h(r.raw)}</p>` : ''}${r.kind === 'conflict' ? `<p class="helper-note">已有：${r.previous.map(h).join('；')}</p>` : ''}</td><td><p class="row-label">${h(r.error && !r.excluded ? r.error : { unchecked: '待重新检查', added: '新增', duplicate: '完全重复 · 跳过', conflict: '同词不同释义', invalid: '需要修改', excluded: '已排除' }[r.kind])}</p>${r.kind === 'conflict' ? `<select data-field="strategy" aria-label="第 ${r.line} 行冲突处理"><option value="merge" ${r.strategy === 'merge' ? 'selected' : ''}>合并释义</option><option value="replace" ${r.strategy === 'replace' ? 'selected' : ''}>替换释义</option></select>` : ''}</td></tr>`).join('')}</tbody></table></div><div class="import-footer"><p class="helper-note" id="preview-note">${draft.dirty ? '预览有修改，请重新检查后保存。' : counts.invalid ? '请修改或取消勾选异常行，再重新检查。' : '同词不同释义默认合并；完全重复内容不会再次新增。'}</p><div class="actions">${button('重新检查', 'recheck', '')}${button('确认保存', 'save-import', 'primary', rows.length ? '' : 'disabled', 'check')}</div></div></section>`;
}
function renderStudy() {
  const s = data.session;
  if (s?.mode === 'context') return renderPractice(s);
  if (!s) {
    main.innerHTML = `${heading('开始一段专注时间', '选义初识 → 三轮词义回忆 → 可选拼写巩固')}${reviewSummary()}${data.words.length ? `<section class="review-setup" aria-label="复习设置">${studyForm()}</section>` : `<div class="empty-panel"><h3>还没有可复习的词条</h3><p>先选一套试卷，录入需要复习的单词和短语。</p>${button('录入词条', 'import', 'primary')}</div>`}`;
    return;
  }
  if (s.phase === 'done') {
    main.innerHTML = `<div class="study-shell">${heading('复习结果', '本组进度已保存。')}<div class="study-card"><div class="finish-icon">${s.reason === 'completed' ? '✓' : icon('clock')}</div><h2 class="finish-title">${s.reason === 'completed' ? '本组复习完成' : '这一组已结束'}</h2><p class="subtext">${s.reason === 'content-changed' ? '词条内容已修改，本组已结束；记录过的掌握状态仍保留。' : s.reason === 'completed' ? '本组词条已全部通过英译中和中译英。' : '已记录的掌握状态保留，未完成的词可以下次再学。'}</p><div class="finish-stats"><div class="finish-stat"><strong>${s.items.length}</strong><span>本组词条</span></div><div class="finish-stat"><strong>${s.passedZh.length}</strong><span>双向通过</span></div><div class="finish-stat"><strong>${s.failed.length}</strong><span>标记过忘记</span></div></div><div class="study-controls"><a class="button" href="#/words">回到词库</a>${button('再练一组', 'start-dialog', 'green', s.paperId && data.papers.some(p => p.id === s.paperId) ? `data-paper="${s.paperId}"` : '', 'arrow')}</div></div></div>`;
    return;
  }
  const item = s.phase === 'browse' ? s.items[s.browseIndex] : s.items.find(i => i.wordId === s.queue[0]);
  const passed = s.phase === 'browse' ? s.browseIndex : s.phase === 'en' ? s.passedEn.length : s.passedZh.length;
  const totalSteps = s.items.length * 3, doneSteps = Math.min(s.browseIndex, s.items.length) + s.passedEn.length + s.passedZh.length;
  const definitions = studyDefinitions(item.sources);
  main.innerHTML = `<div class="study-shell"><div class="study-heading"><div><h1>${phaseName[s.phase]}</h1></div><div class="actions">${button('暂停', 'pause-study', 'text small')}${button('提前结束', 'end-study', 'small')}</div></div><progress class="study-progress" max="${totalSteps}" value="${doneSteps}" aria-label="本组学习进度"></progress><div class="progress-caption"><span>${s.paperId ? h(data.papers.find(p => p.id === s.paperId)?.label || '试卷词条') : '全部试卷'} · 本组 ${s.items.length} 个词条</span><span>本阶段已完成 ${passed} / ${s.items.length}</span></div><div class="study-stage-list">${[['browse', '01 浏览词条'], ['en', '02 英译中'], ['zh', '03 中译英']].map(([phase, label], i) => `<span class="${s.phase === phase ? 'active' : i < ['browse', 'en', 'zh'].indexOf(s.phase) ? 'done' : ''}">${label}</span>`).join('')}</div><div class="study-card"><span class="card-label">${s.phase === 'browse' ? '浏览英文和释义' : s.phase === 'en' ? '回忆它的中文释义' : '回忆对应的英文表达'}</span>${s.phase !== 'zh' ? `<div class="study-word">${h(item.english)}</div>` : `<div class="study-definition">${definitions}</div>`}${s.phase === 'browse' || s.revealed ? `<div class="study-answer">${s.phase === 'zh' ? `<div class="study-word">${h(item.english)}</div>` : definitions}</div>` : '<p class="reveal-hint">先在心里回忆，再展开答案。</p>'}</div><div class="review-actions"><div class="study-controls">${s.phase === 'browse' ? button(s.browseIndex === s.items.length - 1 ? '开始英译中回忆' : '下一个词条', 'study-next', 'green', '', 'arrow') : !s.revealed ? button('展开答案', 'study-reveal', 'green') : `${button('忘记了', 'study-forget', '')}${button('记住了', 'study-remember', 'green', '', 'check')}`}</div><p class="keyboard-help">${s.phase === 'browse' ? '<kbd>空格</kbd> 下一个' : !s.revealed ? '<kbd>空格</kbd> 展开答案' : '<kbd>1</kbd> 忘记了 <kbd>2</kbd> 记住了'} · 进度已保存</p></div></div>`;
}
function renderPractice(state) {
  if (state.phase === 'done') {
    const failed = state.items.filter(item => state.failed.includes(item.wordId));
    main.innerHTML = `<section class="practice-result"><p class="eyebrow">ONE SMALL STEP FORWARD</p><h1>${state.reason === 'completed' ? '这一组，记住了。' : '停一下，也没关系。'}</h1><p class="subtext">${state.reason === 'content-changed' ? '词条有修改，本组已结束，已完成的记录保留。' : state.reason === 'completed' ? '回忆和所选拼写已完成，下次复习已经安排好。' : '已完成词条的记录保留，未完成词条可以下次再学。'}</p><div class="record-totals"><div><strong>${state.items.length}</strong><span>本组词条</span></div><div><strong>${state.passedZh.length}</strong><span>完整通过</span></div><div><strong>${state.failed.length}</strong><span>曾经记错</span></div></div>${failed.length ? `<section class="result-words"><h2>再见面，会更熟悉。</h2><p class="helper-note">这些词在本组中忘记过或拼错过。</p><div>${failed.map(item => button(h(item.english), 'word-detail', '', `data-id="${item.wordId}"`)).join('')}</div>${button('只练本组错词', 'retry-failed', '', '', 'arrow')}</section>` : ''}<div class="actions"><a class="button" href="#/home">回到今日</a>${button('继续下一组', 'start-dialog', 'primary', '', 'arrow')}</div></section>`;
    return;
  }
  const item = state.items.find(item => item.wordId === state.queue[0]);
  const track = state.tracks.find(track => track.wordId === item.wordId);
  const detail = data.words.find(word => word.id === item.wordId)?.details || {};
  const hiddenEnglish = ['reverse', 'spell'].includes(state.phase) && !state.pending;
  const total = state.items.length;
  const completed = state.phase === 'spell' ? state.passedZh.length : state.passedEn.length;
  const reveal = !!state.pending;
  const correction = reveal && state.pending.correct && state.phase !== 'spell';
  const review = track.initialStatus !== 'new';
  const keyboardHint = reveal ? `空格 / Enter 下一词${correction ? ' · C 记错了' : ''}` : state.phase === 'choice' ? '数字 1—4 选择 · 空格 不认识' : state.phase === 'spell' ? 'Enter 检查拼写' : `1 不认识 · ${review ? '2 模糊 · ' : ''}3 认识`;
  const options = state.phase === 'choice' && !reveal ? `<div class="meaning-choices">${track.options.map((option, index) => `<button data-action="answer-choice" data-index="${index}"><kbd>${index + 1}</kbd><span>${h(option)}</span></button>`).join('')}</div>${track.options.length < 4 ? '<p class="helper-note">可用释义不足四项，仅显示真实词库选项。</p>' : ''}` : '';
  const spelling = state.phase === 'spell' && !reveal ? '<form id="spelling-form"><label for="spelling-answer">根据释义，拼写英文</label><div><input id="spelling-answer" name="answer" type="text" maxlength="300" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="输入单词或短语" required><button type="submit" class="button primary">检查</button></div></form>' : '';
  const meanings = [...new Set(item.sources.flatMap(source => source.meanings))];
  const memory = state.phase !== 'spell' ? `<div class="memory-dots" aria-label="本词已通过 ${track.step} / ${track.steps.length} 轮">${track.steps.map((step, index) => `<span class="${index < track.step ? 'filled' : ''}"></span>`).join('')}<small>${track.step} / ${track.steps.length}</small></div>` : '';
  const panel = practicePanel === 'context'
    ? `${detail.example ? `<blockquote>${h(detail.example)}</blockquote><p>${h(detail.translation || '')}</p>${button('朗读例句', 'speak-example', 'text', `data-id="${item.wordId}"`, 'play')}` : '<p class="panel-empty">还没有原句。添加你读过的语境，让单词和句子一起留下。</p>'}${button(detail.example ? '编辑原句' : '添加原句', 'edit-note', 'text', `data-id="${item.wordId}"`)}`
    : practicePanel === 'note'
      ? `<p class="saved-note">${h(detail.note || '记录词根、搭配或自己的联想。')}</p>${button('编辑笔记', 'edit-note', 'text', `data-id="${item.wordId}"`)}`
      : item.sources.map(source => `<div class="source-detail"><span>${h(source.label)}</span><p>${source.meanings.map(h).join('；')}</p></div>`).join('');
  main.innerHTML = `<section class="focus-shell">
    <header class="focus-header">
      <div class="actions">${button('返回', 'pause-study', 'text', '', 'back')}<span class="focus-brand">Afterword</span></div>
      <div class="focus-progress"><span>${phaseName[state.phase]} <b>${completed}</b> / ${total}</span><progress max="${total}" value="${completed}" aria-label="本阶段完成词数"></progress></div>
      <div class="actions">${button('上一词', 'previous-word', 'text', state.lastWordId ? '' : 'disabled')}<details class="focus-menu"><summary aria-label="学习菜单">•••</summary><div>${button('结束本组', 'end-study', 'text')}</div></details></div>
    </header>
    <div class="focus-layout"><article class="focus-word">
      <div class="word-tools"><span class="eyebrow">${state.phase === 'spell' ? '拼写巩固' : review ? '复习单词' : '学习单词'}</span><div class="actions">${button(detail.starred ? '已收藏' : '收藏', 'toggle-star', 'text', `data-id="${item.wordId}" aria-pressed="${!!detail.starred}"`, 'bookmark')}${button('笔记', 'edit-note', 'text', `data-id="${item.wordId}"`, 'pen')}</div></div>
      <div class="focus-prompt">${hiddenEnglish ? `<div class="recall-definition">${meanings.map(meaning => `<p>${h(meaning)}</p>`).join('')}</div>` : `<h1>${h(item.english)}</h1><div class="pronunciation">${button('英音', 'pronounce', 'text', `data-id="${item.wordId}" data-accent="en-GB"`, 'play')}${button('美音', 'pronounce', 'text', `data-id="${item.wordId}" data-accent="en-US"`, 'play')}<span>设备语音</span></div>`}${memory}</div>
      ${options}${spelling}
      ${reveal ? `<div class="focus-answer">${meanings.map(meaning => `<button class="meaning-link" data-action="practice-panel" data-panel="context" aria-label="查看语境：${h(meaning)}">${h(meaning)}${icon('arrow')}</button>`).join('')}</div>
        <div class="answer-feedback ${state.pending.correct ? 'correct' : 'incorrect'}" role="status">${state.pending.correct ? state.phase === 'spell' ? '拼写正确' : '核对词义，记错了可以纠正' : state.phase === 'spell' ? '记住这个拼写，稍后再试' : '重新记忆，稍后再见'}${state.pending.answer && !state.pending.correct ? `<p>你的答案：${h(state.pending.answer)}</p>` : ''}</div>
        <section class="word-notebook" aria-label="词条资料"><div class="notebook-content" id="practice-content">${panel}</div><div class="notebook-tabs" role="group" aria-label="词条资料分类">${[['context', '语境'], ['note', '笔记'], ['sources', '来源']].map(([value, label]) => button(label, 'practice-panel', `text ${practicePanel === value ? 'selected' : ''}`, `data-panel="${value}" aria-pressed="${practicePanel === value}" aria-controls="practice-content"`)).join('')}</div></section>` : state.phase === 'recall' || state.phase === 'reverse' ? '<p class="recall-whisper">先在心里回忆，再判断是否认识</p>' : ''}
    </article></div>
    <footer class="focus-footer"><div class="focus-controls">${reveal ? `${correction ? button('记错了', 'study-correct', 'correction') : ''}${button('下一词', 'study-continue', 'primary', '', 'arrow')}` : state.phase === 'choice' || state.phase === 'spell' ? button(state.phase === 'spell' ? '想不起来' : '不认识', 'study-unknown', 'text') : `${button('不认识', 'study-unknown', 'recognition no')}${review ? button('模糊', 'study-vague', 'recognition unsure') : ''}${button('认识', 'study-known', 'primary recognition')}`}</div><p class="keyboard-help">${keyboardHint} · 已自动保存</p></footer>
  </section>`;
}

function renderSettings() {
  const preferences = data.preferences;
  main.innerHTML = `${heading('偏好与备份', '把节奏调到适合自己。')}<form id="preferences-form" class="preferences-form"><div class="form-grid"><div class="field"><label for="daily-goal">每日目标（词）</label><input id="daily-goal" name="dailyGoal" type="number" min="1" max="200" value="${preferences.dailyGoal}" required></div><div class="field"><label for="group-size">默认每组数量</label><input id="group-size" name="groupSize" type="number" min="1" max="100" value="${preferences.groupSize}" required></div><div class="field"><label for="accent">默认发音</label><select id="accent" name="accent"><option value="en-GB" ${preferences.accent === 'en-GB' ? 'selected' : ''}>英音 · 设备语音</option><option value="en-US" ${preferences.accent === 'en-US' ? 'selected' : ''}>美音 · 设备语音</option></select></div><div class="field"><label for="theme">专注背景</label><select id="theme" name="theme"><option value="sky" ${preferences.theme === 'sky' ? 'selected' : ''}>晴空</option><option value="paper" ${preferences.theme === 'paper' ? 'selected' : ''}>纸白</option></select></div></div><label class="check-field"><input type="checkbox" name="learnSpelling" ${preferences.learnSpelling ? 'checked' : ''}> 学新词后练习拼写</label><label class="check-field"><input type="checkbox" name="reviewSpelling" ${preferences.reviewSpelling ? 'checked' : ''}> 复习后练习拼写</label><p class="helper-note">偏好用于下一组；不会改变进行中的学习。设备没有对应口音时会明确提示，不伪装成真人原声。</p><button type="submit" class="button primary">保存学习偏好</button></form>
    <div class="settings-list"><section class="settings-row"><div><h2>下载备份</h2><p>保存所有试卷、词条和复习进度。</p></div><a class="button primary" href="/api/backup" download>${icon('download')} 下载备份</a></section>
    <section class="settings-row"><div><h2>恢复备份</h2><p>选择 JSON 备份文件，检查内容后确认恢复。<br>恢复会替换当前词库，原数据会自动备份。</p></div><div class="file-control"><label class="button" for="backup-file">选择备份文件</label><input class="visually-hidden" id="backup-file" type="file" accept=".json,application/json"></div></section></div>
    ${data.access?.enabled ? `<section class="settings-row"><div><h2>私人访问</h2><p>仅限本人使用。共用电脑上使用完毕后请退出。</p></div>${button('退出登录', 'logout')}</section>` : ''}<section class="model-settings"><div class="section-heading"><h2>大模型接口</h2><span class="model-state">${modelStatus.ready ? '已配置' : modelStatus.state === 'disabled' ? '未启用' : '待配置'}</span></div><p class="subtext">${h(modelStatus.message)}</p>${modelStatus.ready ? `<p class="helper-note">服务：${h(modelStatus.serviceOrigin)} · 模型：${h(modelStatus.model)}</p>` : ''}<details class="format-help"><summary>以后如何接入？</summary><p>将项目中的 .env.example 复制为 .env，填写服务地址、模型名和密钥，将 LLM_ENABLED 设为 true，然后重启服务。密钥只保存在服务端。</p><p>支持 Chat Completions 兼容接口。启用后，在“录入词条”展开“用大模型整理原文”。</p></details></section>
    <details class="storage-details"><summary>数据保存在哪里？</summary><p>词库保存在本机，清理浏览器缓存不会删除词库。建议定期下载备份并另存一份。</p><dl><dt>词库文件</dt><dd class="storage-path">data/cet6.sqlite</dd><dt>恢复前的自动备份</dt><dd class="storage-path">data/backups/</dd></dl></details>`;
}
function studyDefinitions(sources) {
  // Group identical definition sets while retaining every paper's attribution.
  const groups = new Map();
  for (const source of sources) {
    const key = JSON.stringify([...new Set(source.meanings)].sort());
    if (!groups.has(key)) groups.set(key, { meanings: source.meanings, labels: [] });
    groups.get(key).labels.push(source.label);
  }
  return [...groups.values()].map(({ meanings, labels }) => `<div class="study-meaning-block">${meanings.map(h).join('；')}${labels.length === 1 ? `<p class="source-line">${h(labels[0])}</p>` : `<details class="study-sources"><summary>来自 ${labels.length} 套试卷</summary><ul>${labels.map(label => `<li>${h(label)}</li>`).join('')}</ul></details>`}</div>`).join('');
}
function showModal(title, content) {
  modal.innerHTML = `<div class="modal-heading"><h2 id="modal-title">${h(title)}</h2><button class="close-button" data-action="close-modal" aria-label="关闭">×</button></div>${content}<p class="modal-error" id="modal-error" role="alert"></p>`;
  if (!modal.open) modal.showModal();
}
function closeModal() { modal.close(); }
function newPaperDialog(context = '') {
  showModal('新建试卷', `<p class="modal-description">按试卷上的考试年月归档，同一个月份可以有不同套卷。</p><form id="paper-form" data-context="${context}"><div class="form-grid"><div class="field"><label for="exam-month">考试年月</label><input type="month" id="exam-month" name="examMonth" min="1900-01" max="2199-12" required></div><div class="field"><label for="paper-volume">套卷编号</label><input id="paper-volume" name="volume" type="number" min="1" max="99" step="1" placeholder="留空表示未注明"><small>例如：1 表示第 1 套。</small></div></div><div class="modal-actions">${button('取消', 'close-modal')}<button class="button primary" type="submit">创建试卷</button></div></form>`);
}
function studyForm(paperId = '', inDialog = false, requestedFilter = null) {
  const selected = requestedFilter || (['new', 'unfamiliar', 'due'].includes(filter) ? filter : filterWords(data.words, { paperId, filter: 'due' }).length ? 'due' : filterWords(data.words, { paperId, filter: 'new' }).length ? 'new' : 'all');
  return `<form id="study-form"><div class="field"><label for="study-paper">学习范围</label><select name="paperId" id="study-paper"><option value="">全部试卷</option>${data.papers.map(p => `<option value="${p.id}" ${paperId === p.id ? 'selected' : ''}>${h(p.label)}（${p.count} 个）</option>`).join('')}</select></div><div class="form-grid"><div class="field"><label for="study-filter">词条状态</label><select name="filter" id="study-filter">${[['due', '到期复习'], ['new', '未学习'], ['unfamiliar', '不熟悉'], ['all', '全部词条（自由复习）']].map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="field"><label for="study-size">每组数量</label><input type="number" name="size" id="study-size" min="1" max="100" value="${data.preferences.groupSize}" required></div></div><div class="field"><label for="study-practice">练习方式</label><select id="study-practice" name="practice"><option value="mixed">分轮记忆 + 可选拼写</option><option value="spelling">只练拼写</option></select></div><label class="check-field"><input type="checkbox" name="spelling" ${data.preferences[selected === 'new' ? 'learnSpelling' : 'reviewSpelling'] ? 'checked' : ''}> 记忆完成后练习拼写</label><p class="helper-note" id="study-availability" role="status"></p><details class="format-help"><summary>记忆与复习怎样进行？</summary><p>新词：选义 → 三次词义回忆，共四轮。已掌握词：先判断认识、模糊或不认识。答错后四轮重学；认识后先核对，可用「记错了」纠正。组后按设置练习拼写。</p><p>通过后按 1、3、7、14、30、60 天安排复习。提前练习不延长间隔。这是可解释的本地规则，不是不背单词的专有算法。</p></details><div class="${inDialog ? 'modal-actions' : 'setup-actions'}">${inDialog ? button('取消', 'close-modal') : ''}<button type="submit" class="button primary">开始学习 ${icon('arrow')}</button></div></form>`;
}
function updateStudyAvailability() {
  const form = modal.open ? $('#study-form', modal) : $('#study-form', main);
  if (!form) return;
  const count = filterWords(data.words, { paperId: form.elements.paperId.value, filter: form.elements.filter.value }).length;
  const size = Number(form.elements.size.value);
  const validSize = Number.isInteger(size) && size >= 1 && size <= 100;
  $('#study-availability', form).textContent = !count ? '当前范围没有符合条件的词条，请切换状态或试卷。' : !validSize ? '每组数量须为 1—50。' : `符合条件 ${count} 个，本组将学习 ${Math.min(count, size)} 个。`;
  $('button[type="submit"]', form).disabled = !count || !validSize;
  form.elements.spelling.disabled = form.elements.practice.value === 'spelling';
}
function studyDialog(paperId = '', requestedFilter = null) {
  if (activeSession()) { go('/study'); toast('有一组尚未完成，可以继续或提前结束。'); return; }
  if (!data.words.length) { go('/import'); toast('请先录入词条。'); return; }
  const inlineForm = $('#study-form', main);
  if (inlineForm) {
    inlineForm.elements.paperId.value = paperId;
    if (requestedFilter) { inlineForm.elements.filter.value = requestedFilter; inlineForm.elements.spelling.checked = data.preferences[requestedFilter === 'new' ? 'learnSpelling' : 'reviewSpelling']; }
    updateStudyAvailability(); inlineForm.elements.size.focus(); return;
  }
  showModal('开始复习', studyForm(paperId, true, requestedFilter));
  updateStudyAvailability();
}
function wordDetail(id) {
  const word = data.words.find(w => w.id === id); if (!word) return;
  const sources = word.sources.filter(s => !route().paperId || s.paperId === route().paperId);
  showModal(word.english, `<p class="detail-label">词条详情</p><div class="actions">${statusTag(word.status)}${button('听发音', 'pronounce', 'text', `data-id="${word.id}"`)}${button(word.details.starred ? '取消收藏' : '收藏', 'toggle-star', 'text', `data-id="${word.id}" aria-pressed="${word.details.starred}"`)}</div><p class="word-review">${h(reviewNote(word))}</p>${sources.map(s => `<div class="detail-source"><p class="source-line">${h(s.label)}</p><p class="word-meaning">${s.meanings.map(h).join('；')}</p><div class="actions">${button('编辑', 'edit-entry', 'text small', `data-id="${s.id}"`)}${button('从这套试卷移除', 'delete-entry', 'text small', `data-id="${s.id}"`)}</div></div>`).join('')}<div class="detail-source"><h3>我的语境与笔记</h3>${word.details.example ? `<blockquote>${h(word.details.example)}</blockquote><p>${h(word.details.translation)}</p>` : ''}<p class="saved-note">${h(word.details.note || '还没有记录，试着写下它在试卷里的原句。')}</p>${button('编辑笔记', 'edit-note', 'text', `data-id="${word.id}"`)}</div><p class="helper-note">掌握状态和复习计划在所有试卷间共享，释义按试卷独立保存。</p>`);
}
function noteDialog(id) {
  const word = data.words.find(word => word.id === id); if (!word) return;
  showModal(`${word.english} · 我的笔记`, `<form id="note-form" data-id="${id}"><div class="field"><label for="note-example">语境原句</label><textarea id="note-example" name="example" maxlength="5000" placeholder="粘贴试卷里的原句，不自动编造例句。">${h(word.details.example)}</textarea></div><div class="field"><label for="note-translation">原句译文</label><textarea id="note-translation" name="translation" maxlength="5000">${h(word.details.translation)}</textarea></div><div class="field"><label for="note-text">搭配、词根或记忆联想</label><textarea id="note-text" name="note" maxlength="5000">${h(word.details.note)}</textarea></div><div class="modal-actions">${button('取消', 'close-modal')}<button class="button primary" type="submit">保存笔记</button></div></form>`);
}
function pronounce(text, accent = data.preferences.accent) {
  if (!('speechSynthesis' in window)) return toast('此浏览器不支持设备朗读，请换用支持语音的浏览器。');
  const voices = speechSynthesis.getVoices();
  const voice = voices.find(voice => voice.lang.replace('_', '-').toLowerCase() === accent.toLowerCase());
  if (!voice) return toast(`设备尚未提供${accent === 'en-GB' ? '英音' : '美音'}语音。请在系统中安装对应英语语音后重试。`);
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text); utterance.lang = accent; utterance.voice = voice; utterance.rate = 0.9;
  utterance.onerror = event => { if (!['interrupted', 'canceled'].includes(event.error)) toast('设备朗读失败，请检查系统语音设置。'); };
  speechSynthesis.speak(utterance);
}
function findEntry(id) { for (const word of data.words) { const source = word.sources.find(s => s.id === id); if (source) return { word, source }; } return null; }
function editDialog(id) {
  const item = findEntry(id); if (!item) return;
  showModal('编辑词条', `<p class="modal-description">${h(item.source.label)}</p><form id="entry-form" data-id="${id}"><div class="field"><label for="entry-english">英文</label><input id="entry-english" name="english" maxlength="300" value="${h(item.word.english)}" required></div><div class="field"><label for="entry-meaning">中文释义</label><textarea id="entry-meaning" name="meaning" maxlength="5000" required>${h(item.source.meanings.join('\n'))}</textarea></div>${activeSession() && data.session.items.some(i => i.wordId === item.word.id) ? '<p class="notice warning">这个词在当前学习组中。保存修改会结束该组，已记录的掌握状态保留。</p>' : ''}<div class="modal-actions">${button('取消', 'close-modal')}<button type="submit" class="button primary">保存修改</button></div></form>`);
}
function confirmDialog(title, message, action, extra = '') { showModal(title, `<p class="modal-description">${h(message)}</p><div class="modal-actions">${button('取消', 'close-modal')}${button('确认', action, 'danger', extra)}</div>`); }
async function studyAction(action, answer) {
  const s = data.session;
  if (action === 'continue') practicePanel = 'context';
  data.session = await api('/session/action', { sessionId: s.id, revision: s.revision, action, answer });
  if (data.session.phase === 'done' || ['remember', 'forget', 'continue'].includes(action)) await refresh();
  render();
  requestAnimationFrame(() => { const target = $('#spelling-answer') || $('[data-action="study-continue"]'); if (target && !modal.open) target.focus({ preventScroll: true }); });
}
async function recheck() {
  if (!draft.paperId) throw new Error('请先选择或新建一套试卷');
  const generatedBy = draft.preview.generatedBy;
  draft.preview = await api('/import/preview', { paperId: draft.paperId, rows: draft.preview.rows });
  if (generatedBy) draft.preview.generatedBy = generatedBy;
  draft.dirty = false; draft.requestId = crypto.randomUUID(); renderPreview();
}
function importPrompt() {
  const source = data.sources?.find(item => item.id === draft?.paperId);
  const profile = data.sourceProfiles?.find(item => item.exam === (source?.exam || 'cet6'));
  return profile?.manualImportPrompt || '请把英语原文中的单词和短语整理成 Markdown 两列表格，列名为“英文”和“中文释义”。只保留原文中的英文表达和语境释义，不添加其他列或解释。';
}
async function handleAction(element) {
  const action = element.dataset.action;
  if (action === 'clear-draft') {
    if (!hasDraftContent(draft)) return toast('暂无需要清空的草稿');
    return confirmDialog('清空录入草稿？', '将清空当前输入、模型原文和预览修改。已经保存到词库的内容不受影响。', 'confirm-clear-draft');
  }
  if (action === 'confirm-clear-draft') { draft = null; persistDraft(); closeModal(); renderImport(); return toast('录入草稿已清空'); }
  if (action === 'refresh-calendar') { await refresh(); render(); $('[data-action="refresh-calendar"]')?.focus({ preventScroll: true }); toast('复习日历已更新'); return; }
  if (action === 'calendar-day') {
    await refresh();
    if (!modal.open) {
      render();
      [...main.querySelectorAll('[data-action="calendar-day"]')].find(button => button.dataset.day === element.dataset.day)?.focus({ preventScroll: true });
    }
    return calendarDay(element.dataset.day, Number(element.dataset.page) || 0);
  }
  if (action === 'calendar-review') { closeModal(); return studyDialog('', 'due'); }
  if (action === 'logout') {
    if (hasDraftContent(draft) && !window.confirm('退出会清空当前标签页的录入草稿，包括模型原文和预览修改。确认退出？')) return;
    await api('/logout', {}); draft = null; persistDraft(); location.assign('/login'); return;
  }
  if (action === 'close-modal') return closeModal();
  if (action === 'new-paper') return newPaperDialog(element.dataset.context || '');
  if (action === 'import') return go(`/import${element.dataset.paper ? `?paper=${element.dataset.paper}` : ''}`);
  if (action === 'start-dialog') return studyDialog(element.dataset.paper || '');
  if (action === 'review-due' || action === 'review-new') return studyDialog('', action === 'review-due' ? 'due' : 'new');
  if (action === 'export-words') {
    const paperId = route().paperId;
    const words = filterWords(data.words, { paperId, filter, query });
    if (!words.length) throw new Error('没有可导出的词条');
    const url = URL.createObjectURL(new Blob(['\uFEFF', wordTable(words, paperId)], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `afterword-${filter}-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return toast(`已导出 ${words.length} 个词条；每个不同释义单独一行，可重新导入`);
  }
  if (action === 'filter') { filter = element.dataset.value; return renderWords(route().paperId); }
  if (action === 'word-detail') return wordDetail(element.dataset.id);
  if (action === 'edit-note') return noteDialog(element.dataset.id);
  if (action === 'pronounce' || action === 'speak-example') {
    const word = data.words.find(word => word.id === element.dataset.id);
    if (word) pronounce(action === 'pronounce' ? word.english : word.details.example, element.dataset.accent || data.preferences.accent);
    return;
  }
  if (action === 'toggle-star') {
    const word = data.words.find(word => word.id === element.dataset.id); if (!word) return;
    await api(`/words/${word.id}/details`, { ...word.details, starred: !word.details.starred }, 'PUT'); await refresh(); render();
    if (modal.open) wordDetail(word.id);
    return;
  }
  if (action === 'previous-word') {
    const item = data.session.items.find(item => item.wordId === data.session.lastWordId);
    if (item) showModal('上一词 · 回看', `<h3 class="detail-english">${h(item.english)}</h3>${studyDefinitions(item.sources)}<p class="helper-note">仅回看，不更改刚才的作答记录。当前词的进度保持不变。</p>`);
    return;
  }
  if (action === 'practice-panel') {
    if (!['context', 'note', 'sources'].includes(element.dataset.panel) || !data.session?.pending) return;
    practicePanel = element.dataset.panel;
    renderPractice(data.session);
    $(`.notebook-tabs [data-panel="${practicePanel}"]`)?.focus({ preventScroll: true });
    return;
  }
  if (action === 'answer-choice') {
    const state = data.session, track = state.tracks.find(track => track.wordId === state.queue[0]);
    return studyAction('choose', track.options[Number(element.dataset.index)]);
  }
  if (action === 'retry-failed') {
    data.session = await api('/session', { mode: 'context', filter: 'all', size: 100, retrySessionId: data.session.id });
    return render();
  }
  if (action === 'edit-entry') return editDialog(element.dataset.id);
  if (action === 'delete-entry') {
    const item = findEntry(element.dataset.id); if (!item) return;
    return confirmDialog('从这套试卷删除？', `将从「${item.source.label}」移除 ${item.word.english}。其他试卷的关联仍保留。${activeSession() && data.session.items.some(i => i.wordId === item.word.id) ? '此词在当前学习组中，删除会结束该组。' : ''}`, 'confirm-delete-entry', `data-id="${element.dataset.id}"`);
  }
  if (action === 'confirm-delete-entry') { await api(`/entries/${element.dataset.id}`, {}, 'DELETE'); closeModal(); await refresh(); render(); return toast('已从这套试卷移除'); }
  if (action === 'delete-paper') {
    const paper = data.papers.find(p => p.id === element.dataset.id);
    return confirmDialog('删除这套试卷？', `将删除「${paper.label}」及其词条关联，仅出现在这套试卷的词条也会被删除。其他试卷的词条和进度保留。涉及这些词的当前学习组会结束。`, 'confirm-delete-paper', `data-id="${paper.id}"`);
  }
  if (action === 'confirm-delete-paper') { await api(`/papers/${element.dataset.id}`, {}, 'DELETE'); closeModal(); await refresh(); go('/papers'); return toast('试卷已删除'); }
  if (action === 'sample') {
    if (hasDraftContent(draft)) return confirmDialog('替换当前输入？', '将把输入框里的文字替换为格式示例并清除当前预览修改，已保存的词库不会改变。', 'confirm-sample');
    return setSample();
  }
  if (action === 'confirm-sample') { closeModal(); return setSample(); }
  if (action === 'copy-prompt') {
    const prompt = importPrompt();
    try { await navigator.clipboard.writeText(prompt); toast('整理要求已复制，可粘贴给大模型使用'); }
    catch { showModal('复制整理要求', `<textarea class="import-source" readonly aria-label="词汇整理要求">${h(prompt)}</textarea><p class="helper-note">选择文字并复制即可。</p>`); }
    return;
  }
  if (action === 'model-preview') {
    if (!draft.paperId) throw new Error('请先选择或新建一套试卷');
    if (!draft.modelText?.trim()) throw new Error('请先粘贴英文原文');
    if (!modelStatus.ready) throw new Error(modelStatus.message);
    const feedback = $('#model-feedback'); feedback.textContent = '正在整理，请稍候…';
    try {
      draft.preview = await api('/llm/preview', { paperId: draft.paperId, text: draft.modelText });
      draft.dirty = false; draft.requestId = crypto.randomUUID(); renderPreview();
      feedback.textContent = '整理完成，请核对下方词条后保存。';
      $('#import-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) { feedback.textContent = error.message; throw error; }
    return;
  }
  if (action === 'parse') {
    if (!draft.paperId) throw new Error('请先选择或新建一套试卷');
    if (!draft.text.trim()) throw new Error('请先粘贴表格或文本');
    draft.preview = await api('/import/preview', { paperId: draft.paperId, text: draft.text }); draft.dirty = false; draft.requestId = crypto.randomUUID(); renderPreview(); $('#import-preview').scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
  }
  if (action === 'recheck') { await recheck(); return toast(draft.preview.counts.invalid ? '仍有异常行，请修改或排除' : '检查完成，可以确认保存'); }
  if (action === 'save-import') {
    if (draft.dirty) { await recheck(); return toast('修改已重新检查，请核对结果后再次确认保存'); }
    if (draft.preview.counts.invalid) throw new Error('请先修改或取消勾选异常行，再重新检查');
    const result = await api('/import/confirm', { paperId: draft.paperId, rows: draft.preview.rows, requestId: draft.requestId });
    const paperId = draft.paperId; draft = null; persistDraft(); await refresh(); go(`/papers/${paperId}`); return toast(`已保存：新增 ${result.counts.added}，更新 ${result.counts.conflict}，重复跳过 ${result.counts.duplicate}`);
  }
  if (action === 'pause-study') { window.speechSynthesis?.cancel(); await refresh(); go('/home'); return toast('进度已保存，随时可以继续'); }
  if (action === 'end-study') return confirmDialog('提前结束这一组？', '已记录的掌握状态会保留。若只是暂时离开，可选择取消后点击“暂停”，下次接着学。', 'confirm-end-study');
  if (action === 'confirm-end-study') { closeModal(); return studyAction('end'); }
  if (action.startsWith('study-')) return studyAction(action.slice(6));
  if (action === 'confirm-restore') {
    const result = await api('/backup/restore', restoreData); restoreData = null; draft = null; persistDraft(); closeModal(); await refresh(); render();
    return showModal('恢复完成', `<p class="modal-description">已恢复 ${result.counts.papers} 套试卷、${result.counts.words} 个词条。</p><p class="helper-note">恢复前的数据备份已保留：</p><p class="storage-path">${h(result.backupFile)}</p><div class="modal-actions">${button('完成', 'close-modal', 'green')}</div>`);
  }
  if (action === 'retry') { await refresh(); return render(); }
}
function setSample() {
  draft.text = '| 英文 | 中文释义 |\n| --- | --- |\n| accumulate | 积累；积聚 |\n| in the long run | 从长远来看 |\n| sustainable | 可持续的 |';
  draft.preview = null; renderImport(); toast('已填入示例，确认保存后才会加入词库');
}
async function run(work, trigger) {
  if (busy) return;
  busy = true;
  if (trigger) trigger.disabled = true;
  const lockedFields = [...document.querySelectorAll('input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')];
  for (const field of lockedFields) field.disabled = true;
  main.setAttribute('aria-busy', 'true');
  try { await work(); }
  catch (error) {
    if (error.status === 409) { await refresh().catch(() => {}); render(); }
    if (modal.open && $('#modal-error')) $('#modal-error').textContent = error.message;
    toast(error.message);
  } finally {
    busy = false; main.removeAttribute('aria-busy');
    if (pendingNavigation) { pendingNavigation = false; closeModal(); render(); window.scrollTo(0, 0); }
    for (const field of lockedFields) if (field.isConnected) field.disabled = false;
    if (trigger?.isConnected) trigger.disabled = false;
    updateStudyAvailability();
    persistDraft();
  }
}
document.addEventListener('click', event => {
  if (event.target.closest('.skip-link')) { event.preventDefault(); main.focus(); return; }
  if (busy && event.target.closest('a[href^="#"]')) { event.preventDefault(); return; }
  const element = event.target.closest('[data-action]');
  if (!element || element.disabled) return;
  event.preventDefault(); run(() => handleAction(element), element);
});
document.addEventListener('submit', event => {
  event.preventDefault(); const form = event.target, values = Object.fromEntries(new FormData(form));
  run(async () => {
    if (form.id === 'paper-form') {
      const paper = await api('/papers', { examMonth: values.examMonth, volume: values.volume ? Number(values.volume) : 0 });
      closeModal(); await refresh();
      if (form.dataset.context === 'import' && draft) { draft.paperId = paper.id; draft.dirty = !!draft.preview; draft.requestId = null; history.replaceState(null, '', '#/import'); renderImport(); }
      else go(`/papers/${paper.id}`);
      toast(paper.existing ? '这套试卷已存在' : '试卷已创建，可以开始录入词条');
    } else if (form.id === 'entry-form') {
      await api(`/entries/${form.dataset.id}`, values, 'PUT'); closeModal(); await refresh(); render(); toast('词条已更新');
    } else if (form.id === 'study-form') {
      data.session = await api('/session', { paperId: values.paperId || null, filter: values.filter, size: Number(values.size), mode: 'context', spelling: values.spelling === 'on', practice: values.practice }); closeModal(); go('/study');
    } else if (form.id === 'spelling-form') {
      await studyAction('spell', values.answer);
    } else if (form.id === 'preferences-form') {
      await api('/preferences', { ...values, dailyGoal: Number(values.dailyGoal), groupSize: Number(values.groupSize), learnSpelling: values.learnSpelling === 'on', reviewSpelling: values.reviewSpelling === 'on' }, 'PUT'); await refresh(); render(); toast('学习偏好已保存');
    } else if (form.id === 'note-form') {
      const word = data.words.find(word => word.id === form.dataset.id);
      await api(`/words/${word.id}/details`, { ...word.details, ...values }, 'PUT'); closeModal(); await refresh(); render(); toast('语境与笔记已保存');
    }
  }, $('button[type="submit"]', form));
});
document.addEventListener('input', event => {
  const element = event.target;
  if (element.id === 'paper-search') { paperQuery = element.value; renderPaperGrid(); }
  if (element.id === 'word-search') { query = element.value; renderWordRows(); }
  if (element.id === 'study-size') updateStudyAvailability();
  if (element.id === 'model-text') draft.modelText = element.value;
  if (element.id === 'import-text') { draft.text = element.value; if (draft.preview) { draft.preview = null; $('#import-preview').innerHTML = ''; } }
  const row = element.closest('[data-row]');
  if (row && element.dataset.field) {
    const record = draft.preview.rows[Number(row.dataset.row)], field = element.dataset.field;
    if (field === 'included') record.excluded = !element.checked;
    else { record[field] = element.value; if (field === 'english' || field === 'meaning') record.error = ''; }
    draft.dirty = true; $('#preview-note').textContent = '预览有修改，请重新检查后保存。';
  }
  if (['import-text', 'model-text'].includes(element.id) || row) queueDraftSave();
});
document.addEventListener('change', event => {
  if (['study-paper', 'study-filter', 'study-practice'].includes(event.target.id)) {
    if (event.target.id === 'study-filter') event.target.form.elements.spelling.checked = data.preferences[event.target.value === 'new' ? 'learnSpelling' : 'reviewSpelling'];
    updateStudyAvailability();
  }
  if (event.target.id === 'import-paper') { draft.paperId = event.target.value; draft.dirty = !!draft.preview; draft.requestId = null; history.replaceState(null, '', '#/import'); renderPreview(); persistDraft(); }
  if (event.target.id === 'backup-file') {
    const file = event.target.files[0]; if (!file) return;
    run(async () => {
      if (file.size > 30_000_000) throw new Error('备份超过 30 MB，无法直接恢复');
      try { restoreData = JSON.parse(await file.text()); } catch { throw new Error('这个文件不是有效的 JSON 备份'); }
      const counts = await api('/backup/preview', restoreData);
      showModal('确认恢复这份备份？', `<p class="modal-description">文件：${h(file.name)}</p><div class="notice">${counts.papers} 套试卷 · ${counts.words} 个词条 · ${counts.entries} 条试卷关联<br>${counts.activeSession ? '包含可继续的学习进度' : '没有未完成的学习组'}</div><p class="modal-description">恢复将整体替换当前词库，并清空本标签页的录入草稿。恢复前会自动备份现有数据到 data/backups/。</p><div class="modal-actions">${button('取消', 'close-modal')}${button('确认并恢复', 'confirm-restore', 'primary')}</div>`);
    }).finally(() => { event.target.value = ''; });
  }
});
document.addEventListener('keydown', event => {
  if (modal.open || busy || route().path !== '/study' || !activeSession() || /^(INPUT|TEXTAREA|SELECT|A|SUMMARY)$/.test(event.target.tagName) || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  const s = data.session;
  let action;
  if (s.mode === 'context') {
    if (event.target.tagName === 'BUTTON' && !/^[1-4cC]$/.test(event.key)) return;
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (s.pending) {
      if (event.code === 'Space' || event.key === 'Enter') action = 'continue';
      if (event.key.toLowerCase() === 'c' && s.pending.correct && s.phase !== 'spell') action = 'correct';
    } else if (s.phase === 'choice') {
      const track = s.tracks.find(track => track.wordId === s.queue[0]);
      const answer = track.options[Number(event.key) - 1];
      if (answer) { event.preventDefault(); run(() => studyAction('choose', answer)); return; }
      if (event.code === 'Space') action = 'unknown';
    } else if (['recall', 'reverse'].includes(s.phase)) {
      const track = s.tracks.find(track => track.wordId === s.queue[0]);
      action = { 1: 'unknown', 2: track.initialStatus === 'new' ? undefined : 'vague', 3: 'known' }[event.key];
    }
    if (action) { event.preventDefault(); run(() => studyAction(action)); }
    return;
  }
  if (event.target.tagName === 'BUTTON') return;
  if (event.code === 'Space') action = s.phase === 'browse' ? 'next' : !s.revealed ? 'reveal' : null;
  if (s.revealed && event.key === '1') action = 'forget';
  if (s.revealed && event.key === '2') action = 'remember';
  if (action) { event.preventDefault(); run(() => studyAction(action)); }
});
window.addEventListener('hashchange', () => {
  if (busy) { pendingNavigation = true; return; }
  closeModal(); render(); window.scrollTo(0, 0);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistDraft();
  if (document.visibilityState === 'visible' && !busy) run(async () => { await refresh(); if (!modal.open && route().path !== '/import') render(); else updateStudyAvailability(); });
});
window.addEventListener('pagehide', persistDraft);
window.addEventListener('beforeunload', event => {
  if (!hasDraftContent(draft)) return;
  persistDraft(); event.preventDefault(); event.returnValue = '';
});
try { await refresh(); render(); }
catch (error) { main.innerHTML = `<div class="fatal"><h2>暂时无法连接本机词库</h2><p>请确认终端中的服务正在运行。可以在项目目录执行 npm start，再重新连接。</p>${button('重新连接', 'retry', 'primary')}</div>`; toast(error.message); }
