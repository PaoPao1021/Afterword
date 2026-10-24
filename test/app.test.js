import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { parseText, normalize } from '../lib/parser.js';
import { Store } from '../lib/store.js';
import { createApp } from '../server.js';

function fixture(t, path = ':memory:') {
  const store = new Store(path);
  t.after(() => store.close());
  const paper = store.createPaper({ examMonth: '2025-06', volume: 1 });
  return { store, paper };
}
function add(store, paper, text) {
  const preview = store.preview({ paperId: paper.id, text });
  return store.confirmImport({ paperId: paper.id, rows: preview.rows, requestId: randomUUID() });
}
function action(store, type) { const s = store.session(); return store.sessionAction({ sessionId: s.id, revision: s.revision, action: type }); }
function finish(store) {
  let safety = 0;
  while (store.session().phase !== 'done') {
    assert.ok(safety++ < 300);
    const s = store.session();
    action(store, s.phase === 'browse' ? 'next' : s.revealed ? 'remember' : 'reveal');
  }
  return store.session();
}

test('parser: all three formats, headers, code fences, phrases and escaped pipes', () => {
  for (const text of ['| 英文 | 中文释义 |\n| --- | --- |\n| in the long run | 从长远来看 |', '英文\t中文释义\nin the long run\t从长远来看', 'in the long run = 从长远来看']) {
    const result = parseText(text);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].english, 'in the long run');
    assert.equal(result.rows[0].meaning, '从长远来看');
    assert.equal(result.rows[0].error, '');
  }
  const fenced = parseText('```markdown\n| English | Meaning |\n| :--- | ---: |\n| a \\| b | 甲或乙 |\n```');
  assert.equal(fenced.ignored, 4);
  assert.equal(fenced.rows[0].english, 'a | b');
  assert.equal(fenced.unclosedFence, false);
  assert.equal(normalize('  In   The Long RUN  '), 'in the long run');
});

test('parser: malformed and empty fields remain visible with original line numbers', () => {
  const { rows } = parseText('\n说明文字\nword =\n = 释义\n| a | b | c |\nvalid = 有效');
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(r => r.line), [2, 3, 4, 5, 6]);
  assert.equal(rows.filter(r => r.error).length, 4);
  assert.equal(rows[0].raw, '说明文字');
});

test('parser: TSV retains literal pipes and reports trailing extra or empty columns', () => {
  const { rows } = parseText('word\t含有 | 的释义\nword\t释义\t\nword\t\n\t释义');
  assert.deepEqual([rows[0].english, rows[0].meaning, rows[0].error], ['word', '含有 | 的释义', '']);
  assert.match(rows[1].error, /恰好两列/);
  assert.match(rows[2].error, /不能为空/);
  assert.match(rows[3].error, /不能为空/);
  assert.equal(rows[1].raw, 'word\t释义\t');
});

test('papers are unique by month and volume, sorted by exam date', t => {
  const { store, paper } = fixture(t);
  assert.equal(store.createPaper({ examMonth: '2025-06', volume: 1 }).id, paper.id);
  store.createPaper({ examMonth: '2025-06', volume: 2 });
  store.createPaper({ examMonth: '2025-12' });
  assert.deepEqual(store.overview().papers.map(p => p.label), ['2025年12月 · 未注明套卷', '2025年6月 · 第1套', '2025年6月 · 第2套']);
  assert.throws(() => store.createPaper({ examMonth: '2025-13' }), /年月/);
});

test('import previews new, duplicate, conflict, invalid and exclusion; commit is atomic', t => {
  const { store, paper } = fixture(t);
  add(store, paper, 'retain = 保留');
  const p = store.preview({ paperId: paper.id, text: 'Retain = 保留\nretain = 记住\nsustain = 维持\n坏行' });
  assert.deepEqual(p.counts, { added: 1, duplicate: 1, conflict: 1, invalid: 1, excluded: 0 });
  assert.throws(() => store.confirmImport({ paperId: paper.id, rows: p.rows, requestId: randomUUID() }), /异常行/);
  assert.equal(store.overview().words.length, 1);
  p.rows[3].excluded = true;
  store.confirmImport({ paperId: paper.id, rows: p.rows, requestId: randomUUID() });
  const words = store.overview().words;
  assert.equal(words.length, 2);
  assert.deepEqual(words.find(w => w.normalized === 'retain').sources[0].meanings, ['保留', '记住']);
});

