import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftCache, hasDraftContent } from '../public/draft-cache.js';

function fixture() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  let time = Date.parse('2026-10-22T02:00:00Z');
  return { values, storage, cache: createDraftCache(() => storage, () => time), advance: duration => { time += duration; } };
}
const basic = () => ({ paperId: 'paper-1', text: 'recall = 回忆', modelText: '', preview: null, requestId: null, dirty: false });

test('draft cache restores text and edited model rows but requires a fresh check and save', () => {
  const { cache, values } = fixture();
  const draft = { ...basic(), modelText: 'An example passage.', requestId: 'old-request', dirty: false, preview: {
    generatedBy: 'model', counts: { invalid: 0, added: 999 }, ignored: 10,
    rows: [{ line: 3, english: 'recall', meaning: '回想；回忆', raw: 'recall = 回忆', error: '', excluded: false, strategy: 'replace', kind: 'added', previous: ['旧义'] }, { line: 4, english: 'skip', meaning: '跳过', excluded: true, strategy: 'merge' }],
  } };
  const before = structuredClone(draft);
  assert.equal(cache.save(draft), true);
  assert.deepEqual(draft, before);
  const restored = cache.load();
  assert.equal(restored.state, 'restored');
  assert.equal(restored.draft.text, draft.text);
  assert.equal(restored.draft.modelText, draft.modelText);
  assert.equal(restored.draft.requestId, null);
  assert.equal(restored.draft.dirty, true);
  assert.equal(restored.draft.preview.generatedBy, 'model');
  assert.deepEqual(restored.draft.preview.rows.map(row => [row.meaning, row.strategy, row.excluded, row.kind]), [['回想；回忆', 'replace', false, 'unchecked'], ['跳过', 'merge', true, 'unchecked']]);
  assert.deepEqual(restored.draft.preview.counts, { added: 0, duplicate: 0, conflict: 0, invalid: 1, excluded: 1 });
  assert.ok(![...values.values()][0].includes('old-request'));
});

test('empty, model-only, and invalid-row drafts are treated correctly and can be cleared', () => {
  const { cache, values } = fixture();
  assert.equal(cache.load().state, 'empty');
  assert.equal(hasDraftContent({ ...basic(), text: ' \n\t ' }), false);
  assert.equal(hasDraftContent({ ...basic(), text: '', modelText: 'original' }), true);
  assert.equal(cache.save({ ...basic(), text: '', modelText: 'original' }), true);
  assert.equal(cache.load().draft.modelText, 'original');
  assert.equal(cache.save({ ...basic(), text: '', preview: { rows: [{ english: 'a'.repeat(301), meaning: '', error: '需修改', raw: '<script>example</script>' }] } }), true);
  assert.equal(cache.load().draft.preview.rows[0].english.length, 301);
  assert.equal(cache.load().draft.preview.rows[0].raw, '<script>example</script>');
  assert.equal(cache.save(null), true);
  assert.equal(values.size, 0);
});

test('expiration is exact and malformed or future drafts never crash startup', () => {
  const { cache, values, advance } = fixture();
  cache.save(basic());
  advance(7 * 86400000 - 1);
  assert.equal(cache.load().state, 'restored');
  advance(1);
  assert.equal(cache.load().state, 'expired');
  assert.equal(values.size, 0);
  for (const value of ['not json', 'null', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, savedAt: 1e15 }), JSON.stringify({ version: 1, savedAt: Date.parse('2026-10-29T02:00:00Z'), draft: { ...basic(), rows: 'bad' } })]) {
    values.set('afterword.import-draft.v1', value);
    assert.equal(cache.load().state, 'invalid');
  }
});

test('quota, blocked storage, and over-limit drafts fail safely without erasing the last snapshot', () => {
  const { cache, values, storage } = fixture();
  cache.save(basic());
  const previous = [...values.values()][0];
  assert.equal(cache.save({ ...basic(), text: 'x'.repeat(2000001) }), false);
  assert.equal(cache.save({ ...basic(), text: 'x'.repeat(1500000), preview: { rows: [{ english: 'word', meaning: '词', raw: 'x'.repeat(1500000) }] } }), false);
  assert.equal([...values.values()][0], previous);
  storage.setItem = () => { throw new Error('quota'); };
  assert.equal(cache.save(basic()), false);
  const blocked = createDraftCache(() => { throw new Error('blocked'); });
  assert.equal(blocked.load().state, 'unavailable');
  assert.equal(blocked.save(basic()), false);
});

test('separate tab caches do not overwrite each other', () => {
  const first = fixture(), second = fixture();
  first.cache.save(basic());
  second.cache.save({ ...basic(), text: 'sustain = 维持' });
  first.cache.save(null);
  assert.equal(first.cache.load().state, 'empty');
  assert.equal(second.cache.load().draft.text, 'sustain = 维持');
});
