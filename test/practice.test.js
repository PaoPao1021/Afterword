import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.js';
import { learningDay, learningStats } from '../lib/learning.js';
import { filterWords } from '../lib/word-list.js';
import { createApp } from '../server.js';
import { createLlmService } from '../lib/llm.js';

function fixture(context, text = 'remember = 记住\nrecall = 回忆\nsustainable = 可持续的\nin the long run = 从长远来看') {
  const store = new Store(':memory:', { clock: () => new Date('2026-10-20T03:00:00Z') });
  context.after(() => store.close());
  const paper = store.createPaper({ examMonth: '2025-06', volume: 1 });
  store.confirmImport({ paperId: paper.id, rows: store.preview({ paperId: paper.id, text }).rows, requestId: randomUUID() });
  return { store, paper };
}

function act(store, action, answer) {
  const state = store.session();
  return store.sessionAction({ sessionId: state.id, revision: state.revision, action, answer });
}

function correctAnswer(store) {
  const state = store.session();
  const item = state.items.find(item => item.wordId === state.queue[0]);
  if (state.pending) return act(store, 'continue');
  if (state.phase === 'choice') return act(store, 'choose', [...new Set(item.sources.flatMap(source => source.meanings))].join('；'));
  if (state.phase === 'spell') return act(store, 'spell', item.english);
  return act(store, 'known');
}

function finish(store) {
  let limit = 1000;
  while (store.session().phase !== 'done') { assert.ok(limit-- > 0); correctAnswer(store); store.validateBackup(store.backup()); }
}

test('new words pass choice and three meaning recall rounds before spelling and scheduling', context => {
  const { store } = fixture(context, 'remember = 记住');
  store.startSession({ mode: 'context', filter: 'new', size: 1 });
  assert.equal(store.session().protocolVersion, 2);
  for (const phase of ['choice', 'recall', 'recall', 'recall']) {
    assert.equal(store.session().phase, phase);
    correctAnswer(store);
    assert.equal(store.session().revealed, true);
    assert.equal(store.overview().words[0].status, 'new');
    act(store, 'continue');
  }
  assert.equal(store.session().phase, 'spell');
  assert.equal(store.overview().words[0].due_at, null);
  act(store, 'spell', '  REMEMBER  ');
  assert.equal(store.session().pending.correct, true);
  act(store, 'continue');
  assert.equal(store.session().phase, 'done');
  assert.equal(store.overview().words[0].status, 'mastered');
  assert.equal(store.overview().words[0].due_at, '2026-10-21T03:00:00.000Z');
  assert.equal(store.overview().stats.today.learned, 1);
});

test('known is provisional, correction marks unfamiliar immediately and repeats after three other words', context => {
  const { store } = fixture(context);
  store.db.exec("UPDATE words SET status = 'mastered', due_at = '2026-10-19T03:00:00Z', review_streak = 3");
  const start = store.startSession({ mode: 'context', filter: 'due', spelling: false });
  const wordId = start.queue[0];
  act(store, 'known');
  assert.equal(store.overview().stats.today.reviewed, 0);
  act(store, 'correct');
  assert.equal(store.get('SELECT status FROM words WHERE id = ?', wordId).status, 'unfamiliar');
  assert.equal(store.get('SELECT review_streak FROM words WHERE id = ?', wordId).review_streak, 0);
  act(store, 'continue');
  assert.equal(store.session().queue.indexOf(wordId), 3);
  assert.deepEqual(store.session().tracks.find(track => track.wordId === wordId).steps, ['choice', 'recall', 'recall', 'recall']);
  finish(store);
  assert.equal(store.get('SELECT review_streak FROM words WHERE id = ?', wordId).review_streak, 1);
  assert.equal(store.overview().stats.today.reviewed, 4);
});

test('forgetting after a partial round resets all recall progress; single word repeats without deadlock', context => {
  const { store } = fixture(context, 'recall = 回忆');
  store.startSession({ mode: 'context', spelling: false });
  correctAnswer(store); act(store, 'continue');
  assert.equal(store.session().tracks[0].step, 1);
  act(store, 'vague'); act(store, 'continue');
  assert.equal(store.session().tracks[0].step, 0);
  assert.equal(store.session().phase, 'choice');
  finish(store);
  assert.equal(store.session().failed.length, 1);
  assert.equal(store.session().passedZh.length, 1);
});