test('replace removes omitted meanings while merge subsets remain no-ops', t => {
  const { store, paper } = fixture(t);
  add(store, paper, 'retain = 保留\nretain = 记住');
  const rows = [{ english: 'retain', meaning: '保留', strategy: 'merge' }];
  assert.equal(store.preview({ paperId: paper.id, rows }).counts.duplicate, 1);
  rows[0].strategy = 'replace';
  const preview = store.preview({ paperId: paper.id, rows });
  assert.equal(preview.counts.conflict, 1);
  const request = { paperId: paper.id, rows: preview.rows, requestId: randomUUID() };
  store.confirmImport(request);
  store.confirmImport(request);
  assert.deepEqual(store.overview().words[0].sources[0].meanings, ['保留']);
  assert.equal(store.preview({ paperId: paper.id, rows }).counts.duplicate, 1);
});

test('import previews learning impact and invalidates affected cards only on confirmation', t => {
  const { store, paper } = fixture(t);
  add(store, paper, 'retain = 保留');
  const session = store.startSession({ mode: 'context' });
  const preview = store.preview({ paperId: paper.id, text: 'retain = 记住\nretain = 保持' });
  assert.equal(preview.studyImpact, 1);
  assert.deepEqual(store.session(), session);
  store.confirmImport({ paperId: paper.id, rows: preview.rows, requestId: randomUUID() });
  assert.equal(store.session().reason, 'content-changed');
  assert.equal(store.session().phase, 'done');
  assert.throws(() => store.sessionAction({ sessionId: session.id, revision: session.revision, action: 'unknown' }), { status: 409 });
  store.validateBackup(store.backup());
});

test('duplicate, excluded and other-paper imports preserve scoped learning', t => {
  const { store, paper } = fixture(t);
  add(store, paper, 'retain = 保留');
  const other = store.createPaper({ examMonth: '2025-12' });
  const session = store.startSession({ mode: 'context', paperId: paper.id });
  for (const [target, rows] of [
    [paper, [{ english: 'retain', meaning: '保留' }]],
    [paper, [{ english: 'retain', meaning: '记住', excluded: true }, { english: 'new', meaning: '新的' }]],
    [other, [{ english: 'retain', meaning: '保持' }]],
  ]) {
    const preview = store.preview({ paperId: target.id, rows });
    assert.equal(preview.studyImpact, 0);
    store.confirmImport({ paperId: target.id, rows: preview.rows, requestId: randomUUID() });
    assert.deepEqual(store.session(), session);
  }
});

test('correcting an invalid preview row allows it to be saved', t => {
  const { store, paper } = fixture(t);
  const p = store.preview({ paperId: paper.id, text: 'bad format' });
  Object.assign(p.rows[0], { english: 'correct', meaning: '正确的', error: '' });
  const checked = store.preview({ paperId: paper.id, rows: p.rows });
  assert.equal(checked.counts.invalid, 0);
  store.confirmImport({ paperId: paper.id, rows: checked.rows, requestId: randomUUID() });
  assert.equal(store.overview().words[0].english, 'correct');
});

test('preview normalizes untrusted row numbers including excluded rows', t => {
  const { store, paper } = fixture(t);
  const rows = ['<img src=x>', -1, 1.5, {}, Number.MAX_SAFE_INTEGER + 1, 42].map((line, index) => ({ line, english: 'word', meaning: '词', excluded: index === 0 }));
  assert.deepEqual(store.preview({ paperId: paper.id, rows }).rows.map(row => row.line), [1, 2, 3, 4, 5, 42]);
});

