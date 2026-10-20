import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { isReviewDue, nextReview } from '../lib/review.js';
import { filterWords, wordTable } from '../lib/word-list.js';
import { parseText } from '../lib/parser.js';

const initialTime = Date.parse('2026-10-19T02:00:00.000Z');
const dayMs = 86400000;

function fixture(context) {
  let time = initialTime;
  const store = new Store(':memory:', { clock: () => new Date(time) });
  context.after(() => store.close());
  const paper = store.createPaper({ examMonth: '2025-06' });
  const add = (text, target = paper) => store.confirmImport({ paperId: target.id, rows: store.preview({ paperId: target.id, text }).rows, requestId: randomUUID() });
  return { store, paper, add, setTime(value) { time = value; } };
}

function action(store, type) {
  const session = store.session();
  return store.sessionAction({ sessionId: session.id, revision: session.revision, action: type });
}

function finish(store) {
  let remaining = 300;
  while (store.session().phase !== 'done') {
    assert.ok(remaining-- > 0);
    const session = store.session();
    action(store, session.phase === 'browse' ? 'next' : session.revealed ? 'remember' : 'reveal');
  }
}

test('due boundary includes legacy learned words but excludes new and future words', () => {
  assert.equal(isReviewDue({ status: 'new' }, initialTime), false);
  assert.equal(isReviewDue({ status: 'mastered' }, initialTime), true);
  assert.equal(isReviewDue({ status: 'unfamiliar' }, initialTime), true);
  const word = { status: 'mastered', due_at: new Date(initialTime).toISOString() };
  assert.equal(isReviewDue(word, initialTime - 1), false);
  assert.equal(isReviewDue(word, initialTime), true);
});

test('intervals advance only when due and stay capped at sixty days', () => {
  let word = { status: 'mastered', review_streak: 0, due_at: null };
  let time = initialTime;
  for (const days of [1, 3, 7, 14, 30, 60, 60]) {
    const result = nextReview(word, time);
    assert.equal(Date.parse(result.dueAt) - time, days * dayMs);
    word = { ...word, due_at: result.dueAt, review_streak: result.streak };
    assert.deepEqual(nextReview(word, time + 1000), result);
    time = Date.parse(result.dueAt);
  }
  assert.equal(word.review_streak, 6);
});

test('only completing both directions schedules review; extra early practice preserves it', context => {
  const { store, add, setTime } = fixture(context);
  add('recall = 回忆');
  store.startSession({ filter: 'new', size: 1 });
  action(store, 'next'); action(store, 'reveal'); action(store, 'remember');
  assert.equal(store.overview().words[0].due_at, null);
  finish(store);
  let word = store.overview().words[0];
  assert.equal(word.review_streak, 1);
  assert.equal(Date.parse(word.due_at), initialTime + dayMs);
  assert.throws(() => store.startSession({ filter: 'due' }), /没有到期/);
  store.startSession({ filter: 'all' }); finish(store);
  assert.equal(store.overview().words[0].due_at, word.due_at);
  setTime(initialTime + dayMs);
  store.startSession({ filter: 'due' }); finish(store);
  word = store.overview().words[0];
  assert.equal(word.review_streak, 2);
  assert.equal(Date.parse(word.due_at), initialTime + 4 * dayMs);
});

test('forgetting resets the interval immediately, including early exit and stale submissions', context => {
  const { store, add } = fixture(context);
  add('persistent = 持久的');
  store.startSession({}); finish(store);
  store.startSession({}); action(store, 'next'); action(store, 'reveal');
  const before = store.session();
  action(store, 'forget');
  assert.throws(() => store.sessionAction({ sessionId: before.id, revision: before.revision, action: 'remember' }), { status: 409 });
  action(store, 'end');
  const word = store.overview().words[0];
  assert.equal(word.status, 'unfamiliar');
  assert.equal(word.review_streak, 0);
  assert.equal(Date.parse(word.due_at), initialTime);
  store.startSession({ filter: 'due' }); finish(store);
  assert.equal(store.overview().words[0].review_streak, 1);
  assert.equal(Date.parse(store.overview().words[0].due_at), initialTime + dayMs);
});