test('previous unversioned sessions keep their reverse round through restore, failure and completion', context => {
  const { store } = fixture(context, 'remember = 记住');
  store.startSession({ mode: 'context', spelling: false });
  const backup = store.backup();
  delete backup.session.protocolVersion;
  backup.session.tracks[0].steps = ['choice', 'recall', 'recall', 'reverse'];
  backup.session.tracks[0].step = 3;
  backup.session.phase = 'reverse';
  store.restore(backup);
  act(store, 'known');
  store.restore(store.backup());
  act(store, 'correct'); act(store, 'continue');
  assert.deepEqual(store.session().tracks[0].steps, ['choice', 'recall', 'recall', 'reverse']);
  finish(store);
  assert.equal(store.overview().stats.today.learned, 1);
  const next = store.startSession({ mode: 'context' });
  assert.equal(next.protocolVersion, 2);
  act(store, 'unknown'); act(store, 'continue');
  assert.deepEqual(store.session().tracks[0].steps, ['choice', 'recall', 'recall', 'recall']);
});

test('unknown practice protocols and mismatched step sequences cannot replace progress', context => {
  const { store } = fixture(context);
  store.startSession({ mode: 'context' });
  const original = store.backup();
  for (const version of [null, 1, 3, '2']) {
    const backup = structuredClone(original);
    backup.session.protocolVersion = version;
    assert.throws(() => store.restore(backup), /分轮学习/);
  }
  const mismatch = structuredClone(original);
  mismatch.session.tracks[0].steps[3] = 'reverse';
  assert.throws(() => store.restore(mismatch), /分轮学习/);
  assert.deepEqual(store.session(), original.session);
});

test('100-word groups and preferences round-trip while out-of-range sizes are rejected', context => {
  const words = Array.from({ length: 100 }, (_, index) => `word ${index} = 释义 ${index}`).join('\n');
  const { store } = fixture(context, words);
  store.setPreferences({ groupSize: 100 });
  assert.throws(() => store.setPreferences({ groupSize: 101 }));
  assert.throws(() => store.startSession({ mode: 'context', size: 101 }));
  const state = store.startSession({ mode: 'context', size: 100, spelling: false });
  assert.equal(state.items.length, 100);
  correctAnswer(store);
  const backup = store.backup();
  store.restore(backup);
  assert.equal(store.preferences().groupSize, 100);
  assert.deepEqual(store.session(), backup.session);
});

test('spelling checks normalized full phrases and keeps wrong or revealed answers in the queue', context => {
  const { store } = fixture(context, 'in the long run = 从长远来看');
  store.startSession({ mode: 'context', practice: 'spelling' });
  assert.throws(() => act(store, 'spell', ''), /请输入/);
  act(store, 'spell', 'in the long');
  assert.equal(store.session().pending.correct, false);
  assert.equal(store.overview().words[0].status, 'unfamiliar');
  assert.throws(() => act(store, 'correct'), /只能/);
  act(store, 'continue');
  act(store, 'unknown'); act(store, 'continue');
  assert.equal(store.session().passedZh.length, 0);
  act(store, 'spell', '  IN  THE LONG RUN ');
  assert.equal(store.session().pending.correct, true);
  act(store, 'continue');
  assert.equal(store.session().phase, 'done');
});

test('stale, invalid, and double answers are rejected without changing stored progress', context => {
  const { store } = fixture(context);
  const state = store.startSession({ mode: 'context' });
  const backup = store.backup();
  assert.throws(() => act(store, 'choose', 'not an option'), /无效/);
  assert.throws(() => act(store, 'known'), /无效/);
  assert.throws(() => act(store, 'continue'), /请先/);
  assert.deepEqual(store.backup().session, backup.session);
  correctAnswer(store);
  assert.throws(() => store.sessionAction({ sessionId: state.id, revision: state.revision, action: 'unknown' }), /已更新/);
  assert.throws(() => act(store, 'choose', '记住'), /核对/);
});

test('early exit preserves failures but never records a provisional success as completed', context => {
  const { store } = fixture(context, 'recall = 回忆');
  store.startSession({ mode: 'context', spelling: false });
  act(store, 'unknown'); act(store, 'end');
  assert.equal(store.overview().words[0].status, 'unfamiliar');
  assert.equal(store.overview().stats.totalSessions, 0);
  assert.equal(store.validateBackup(store.backup()).activeSession, false);
});