test('import checks current learning state and receipt replay cannot end a new group', t => {
  const { store, paper } = fixture(t);
  add(store, paper, 'retain = 保留');
  const preview = store.preview({ paperId: paper.id, text: 'retain = 记住' });
  assert.equal(preview.studyImpact, 0);
  store.startSession({ mode: 'context' });
  const request = { paperId: paper.id, rows: preview.rows, requestId: randomUUID() };
  const result = store.confirmImport(request);
  assert.equal(result.sessionEnded, true);
  const session = store.startSession({ mode: 'context' });
  assert.deepEqual(store.confirmImport(request), result);
  assert.deepEqual(store.session(), session);
  const invalid = store.preview({ paperId: paper.id, text: 'retain = 保持\nbroken' });
  assert.throws(() => store.confirmImport({ paperId: paper.id, rows: invalid.rows, requestId: randomUUID() }), /异常行/);
  assert.deepEqual(store.session(), session);
});

test('replacement replaces meanings and repeated confirmation is idempotent', t => {
  const { store, paper } = fixture(t);
  add(store, paper, 'retain = 保留');
  const rows = store.preview({ paperId: paper.id, text: 'retain = 记住\nnovel = 新颖的' }).rows;
  rows[0].strategy = 'replace';
  const request = { paperId: paper.id, rows, requestId: randomUUID() };
  assert.deepEqual(store.confirmImport(request), store.confirmImport(request));
  assert.equal(store.overview().words.length, 2);
  assert.deepEqual(store.overview().words.find(w => w.normalized === 'retain').sources[0].meanings, ['记住']);
  assert.throws(() => store.confirmImport({ ...request, rows: [] }), /已改变/);
  add(store, paper, 'Retain = 记住\nNovel = 新颖的');
  assert.equal(store.overview().words.length, 2);
});

test('duplicate rows within a batch merge exactly once and word forms remain distinct', t => {
  const { store, paper } = fixture(t);
  const result = add(store, paper, 'IN   the long RUN = 从长远来看\nin the long run = 从长远来看\nin the long run = 长期而言\nrun = 跑\nruns = 跑的第三人称单数');
  assert.equal(result.counts.added, 3);
  assert.equal(result.counts.conflict, 1);
  assert.equal(result.counts.duplicate, 1);
  assert.equal(store.overview().words.length, 3);
});

test('cross-paper meanings remain separate, learning deduplicates and mastery is shared', t => {
  const { store, paper } = fixture(t);
  const second = store.createPaper({ examMonth: '2025-12', volume: 2 });
  add(store, paper, 'novel = 新颖的'); add(store, second, 'NOVEL = 小说');
  const s = store.startSession({});
  assert.equal(s.items.length, 1); assert.equal(s.items[0].sources.length, 2);
  finish(store);
  assert.equal(store.overview().words[0].status, 'mastered');
  assert.deepEqual(store.overview().papers.map(p => p.mastered), [1, 1]);
});

test('learning requires reveal before judgment, repeats forgotten card after 3, rejects stale actions', t => {
  const { store, paper } = fixture(t);
  add(store, paper, 'a = 甲\nb = 乙\nc = 丙\nd = 丁\ne = 戊');
  store.startSession({});
  for (let i = 0; i < 5; i++) action(store, 'next');
  assert.throws(() => action(store, 'remember'), /展开答案/);
  const first = store.session().queue[0], before = store.session();
  action(store, 'reveal'); action(store, 'forget');
  assert.equal(store.session().queue[3], first);
  assert.equal(store.overview().words.find(w => w.id === first).status, 'unfamiliar');
  assert.throws(() => store.sessionAction({ sessionId: before.id, revision: before.revision, action: 'reveal' }), /已更新/);
  finish(store);
  assert.equal(store.overview().words.every(w => w.status === 'mastered'), true);
  assert.equal(store.session().failed.length, 1);
});