test('due groups sort overdue words, respect paper scope and leave schedules intact on start', context => {
  const { store, paper, add } = fixture(context);
  const other = store.createPaper({ examMonth: '2024-12' });
  add('recent = 最近的\nolder = 更早的\nfresh = 新的');
  add('elsewhere = 别处', other);
  for (const [english, days] of [['recent', 1], ['older', 4], ['elsewhere', 7]]) {
    store.run("UPDATE words SET status = 'mastered', due_at = ?, review_streak = 1 WHERE english = ?", new Date(initialTime - days * dayMs).toISOString(), english);
  }
  const before = store.overview().words.find(word => word.english === 'older').due_at;
  const session = store.startSession({ paperId: paper.id, filter: 'due', size: 1 });
  assert.deepEqual(session.items.map(item => item.english), ['older']);
  assert.equal(store.overview().words.find(word => word.english === 'older').due_at, before);
  action(store, 'end');
  assert.equal(store.startSession({ filter: 'due', size: 1 }).items[0].english, 'elsewhere');
});

test('shared words keep one schedule after removing one of their paper sources', context => {
  const { store, paper, add } = fixture(context);
  const other = store.createPaper({ examMonth: '2024-12' });
  add('perspective = 观点'); add('perspective = 视角', other);
  store.startSession({ paperId: paper.id }); finish(store);
  const dueAt = store.overview().words[0].due_at;
  store.deletePaper(paper.id);
  assert.equal(store.overview().words[0].due_at, dueAt);
  assert.equal(store.overview().words[0].sources.length, 1);
});

test('backup round trips due sessions and schedules, imports old backups and rejects corrupt schedules atomically', context => {
  const { store, add, setTime } = fixture(context);
  add('backup = 备份'); store.startSession({}); finish(store);
  setTime(initialTime + dayMs);
  store.startSession({ filter: 'due' }); action(store, 'next'); action(store, 'reveal');
  const backup = JSON.parse(JSON.stringify(store.backup()));
  store.restore(backup);
  assert.deepEqual(store.session(), backup.session);
  assert.equal(store.overview().words[0].due_at, backup.words[0].due_at);
  for (const change of [{ due_at: 'invalid' }, { review_streak: -1 }, { review_streak: 1.5 }, { review_streak: 7 }, { review_streak: 1, due_at: null }, { status: 'new' }]) {
    const invalid = structuredClone(backup);
    Object.assign(invalid.words[0], change);
    assert.throws(() => store.restore(invalid), { status: 400 });
    assert.deepEqual(store.session(), backup.session);
  }
  const legacy = structuredClone(backup);
  delete legacy.words[0].due_at; delete legacy.words[0].review_streak;
  legacy.session.filter = 'all';
  store.restore(legacy);
  assert.equal(store.overview().words[0].review_streak, 0);
  assert.equal(isReviewDue(store.overview().words[0], initialTime), true);
});

test('an existing database gains scheduling columns without changing words or identifiers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'afterword-upgrade-'));
  const path = join(directory, 'legacy.sqlite');
  let store;
  try {
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE words (id TEXT PRIMARY KEY, english TEXT NOT NULL, normalized TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL, last_practised_at TEXT);
      INSERT INTO words VALUES ('legacy-word', 'legacy', 'legacy', 'mastered', '2026-01-01T00:00:00.000Z', NULL);`);
    database.close();
    store = new Store(path);
    const word = store.get('SELECT * FROM words WHERE id = ?', 'legacy-word');
    assert.equal(word.status, 'mastered');
    assert.equal(word.english, 'legacy');
    assert.equal(word.due_at, null);
    assert.equal(word.review_streak, 0);
    store.run('UPDATE words SET due_at = ?, review_streak = 2 WHERE id = ?', new Date(initialTime).toISOString(), word.id);
    store.close(); store = new Store(path);
    assert.equal(store.get('SELECT * FROM words WHERE id = ?', word.id).review_streak, 2);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('word export uses the same paper, status and search scope as the list and can be imported again', () => {
  const words = [
    { english: 'perspective', status: 'mastered', due_at: null, sources: [{ paperId: 'first', meanings: ['观点', '观点'] }, { paperId: 'second', meanings: ['视角'] }] },
    { english: 'a | b', status: 'new', sources: [{ paperId: 'first', meanings: ['甲 | 乙'] }] },
  ];
  assert.equal(filterWords(words, { paperId: 'first', query: '视角' }).length, 0);
  const selected = filterWords(words, { paperId: 'first', filter: 'due', query: 'PERSP' });
  assert.equal(selected.length, 1);
  assert.equal(wordTable(selected, 'first'), '英文\t中文释义\nperspective\t观点\n');
  const parsed = parseText(wordTable(words));
  assert.equal(parsed.rows.length, 3);
  assert.ok(parsed.rows.every(row => !row.error));
  assert.equal(parsed.rows[2].english, 'a | b');
  assert.equal(parsed.rows[2].meaning, '甲 | 乙');
  assert.equal(wordTable(filterWords(words, { query: 'absent' })), '英文\t中文释义\n');
});
