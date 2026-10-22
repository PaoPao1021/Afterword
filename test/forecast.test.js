import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { reviewForecast } from '../lib/forecast.js';
import { Store } from '../lib/store.js';

const time = '2026-10-21T02:00:00.000Z';
const word = (id, due_at = null, status = 'mastered') => ({ id, english: id, due_at, status });

test('calendar partitions learned words without inventing future repetitions', () => {
  const words = [word('fresh', null, 'new'), word('old'), word('overdue', '2026-10-19T02:00:00Z'), word('now', time), word('tonight', '2026-10-21T19:59:59.999Z'), word('tomorrow', '2026-10-21T20:00:00Z'), word('last', '2026-10-27T19:59:59.999Z'), word('later', '2026-10-27T20:00:00Z')];
  const original = structuredClone(words);
  const result = reviewForecast(words, time);
  assert.deepEqual([result.dueNow, result.overdue, result.unscheduled, result.laterToday, result.later], [3, 1, 1, 1, 1]);
  assert.deepEqual(result.days.map(day => day.count), [4, 1, 0, 0, 0, 0, 1]);
  assert.deepEqual(result.days[0].wordIds, ['old', 'overdue', 'now', 'tonight']);
  assert.equal(new Set(result.days.flatMap(day => day.wordIds)).size, 6);
  assert.deepEqual(words, original);
});

test('calendar switches at 04:00 Beijing, including year and leap-day boundaries', () => {
  const before = reviewForecast([word('boundary', '2026-12-31T20:00:00.000Z')], '2026-12-31T19:59:59.999Z');
  assert.equal(before.days[0].day, '2026-12-31');
  assert.equal(before.days[1].count, 1);
  assert.equal(before.dueNow, 0);
  const after = reviewForecast([word('boundary', '2026-12-31T20:00:00.000Z')], '2026-12-31T20:00:00.000Z');
  assert.equal(after.days[0].day, '2027-01-01');
  assert.equal(after.days[0].count, 1);
  assert.equal(after.dueNow, 1);
  assert.deepEqual(reviewForecast([], '2028-02-28T20:00:00Z').days.slice(0, 2).map(day => day.day), ['2028-02-29', '2028-03-01']);
});

test('empty and new-only collections have seven zero-count days', () => {
  for (const words of [[], [word('new-with-date', time, 'new')]]) {
    const result = reviewForecast(words, time);
    assert.equal(result.days.length, 7);
    assert.ok(result.days.every(day => day.count === 0 && day.wordIds.length === 0));
    assert.equal(result.dueNow + result.later + result.overdue + result.unscheduled + result.laterToday, 0);
  }
});

test('store calendar deduplicates paper sources and follows schedule changes without writes', context => {
  const store = new Store(':memory:', { clock: () => new Date(time) });
  context.after(() => store.close());
  for (const examMonth of ['2025-06', '2025-12']) {
    const paper = store.createPaper({ examMonth });
    store.confirmImport({ paperId: paper.id, rows: store.preview({ paperId: paper.id, text: 'recall = 回忆' }).rows, requestId: randomUUID() });
  }
  const id = store.overview().words[0].id;
  store.run("UPDATE words SET status = 'mastered', due_at = ? WHERE id = ?", time, id);
  const before = store.backup();
  assert.equal(store.overview().forecast.dueNow, 1);
  assert.deepEqual(store.overview().forecast.days[0].wordIds, [id]);
  const after = store.backup();
  assert.deepEqual({ ...after, exportedAt: before.exportedAt }, before);
  store.run('UPDATE words SET due_at = ? WHERE id = ?', '2026-10-22T02:00:00Z', id);
  assert.equal(store.overview().forecast.dueNow, 0);
  assert.deepEqual(store.overview().forecast.days[1].wordIds, [id]);
  store.deletePaper(store.overview().papers[0].id);
  assert.equal(store.overview().forecast.days[1].count, 1);
  store.deletePaper(store.overview().papers[0].id);
  assert.equal(store.overview().forecast.days[1].count, 0);
});