test('one-card groups repeat immediately; early exit preserves unfinished status', t => {
  const { store, paper } = fixture(t);
  add(store, paper, 'one = 一\ntwo = 二');
  const s = store.startSession({ size: 1 });
  action(store, 'next'); action(store, 'reveal'); action(store, 'forget');
  assert.deepEqual(store.session().queue, [s.items[0].wordId]);
  action(store, 'end');
  const statuses = store.overview().words.map(w => w.status).sort();
  assert.deepEqual(statuses, ['new', 'unfamiliar']);
  assert.equal(store.session().reason, 'ended');
  const unfamiliar = store.startSession({ filter: 'unfamiliar' });
  assert.equal(unfamiliar.items.length, 1);
});

test('English-only pass does not master a word; forgetting Chinese recall marks unfamiliar', t => {
  const { store, paper } = fixture(t);
  add(store, paper, 'retain = 保留'); store.startSession({});
  action(store, 'next'); action(store, 'reveal'); action(store, 'remember');
  assert.equal(store.session().phase, 'zh'); assert.equal(store.overview().words[0].status, 'new');
  action(store, 'reveal'); action(store, 'forget');
  assert.equal(store.overview().words[0].status, 'unfamiliar');
  finish(store); assert.equal(store.overview().words[0].status, 'mastered');
});

test('full collection rotates through more than two groups', t => {
  const { store, paper } = fixture(t);
  add(store, paper, Array.from({ length: 30 }, (_, i) => `word${i} = 词${i}`).join('\n'));
  const seen = new Set();
  for (let i = 0; i < 3; i++) { const s = store.startSession({}); for (const item of s.items) seen.add(item.wordId); finish(store); }
  assert.equal(seen.size, 30);
});

test('entry edits relink words and preserve existing mastery; deletions retain other papers', t => {
  const { store, paper } = fixture(t);
  const second = store.createPaper({ examMonth: '2025-12', volume: 1 });
  add(store, paper, 'old = 旧的'); add(store, second, 'known = 熟悉的');
  store.startSession({ paperId: second.id }); finish(store);
  const entryId = store.overview().words.find(w => w.english === 'old').sources[0].id;
  store.editEntry(entryId, { english: 'KNOWN', meaning: '已知的' });
  assert.equal(store.overview().words.length, 1); assert.equal(store.overview().words[0].status, 'mastered');
  store.deletePaper(second.id);
  assert.equal(store.overview().words[0].status, 'mastered');
  assert.deepEqual(store.overview().words[0].sources[0].meanings, ['已知的']);
  store.editEntry(entryId, { english: 'fresh', meaning: '新鲜的' });
  assert.equal(store.overview().words[0].status, 'new');
  store.deleteEntry(entryId); assert.equal(store.overview().words.length, 0);
});

test('content edits finish affected sessions and prevent same-paper collisions', t => {
  const { store, paper } = fixture(t); add(store, paper, 'a = 甲\nb = 乙');
  const a = store.overview().words.find(w => w.english === 'a');
  assert.throws(() => store.editEntry(a.sources[0].id, { english: 'b', meaning: '新的' }), /已有该英文/);
  store.startSession({}); store.editEntry(a.sources[0].id, { english: 'a', meaning: '新的甲' });
  assert.equal(store.session().phase, 'done'); assert.equal(store.session().reason, 'content-changed');
});