test('backup v2 round-trips pending correction, notes, settings and historical completions', context => {
  const { store } = fixture(context, 'recall = 回忆');
  const wordId = store.overview().words[0].id;
  store.setPreferences({ dailyGoal: 30, learnSpelling: false, theme: 'paper' });
  store.setWordDetails(wordId, { starred: true, note: '自己的联想', example: 'I recall the afternoon.', translation: '我想起那个下午。' });
  store.startSession({ mode: 'context', filter: 'new' }); finish(store);
  store.startSession({ mode: 'context' }); act(store, 'known'); act(store, 'correct');
  const backup = store.backup();
  store.restore(backup);
  assert.deepEqual(store.backup().session, backup.session);
  assert.deepEqual(store.backup().events, backup.events);
  assert.deepEqual(store.backup().details, backup.details);
  assert.equal(store.overview().preferences.dailyGoal, 30);
  assert.equal(store.overview().stats.today.learned, 1);
  finish(store);
});

test('invalid v2 backups are rejected atomically and v1 restores with defaults', context => {
  const { store } = fixture(context, 'recall = 回忆');
  store.startSession({ mode: 'context' });
  const original = store.backup();
  for (const corrupt of [backup => { backup.session.tracks[0].step = 9; }, backup => { backup.session.queue = []; }, backup => { backup.session.pending = { correct: 'true' }; }, backup => { backup.session.tracks[0].options = []; }, backup => { backup.preferences.groupSize = 0; }, backup => { backup.details = [{ wordId: 'missing' }]; }, backup => { backup.events = [{}]; }]) {
    const backup = structuredClone(original); corrupt(backup);
    assert.throws(() => store.restore(backup));
    assert.deepEqual(store.session(), original.session);
  }
  const legacy = structuredClone(original); legacy.version = 1; legacy.session = null;
  delete legacy.preferences; delete legacy.details; delete legacy.events;
  store.restore(legacy);
  assert.equal(store.overview().preferences.dailyGoal, 20);
  assert.deepEqual(store.backup().events, []);
});

test('editing or deleting a practice word safely ends the active group and preserves history', context => {
  const { store } = fixture(context, 'recall = 回忆');
  store.startSession({ mode: 'context', spelling: false }); finish(store);
  const source = store.overview().words[0].sources[0];
  store.startSession({ mode: 'context' }); act(store, 'known');
  store.editEntry(source.id, { english: 'recall', meaning: '回忆起' });
  assert.equal(store.session().reason, 'content-changed');
  assert.equal(store.session().pending, null);
  store.validateBackup(store.backup());
  store.deleteEntry(source.id);
  assert.equal(store.overview().words.length, 0);
  assert.equal(store.overview().stats.today.learned, 1);
  store.validateBackup(store.backup());
});

test('only previous failed group can be retried, deleted words are not resurrected', context => {
  const { store } = fixture(context);
  store.startSession({ mode: 'context', spelling: false }); act(store, 'unknown');
  finish(store);
  const previous = store.session();
  assert.throws(() => store.startSession({ mode: 'context', retrySessionId: 'stale' }), /错词组已改变/);
  const retry = store.startSession({ mode: 'context', retrySessionId: previous.id });
  assert.deepEqual(retry.items.map(item => item.wordId), previous.failed);
  act(store, 'end');
  assert.throws(() => store.startSession({ mode: 'context', retrySessionId: store.session().id }), /没有可学习/);
});

test('choice options are real distinct meanings, scoped correct answer uses the selected paper', context => {
  const { store, paper } = fixture(context, 'term = 学期\nword = 单词');
  const other = store.createPaper({ examMonth: '2024-12' });
  store.confirmImport({ paperId: other.id, requestId: randomUUID(), rows: [{ english: 'term', meaning: '术语' }] });
  store.startSession({ mode: 'context', paperId: paper.id, spelling: false });
  const term = store.session().items.find(item => item.english === 'term');
  const track = store.session().tracks.find(track => track.wordId === term.wordId);
  assert.equal(term.sources.length, 1);
  assert.ok(track.options.includes('学期'));
  assert.ok(!track.options.includes('学期；术语'));
  finish(store);
});

test('SQLite reopen resumes the exact pending answer and settings', context => {
  const folder = mkdtempSync(join(tmpdir(), 'afterword-practice-'));
  context.after(() => rmSync(folder, { recursive: true, force: true }));
  let store = new Store(join(folder, 'test.sqlite'));
  const paper = store.createPaper({ examMonth: '2025-06' });
  store.confirmImport({ paperId: paper.id, requestId: randomUUID(), rows: [{ english: 'persist', meaning: '坚持' }] });
  store.setPreferences({ groupSize: 5 });
  store.startSession({ mode: 'context' }); act(store, 'unknown');
  const session = store.session(); store.close();
  store = new Store(join(folder, 'test.sqlite'));
  context.after(() => store.close());
  assert.deepEqual(store.session(), session);
  assert.equal(store.preferences().groupSize, 5);
  finish(store);
});

