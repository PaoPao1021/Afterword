import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalize, cleanMeanings, parseText } from './parser.js';
import { AppError } from './errors.js';
import { paperSource, sourceProfiles } from './sources.js';
import { isReviewDue, nextReview } from './review.js';
import { preparePractice, practiceAction, validatePractice } from './practice.js';
import { defaultPreferences, validatePreferences, learningStats, validateDetails } from './learning.js';

export { AppError } from './errors.js';
const assert = (condition, message) => { if (!condition) throw new AppError(message); };
const now = () => new Date().toISOString();
const statuses = ['new', 'unfamiliar', 'mastered'];
const paperLabel = paper => `${Number(paper.exam_month.slice(0, 4))}年${Number(paper.exam_month.slice(5))}月 · ${paper.volume ? `第${paper.volume}套` : '未注明套卷'}`;
const validMonth = s => typeof s === 'string' && /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(s);
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(id);
const validText = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const validTime = s => typeof s === 'string' && Number.isFinite(Date.parse(s));

export class Store {
  constructor(path, { clock = () => new Date() } = {}) {
    this.path = path;
    this.clock = clock;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS papers (id TEXT PRIMARY KEY, exam_month TEXT NOT NULL, volume INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(exam_month, volume));
      CREATE TABLE IF NOT EXISTS words (id TEXT PRIMARY KEY, english TEXT NOT NULL, normalized TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE, word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE, meanings TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(paper_id, word_id));
      CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY CHECK(id = 1), state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS import_receipts (request_id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS word_details (word_id TEXT PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS practice_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, word_id TEXT REFERENCES words(id) ON DELETE SET NULL, english TEXT NOT NULL, was_new INTEGER NOT NULL, completed_at TEXT NOT NULL, UNIQUE(session_id, word_id));
      PRAGMA user_version = 1;`);
    if (!this.all('PRAGMA table_info(words)').some(c => c.name === 'last_practised_at')) this.db.exec('ALTER TABLE words ADD COLUMN last_practised_at TEXT');
    this.transaction(() => {
      const columns = this.all('PRAGMA table_info(words)').map(column => column.name);
      if (!columns.includes('due_at')) this.db.exec('ALTER TABLE words ADD COLUMN due_at TEXT');
      if (!columns.includes('review_streak')) this.db.exec('ALTER TABLE words ADD COLUMN review_streak INTEGER NOT NULL DEFAULT 0');
    });
  }
  close() { this.db.close(); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  paper(id) { const p = this.get('SELECT * FROM papers WHERE id = ?', id); if (!p) throw new AppError('这套试卷不存在或已被删除', 404); return p; }
  createPaper({ examMonth, volume = 0 }) {
    assert(validMonth(examMonth), '请选择有效考试年月（1900—2199年）');
    assert(Number.isInteger(volume) && volume >= 0 && volume <= 99, '套卷应为 1—99，未注明时为 0');
    const existing = this.get('SELECT * FROM papers WHERE exam_month = ? AND volume = ?', examMonth, volume);
    if (existing) return { ...existing, label: paperLabel(existing), existing: true };
    const paper = { id: randomUUID(), exam_month: examMonth, volume, created_at: now() };
    this.run('INSERT INTO papers VALUES (?, ?, ?, ?)', paper.id, paper.exam_month, volume, paper.created_at);
    return { ...paper, label: paperLabel(paper) };
  }
  overview() {
    const papers = this.all('SELECT * FROM papers ORDER BY exam_month DESC, volume ASC').map(p => ({ ...p, label: paperLabel(p) }));
    const paperMap = new Map(papers.map(p => [p.id, p]));
    const details = new Map(this.all('SELECT * FROM word_details').map(row => [row.word_id, JSON.parse(row.value)]));
    const words = this.all('SELECT * FROM words ORDER BY created_at, id').map(w => ({ ...w, sources: [], details: details.get(w.id) || { starred: false, note: '', example: '', translation: '' } }));
    const wordMap = new Map(words.map(w => [w.id, w]));
    for (const entry of this.all('SELECT * FROM entries ORDER BY created_at, id')) {
      wordMap.get(entry.word_id)?.sources.push({ id: entry.id, paperId: entry.paper_id, label: paperMap.get(entry.paper_id).label, meanings: JSON.parse(entry.meanings), createdAt: entry.created_at });
    }
    for (const p of papers) {
      const selected = words.filter(w => w.sources.some(s => s.paperId === p.id));
      p.count = selected.length;
      p.mastered = selected.filter(w => w.status === 'mastered').length;
    }
    const sources = papers.map(p => ({ ...paperSource(p), label: p.label, count: p.count, mastered: p.mastered }));
    return { papers, sources, sourceProfiles: sourceProfiles(), words, session: this.session(), preferences: this.preferences(), stats: learningStats(this.all('SELECT * FROM practice_events'), this.clock()) };
  }
  preferences() { const row = this.get('SELECT value FROM preferences WHERE id = 1'); return row ? JSON.parse(row.value) : { ...defaultPreferences }; }
  setPreferences(value) {
    const preferences = validatePreferences(value);
    this.run('INSERT INTO preferences VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value', JSON.stringify(preferences));
    return preferences;
  }
  setWordDetails(id, value) {
    if (!this.get('SELECT id FROM words WHERE id = ?', id)) throw new AppError('词条不存在', 404);
    const details = validateDetails(value);
    this.run('INSERT INTO word_details VALUES (?, ?) ON CONFLICT(word_id) DO UPDATE SET value = excluded.value', id, JSON.stringify(details));
    return details;
  }
  preview({ paperId, text, rows }) {
    this.paper(paperId);
    if (text !== undefined) assert(typeof text === 'string' && text.length <= 2_000_000, '内容过长，请分批导入');
    const parsed = text !== undefined ? parseText(text) : { rows, ignored: 0 };
    assert(Array.isArray(parsed.rows) && parsed.rows.length <= 10000, '每次最多导入 10000 行');
    const known = new Map(this.all('SELECT w.normalized, e.meanings FROM entries e JOIN words w ON e.word_id = w.id WHERE e.paper_id = ?', paperId).map(e => [e.normalized, JSON.parse(e.meanings)]));
    const counts = { added: 0, duplicate: 0, conflict: 0, invalid: 0, excluded: 0 };
    const result = parsed.rows.map((row, index) => {
      assert(row && typeof row === 'object', '导入行格式无效');
      const r = { line: row.line || index + 1, raw: typeof row.raw === 'string' ? row.raw : '', english: typeof row.english === 'string' ? row.english.trim() : '', meaning: typeof row.meaning === 'string' ? row.meaning.trim() : '', excluded: !!row.excluded, strategy: row.strategy === 'replace' ? 'replace' : 'merge', error: typeof row.error === 'string' ? row.error : '' };
      if (r.excluded) { r.kind = 'excluded'; counts.excluded++; return r; }
      if (r.error || !validText(r.english, 300) || !validText(r.meaning, 5000)) {
        r.error ||= '英文和释义不能为空，英文最多 300 字符、释义最多 5000 字符'; r.kind = 'invalid'; counts.invalid++; return r;
      }
      const key = normalize(r.english), previous = known.get(key), incoming = cleanMeanings(r.meaning);
      r.previous = previous || [];
      r.kind = !previous ? 'added' : incoming.every(s => previous.includes(s)) ? 'duplicate' : 'conflict';
      counts[r.kind]++;
      known.set(key, r.kind === 'duplicate' ? previous : r.strategy === 'replace' ? incoming : [...new Set([...(previous || []), ...incoming])]);
      return r;
    });
    return { ...parsed, rows: result, counts };
  }
  word(english) {
    const key = normalize(english);
    let word = this.get('SELECT * FROM words WHERE normalized = ?', key);
    if (!word) {
      word = { id: randomUUID(), english: english.trim(), normalized: key, status: 'new', created_at: now() };
      this.run('INSERT INTO words (id, english, normalized, status, created_at) VALUES (?, ?, ?, ?, ?)', word.id, word.english, key, word.status, word.created_at);
    }
    return word;
  }
  confirmImport({ paperId, rows, requestId }) {
    assert(validId(requestId), '导入请求缺少标识，请重新预览');
    const payload = JSON.stringify({ paperId, rows });
    return this.transaction(() => {
      const receipt = this.get('SELECT * FROM import_receipts WHERE request_id = ?', requestId);
      if (receipt) { assert(receipt.payload === payload, '导入请求内容已改变，请重新预览'); return JSON.parse(receipt.result); }
      const preview = this.preview({ paperId, rows });
      assert(!preview.counts.invalid, '请先修正或排除所有异常行');
      assert(preview.rows.some(r => !r.excluded), '没有可保存的词条');
      for (const row of preview.rows) {
        if (row.excluded || row.kind === 'duplicate') continue;
        const word = this.word(row.english);
        const previous = this.get('SELECT * FROM entries WHERE paper_id = ? AND word_id = ?', paperId, word.id);
        const meanings = row.strategy === 'replace' ? cleanMeanings(row.meaning) : [...new Set([...(previous ? JSON.parse(previous.meanings) : []), ...cleanMeanings(row.meaning)])];
        if (previous) this.run('UPDATE entries SET meanings = ? WHERE id = ?', JSON.stringify(meanings), previous.id);
        else this.run('INSERT INTO entries VALUES (?, ?, ?, ?, ?)', randomUUID(), paperId, word.id, JSON.stringify(meanings), now());
      }
      const result = { counts: preview.counts };
      this.run('INSERT INTO import_receipts VALUES (?, ?, ?)', requestId, payload, JSON.stringify(result));
      return result;
    });
  }
  stopAffected(wordIds) {
    const state = this.session();
    if (state && state.phase !== 'done' && state.items.some(i => wordIds.includes(i.wordId))) {
      state.phase = 'done'; state.reason = 'content-changed'; state.queue = []; state.revealed = false; if (state.mode === 'context') state.pending = null; state.revision++; state.updatedAt = now(); this.saveSession(state);
    }
  }
  cleanupWords() { this.run('DELETE FROM words WHERE id NOT IN (SELECT word_id FROM entries)'); }
  editEntry(id, { english, meaning }) {
    assert(validText(english, 300) && validText(meaning, 5000), '请填写英文和中文释义，英文最多 300 字符、释义最多 5000 字符');
    return this.transaction(() => {
      const entry = this.get('SELECT * FROM entries WHERE id = ?', id);
      if (!entry) throw new AppError('词条不存在', 404);
      const word = this.word(english);
      const collision = this.get('SELECT * FROM entries WHERE paper_id = ? AND word_id = ? AND id != ?', entry.paper_id, word.id, id);
      assert(!collision, '此试卷已有该英文，请在已有词条中修改释义，或使用导入合并');
      this.stopAffected([entry.word_id, word.id]);
      this.run('UPDATE entries SET word_id = ?, meanings = ? WHERE id = ?', word.id, JSON.stringify(cleanMeanings(meaning)), id);
      this.cleanupWords();
      return { ok: true };
    });
  }
  deleteEntry(id) {
    return this.transaction(() => {
      const entry = this.get('SELECT * FROM entries WHERE id = ?', id);
      if (!entry) throw new AppError('词条不存在', 404);
      this.stopAffected([entry.word_id]); this.run('DELETE FROM entries WHERE id = ?', id); this.cleanupWords(); return { ok: true };
    });
  }
  deletePaper(id) {
    return this.transaction(() => {
      this.paper(id); this.stopAffected(this.all('SELECT word_id FROM entries WHERE paper_id = ?', id).map(e => e.word_id));
      this.run('DELETE FROM papers WHERE id = ?', id); this.cleanupWords(); return { ok: true };
    });
  }
  session() { const row = this.get('SELECT state FROM sessions WHERE id = 1'); return row ? JSON.parse(row.state) : null; }
  saveSession(state) { this.run('INSERT INTO sessions VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state', JSON.stringify(state)); }
  startSession({ paperId = null, filter = 'all', size = 10, mode = 'legacy', spelling, practice = 'mixed', retrySessionId = null }) {
    return this.transaction(() => {
      assert(['all', 'new', 'unfamiliar', 'due'].includes(filter), '请选择有效学习范围');
      assert(Number.isInteger(size) && size >= 1 && size <= 100, '每组数量须为 1—100');
      assert(['legacy', 'context'].includes(mode), '学习模式无效');
      const previous = this.session();
      if (previous && previous.phase !== 'done') throw new AppError('已有未完成的学习组，请继续或先结束它', 409);
      if (retrySessionId && (!previous || previous.id !== retrySessionId)) throw new AppError('错词组已改变，请刷新页面', 409);
      if (paperId) this.paper(paperId);
      const time = this.clock();
      const allWords = this.overview().words;
      const words = allWords.filter(w => (!paperId || w.sources.some(s => s.paperId === paperId)) && (retrySessionId ? previous.failed.includes(w.id) : filter === 'all' || (filter === 'due' ? isReviewDue(w, time) : w.status === filter)));
      // Rotate across the whole collection, so later groups cannot be starved.
      words.sort((a, b) => (a.last_practised_at || '').localeCompare(b.last_practised_at || '') || (statuses.indexOf(a.status) - statuses.indexOf(b.status)));
      if (filter === 'due') words.sort((first, second) => (Date.parse(first.due_at) || 0) - (Date.parse(second.due_at) || 0));
      const items = words.slice(0, size).map(w => ({ wordId: w.id, english: w.english, sources: w.sources.filter(source => !paperId || source.paperId === paperId).map(s => ({ paperId: s.paperId, label: s.label, meanings: s.meanings })) }));
      assert(items.length, filter === 'due' ? '这个范围暂时没有到期词条，可以学习新词或自由复习' : '这个范围还没有可学习的词条');
      for (const item of items) this.run('UPDATE words SET last_practised_at = ? WHERE id = ?', now(), item.wordId);
      const state = { id: randomUUID(), revision: 0, paperId, filter, items, phase: 'browse', browseIndex: 0, queue: [], passedEn: [], passedZh: [], failed: [], revealed: false, answers: 0, reason: null, createdAt: now(), updatedAt: now() };
      if (mode === 'context') preparePractice(state, allWords, { spelling: spelling ?? (filter === 'new' ? this.preferences().learnSpelling : this.preferences().reviewSpelling), practice });
      this.saveSession(state); return state;
    });
  }
  sessionAction({ sessionId, revision, action, answer }) {
    return this.transaction(() => {
      const s = this.session();
      if (!s || s.id !== sessionId) throw new AppError('学习组已改变，请刷新页面', 409);
      if (s.revision !== revision) throw new AppError('学习进度已更新，请使用当前词卡继续', 409);
      assert(s.phase !== 'done', '这组学习已结束');
      if (s.mode === 'context') {
        const effects = practiceAction(s, { action, answer });
        for (const wordId of effects.failures) this.run("UPDATE words SET status = 'unfamiliar', review_streak = 0, due_at = ? WHERE id = ?", this.clock().toISOString(), wordId);
        for (const wordId of effects.completions) {
          const review = nextReview(this.get('SELECT * FROM words WHERE id = ?', wordId), this.clock());
          this.run("UPDATE words SET status = 'mastered', due_at = ?, review_streak = ? WHERE id = ?", review.dueAt, review.streak, wordId);
          const track = s.tracks.find(item => item.wordId === wordId);
          this.run('INSERT OR IGNORE INTO practice_events VALUES (?, ?, ?, ?, ?, ?)', randomUUID(), s.id, wordId, s.items.find(item => item.wordId === wordId).english, Number(track.initialStatus === 'new'), this.clock().toISOString());
        }
        s.revision++; s.updatedAt = this.clock().toISOString(); this.saveSession(s); return s;
      }
      if (action === 'end') { s.phase = 'done'; s.reason = 'ended'; s.queue = []; s.revealed = false; }
      else if (action === 'next') {
        assert(s.phase === 'browse', '当前不在浏览阶段');
        s.browseIndex++;
        if (s.browseIndex >= s.items.length) { s.phase = 'en'; s.queue = s.items.map(i => i.wordId); }
      } else if (action === 'reveal') {
        assert(s.phase === 'en' || s.phase === 'zh', '当前不是回忆阶段'); s.revealed = true;
      } else if (action === 'remember' || action === 'forget') {
        assert((s.phase === 'en' || s.phase === 'zh') && s.revealed, '请先展开答案，再判断是否记住');
        const wordId = s.queue.shift();
        if (action === 'forget') {
          if (!s.failed.includes(wordId)) s.failed.push(wordId);
          this.run("UPDATE words SET status = 'unfamiliar', review_streak = 0, due_at = ? WHERE id = ?", this.clock().toISOString(), wordId);
          s.queue.splice(Math.min(3, s.queue.length), 0, wordId);
        } else {
          (s.phase === 'en' ? s.passedEn : s.passedZh).push(wordId);
          if (s.phase === 'zh') {
            const review = nextReview(this.get('SELECT * FROM words WHERE id = ?', wordId), this.clock());
            this.run("UPDATE words SET status = 'mastered', due_at = ?, review_streak = ? WHERE id = ?", review.dueAt, review.streak, wordId);
          }
        }
        s.answers++; s.revealed = false;
        if (!s.queue.length) {
          if (s.phase === 'en') { s.phase = 'zh'; s.queue = s.items.map(i => i.wordId); }
          else { s.phase = 'done'; s.reason = 'completed'; }
        }
      } else throw new AppError('未知学习操作');
      s.revision++; s.updatedAt = now(); this.saveSession(s); return s;
    });
  }
  backup() {
    return { format: 'cet6-review', version: 2, exportedAt: now(), papers: this.all('SELECT * FROM papers'), words: this.all('SELECT * FROM words'), entries: this.all('SELECT * FROM entries').map(e => ({ ...e, meanings: JSON.parse(e.meanings) })), session: this.session(), preferences: this.preferences(), details: this.all('SELECT * FROM word_details').map(row => ({ wordId: row.word_id, ...JSON.parse(row.value) })), events: this.all('SELECT * FROM practice_events') };
  }
  validateBackup(data) {
    assert(data && data.format === 'cet6-review' && [1, 2].includes(data.version), '不是支持的备份文件（需要版本 1 或 2）');
    const unique = (list, key, label) => { const values = list.map(key); assert(new Set(values).size === values.length, `${label}存在重复记录`); };
    for (const key of ['papers', 'words', 'entries']) assert(Array.isArray(data[key]) && data[key].length <= 100000, `备份 ${key} 格式或数量无效`);
    for (const p of data.papers) assert(p && validId(p.id) && validMonth(p.exam_month) && Number.isInteger(p.volume) && p.volume >= 0 && p.volume <= 99 && validTime(p.created_at), '备份中的试卷格式无效');
    for (const w of data.words) assert(w && validId(w.id) && validText(w.english, 300) && w.normalized === normalize(w.english) && statuses.includes(w.status) && validTime(w.created_at), '备份中的英文词条格式无效');
    for (const w of data.words) assert(w.last_practised_at == null || validTime(w.last_practised_at), '备份中的练习时间无效');
    for (const word of data.words) {
      assert(word.due_at == null || validTime(word.due_at), '备份中的复习时间无效');
      assert(word.review_streak == null || (Number.isInteger(word.review_streak) && word.review_streak >= 0 && word.review_streak <= 6), '备份中的复习阶段无效');
      assert(!word.review_streak || (word.status === 'mastered' && word.due_at != null), '备份中的复习计划不一致');
      assert(word.status !== 'new' || (word.due_at == null && !word.review_streak), '未学习词条不能包含复习计划');
    }
    unique(data.papers, p => p.id, '试卷'); unique(data.papers, p => `${p.exam_month}/${p.volume}`, '试卷年月和套卷');
    unique(data.words, w => w.id, '词条'); unique(data.words, w => w.normalized, '英文');
    const paperIds = new Set(data.papers.map(p => p.id)), wordIds = new Set(data.words.map(w => w.id));
    for (const e of data.entries) assert(e && validId(e.id) && paperIds.has(e.paper_id) && wordIds.has(e.word_id) && Array.isArray(e.meanings) && e.meanings.length > 0 && e.meanings.length <= 10000 && e.meanings.every(m => validText(m, 5000)) && new Set(e.meanings).size === e.meanings.length && validTime(e.created_at), '备份中的试卷释义或关联无效');
    unique(data.entries, e => e.id, '试卷词条'); unique(data.entries, e => `${e.paper_id}/${e.word_id}`, '试卷词条关联');
    assert(data.words.every(w => data.entries.some(e => e.word_id === w.id)), '备份包含没有试卷来源的词条');
    if (data.version === 2) {
      validatePreferences(data.preferences);
      assert(Array.isArray(data.details) && data.details.length <= data.words.length && Array.isArray(data.events) && data.events.length <= 100000, '备份中的学习记录无效');
      for (const detail of data.details) { assert(detail && wordIds.has(detail.wordId), '笔记关联无效'); validateDetails(detail); }
      unique(data.details, detail => detail.wordId, '词条笔记');
      for (const event of data.events) assert(event && validId(event.id) && validId(event.session_id) && (event.word_id === null || wordIds.has(event.word_id)) && validText(event.english, 300) && [0, 1].includes(event.was_new) && validTime(event.completed_at), '学习记录格式无效');
      unique(data.events, event => event.id, '学习记录');
      unique(data.events.filter(event => event.word_id !== null), event => `${event.session_id}/${event.word_id}`, '学习记录');
    }
    const s = data.session;
    if (s !== null) {
      const context = s?.mode === 'context';
      assert(s && (s.mode === undefined || s.mode === 'legacy' || context) && (!context || data.version === 2) && validId(s.id) && Number.isInteger(s.revision) && s.revision >= 0 && (context ? ['choice', 'recall', 'reverse', 'spell', 'done'] : ['browse', 'en', 'zh', 'done']).includes(s.phase) && ['all', 'new', 'unfamiliar', 'due'].includes(s.filter) && typeof s.revealed === 'boolean' && Number.isInteger(s.answers) && s.answers >= 0 && validTime(s.createdAt) && validTime(s.updatedAt), '备份中的学习进度无效');
      assert(Array.isArray(s.items) && s.items.length >= 1 && s.items.length <= 100, '备份中的学习词卡无效');
      for (const i of s.items) assert(i && validId(i.wordId) && validText(i.english, 300) && Array.isArray(i.sources) && i.sources.length > 0 && i.sources.every(src => src && validId(src.paperId) && validText(src.label, 100) && Array.isArray(src.meanings) && src.meanings.length > 0 && src.meanings.every(m => validText(m, 5000))), '备份中的词卡内容无效');
      unique(s.items, i => i.wordId, '学习词卡');
      const ids = new Set(s.items.map(i => i.wordId));
      for (const k of ['queue', 'passedEn', 'passedZh', 'failed']) { assert(Array.isArray(s[k]) && s[k].every(id => ids.has(id)) && new Set(s[k]).size === s[k].length, '备份中的学习队列无效'); }
      assert(Number.isInteger(s.browseIndex) && s.browseIndex >= 0 && s.browseIndex <= s.items.length, '备份中的浏览进度无效');
      if (context) validatePractice(s);
      if (s.phase !== 'done') {
        assert(s.items.every(i => wordIds.has(i.wordId)) && (s.paperId === null || paperIds.has(s.paperId)), '备份中的学习词卡来源已丢失');
        if (context) assert(s.items.every(item => item.sources.every(source => paperIds.has(source.paperId))), '备份中的学习词卡来源已丢失');
        else if (s.phase === 'browse') assert(s.browseIndex < s.items.length && !s.queue.length && !s.passedEn.length && !s.passedZh.length && !s.revealed, '浏览进度不一致');
        else {
          const passed = s.phase === 'en' ? s.passedEn : s.passedZh;
          assert(s.queue.length > 0 && s.queue.length + passed.length === s.items.length && !s.queue.some(id => passed.includes(id)), '回忆队列不完整');
          assert(s.phase === 'en' ? s.passedZh.length === 0 : s.passedEn.length === s.items.length, '回忆阶段不一致');
        }
      }
    }
    return { papers: data.papers.length, words: data.words.length, entries: data.entries.length, activeSession: !!s && s.phase !== 'done' };
  }
  restore(data) {
    const counts = this.validateBackup(data);
    let backupFile = null;
    if (this.path !== ':memory:') {
      const backupDir = join(dirname(this.path), 'backups'); mkdirSync(backupDir, { recursive: true });
      backupFile = join(backupDir, `before-restore-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
      writeFileSync(backupFile, JSON.stringify(this.backup(), null, 2), { flag: 'wx', mode: 0o600 });
    }
    this.transaction(() => {
      this.db.exec('DELETE FROM practice_events; DELETE FROM word_details; DELETE FROM preferences; DELETE FROM entries; DELETE FROM words; DELETE FROM papers; DELETE FROM sessions; DELETE FROM import_receipts;');
      for (const p of data.papers) this.run('INSERT INTO papers VALUES (?, ?, ?, ?)', p.id, p.exam_month, p.volume, p.created_at);
      for (const w of data.words) this.run('INSERT INTO words (id, english, normalized, status, created_at, last_practised_at, due_at, review_streak) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', w.id, w.english, w.normalized, w.status, w.created_at, w.last_practised_at || null, w.due_at || null, w.review_streak || 0);
      for (const e of data.entries) this.run('INSERT INTO entries VALUES (?, ?, ?, ?, ?)', e.id, e.paper_id, e.word_id, JSON.stringify(e.meanings), e.created_at);
      if (data.version === 2) {
        this.setPreferences(data.preferences);
        for (const detail of data.details) this.setWordDetails(detail.wordId, detail);
        for (const event of data.events) this.run('INSERT INTO practice_events VALUES (?, ?, ?, ?, ?, ?)', event.id, event.session_id, event.word_id, event.english, event.was_new, event.completed_at);
      }
      if (data.session) this.saveSession(data.session);
    });
    return { counts, backupFile };
  }
}