test('data, revealed answer and queue survive database restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cet6-persistence-')), path = join(directory, 'test.sqlite');
  let store = new Store(path);
  try {
    const paper = store.createPaper({ examMonth: '2024-12', volume: 1 });
    add(store, paper, 'persistent = 持久的'); store.startSession({}); action(store, 'next'); action(store, 'reveal');
    const saved = store.session(); store.close(); store = new Store(path);
    assert.deepEqual(store.session(), saved); assert.equal(store.overview().words.length, 1);
    finish(store); assert.equal(store.overview().words[0].status, 'mastered');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('backup validates references and queue, restores full state and saves pre-restore backup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cet6-backup-'));
  const store = new Store(join(directory, 'test.sqlite'));
  try {
    const paper = store.createPaper({ examMonth: '2025-06', volume: 1 });
    add(store, paper, 'safe = 安全的'); store.startSession({}); action(store, 'next'); action(store, 'reveal');
    const backup = store.backup();
    assert.equal(store.validateBackup(backup).activeSession, true);
    const corrupt = structuredClone(backup); corrupt.entries[0].word_id = 'missing';
    assert.throws(() => store.restore(corrupt), /关联/);
    const badQueue = structuredClone(backup); badQueue.session.queue = [];
    assert.throws(() => store.restore(badQueue), /队列/);
    assert.equal(store.overview().words.length, 1);
    action(store, 'end'); add(store, paper, 'extra = 额外的');
    const before = store.backup(), result = store.restore(backup);
    assert.equal(readdirSync(join(directory, 'backups')).length, 1);
    const saved = JSON.parse(readFileSync(result.backupFile, 'utf8'));
    assert.deepEqual(saved.words, JSON.parse(JSON.stringify(before.words)));
    const restored = store.backup();
    for (const field of ['papers', 'words', 'entries']) assert.deepEqual(restored[field], backup[field]);
    assert.notEqual(restored.session.id, backup.session.id);
    assert.deepEqual({ ...restored.session, id: backup.session.id }, backup.session);
    assert.throws(() => store.sessionAction({ sessionId: backup.session.id, revision: backup.session.revision, action: 'remember' }), { status: 409 });
    finish(store);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('backup preserves ended session snapshots after deleting its paper', t => {
  const { store, paper } = fixture(t); add(store, paper, 'gone = 消失的'); store.startSession({}); store.deletePaper(paper.id);
  const backup = store.backup(); assert.equal(store.validateBackup(backup).words, 0);
  store.restore(backup); assert.equal(store.session().reason, 'content-changed');
});

test('HTTP APIs and static app: UTF-8 streams, safe content handling and origin protection', async t => {
  const { server } = createApp({ dataPath: ':memory:' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 200); return r.json();
  };
  const page = await fetch(base);
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Afterword/);
  assert.match(pageHtml, /<link rel="stylesheet" href="\/ui.css">/);
  for (const file of ['/app.js', '/review.js', '/word-list.js', '/style.css', '/practice.css', '/favicon.svg']) assert.equal((await fetch(base + file)).status, 200);
  const uiStyles = await fetch(base + '/ui.css');
  assert.equal(uiStyles.status, 200);
  assert.match(uiStyles.headers.get('content-type'), /text\/css/);
  assert.match(await uiStyles.text(), /prefers-reduced-motion/);
  const paper = await post('/api/papers', { examMonth: '2025-06', volume: 1 });
  const payload = Buffer.from(JSON.stringify({ paperId: paper.id, text: 'example = 中文释义\n<img src=x onerror=alert(1)>\t<script>文本</script>' }));
  const streamed = await new Promise((resolve, reject) => {
    const req = request(base + '/api/import/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    const split = payload.indexOf(Buffer.from('中文')) + 1;
    req.write(payload.subarray(0, split)); setTimeout(() => req.end(payload.subarray(split)), 10);
  });
  assert.equal(streamed.rows[0].meaning, '中文释义');
  await post('/api/import/confirm', { paperId: paper.id, rows: streamed.rows, requestId: randomUUID() });
  const overview = await (await fetch(base + '/api/overview')).json();
  assert.equal(overview.words.length, 2);
  assert.equal(overview.sources[0].id, paper.id);
  assert.equal(overview.sources[0].count, 2);
  const sourceTypes = await (await fetch(base + '/api/source-types')).json();
  assert.equal(sourceTypes.version, 1);
  assert.deepEqual(sourceTypes.profiles, overview.sourceProfiles);
  assert.deepEqual(sourceTypes.profiles.filter(profile => profile.storageReady).map(profile => profile.exam), ['cet6']);
  assert.ok(overview.words.some(w => w.english === '<img src=x onerror=alert(1)>'));
  const forbidden = await fetch(base + '/api/papers', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  assert.equal((await fetch(base + '/api/papers', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/missing')).status, 404);
});