test('daily counts deduplicate new and review events and switch at 04:00 China time', () => {
  assert.equal(learningDay('2026-10-19T19:59:59Z'), '2026-10-19');
  assert.equal(learningDay('2026-10-19T20:00:00Z'), '2026-10-20');
  const events = [
    { word_id: 'one', english: 'one', was_new: 1, session_id: 'a', completed_at: '2026-10-19T20:00:00Z' },
    { word_id: 'one', english: 'one', was_new: 0, session_id: 'b', completed_at: '2026-10-20T02:00:00Z' },
    { word_id: 'two', english: 'two', was_new: 0, session_id: 'b', completed_at: '2026-10-20T02:00:00Z' },
    { word_id: 'two', english: 'two', was_new: 0, session_id: 'c', completed_at: '2026-10-19T02:00:00Z' },
  ];
  const stats = learningStats(events, new Date('2026-10-20T04:00:00Z'));
  assert.deepEqual(stats.today, { day: '2026-10-20', learned: 1, reviewed: 1 });
  assert.equal(stats.streak, 2);
  assert.equal(stats.totalSessions, 3);
  assert.equal(learningStats(events, new Date('2026-10-21T04:00:00Z')).streak, 2);
  assert.equal(learningStats(events, new Date('2026-10-22T04:00:00Z')).streak, 0);
});

test('preferences and notes validate bounds and starred list uses the shared filter', context => {
  const { store } = fixture(context);
  assert.throws(() => store.setPreferences({ dailyGoal: 0 }));
  assert.throws(() => store.setPreferences({ unknown: true }));
  assert.throws(() => store.setPreferences({ learnSpelling: 'yes' }));
  assert.throws(() => store.setPreferences(JSON.parse('{"__proto__": {}}')));
  const word = store.overview().words[0];
  assert.throws(() => store.setWordDetails(word.id, { starred: true, note: 'missing fields' }));
  store.setWordDetails(word.id, { starred: true, note: '<script>alert(1)</script>', example: '', translation: '' });
  assert.equal(filterWords(store.overview().words, { filter: 'starred' }).length, 1);
  store.deleteEntry(word.sources[0].id);
  assert.equal(store.backup().details.length, 0);
});

test('backup IDs cannot inject HTML into rendered attributes', context => {
  const { store } = fixture(context);
  const backup = store.backup();
  backup.papers[0].id = '"><img src=x>';
  assert.throws(() => store.restore(backup), /试卷格式无效/);
  assert.equal(store.overview().words.length, 4);
});

test('HTTP practice, preferences and notes persist with origin checks and backup v2', async context => {
  const { server, store } = createApp({ dataPath: ':memory:', llm: createLlmService({ env: {} }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (path, body, method = 'POST', headers = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const paper = store.createPaper({ examMonth: '2025-06' });
  store.confirmImport({ paperId: paper.id, requestId: randomUUID(), rows: [{ english: 'test', meaning: '测试' }] });
  const word = store.overview().words[0];
  assert.equal((await send('/api/preferences', { dailyGoal: 15 }, 'PUT')).status, 200);
  assert.equal((await send('/api/preferences', { dailyGoal: -1 }, 'PUT')).status, 400);
  assert.equal((await send('/api/preferences', { dailyGoal: 20 }, 'PUT', { Origin: 'https://example.com' })).status, 403);
  assert.equal((await send(`/api/words/${word.id}/details`, { starred: true, note: '<script>文本</script>', example: '', translation: '' }, 'PUT')).status, 200);
  assert.equal((await send('/api/words/missing/details', {}, 'PUT')).status, 404);
  const state = await (await send('/api/session', { mode: 'context', practice: 'spelling', size: 1 })).json();
  const pending = await (await send('/api/session/action', { sessionId: state.id, revision: state.revision, action: 'spell', answer: 'TEST' })).json();
  assert.equal(pending.pending.correct, true);
  assert.equal((await send('/api/session/action', { sessionId: state.id, revision: state.revision, action: 'continue' })).status, 409);
  assert.equal((await send('/api/session/action', { sessionId: state.id, revision: pending.revision, action: 'continue' })).status, 200);
  const overview = await (await fetch(base + '/api/overview')).json();
  assert.equal(overview.stats.today.learned, 1);
  assert.equal(overview.preferences.dailyGoal, 15);
  assert.equal(overview.words[0].details.note, '<script>文本</script>');
  assert.equal((await (await fetch(base + '/api/backup')).json()).version, 2);
  assert.equal((await fetch(base + '/practice.css')).status, 200);
});
