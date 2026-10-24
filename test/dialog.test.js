import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogMarkup, escapeHtml, formSnapshot } from '../public/dialog.js';

test('dialog titles escape imported words and expose an accessible close button', () => {
  const html = dialogMarkup({ title: '<img src=x onerror=alert(1)> & "word"', content: '<p>Trusted template</p>' });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;word&quot;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /id="modal-title" tabindex="-1"/);
  assert.match(html, /type="button" class="close-button" data-action="close-modal" aria-label="关闭"/);
  assert.match(html, /id="modal-error" role="alert"/);
  assert.match(html, /<p>Trusted template<\/p>/);
  assert.equal(escapeHtml(null), '');
});

test('sheet shares the dialog shell while confirmation windows omit the detail eyebrow', () => {
  assert.match(dialogMarkup({ title: 'recall', content: '', kind: 'sheet' }), /class="modal-eyebrow">词条资料/);
  for (const kind of ['dialog', 'alert']) assert.doesNotMatch(dialogMarkup({ title: '确认', content: '', kind }), /modal-eyebrow/);
});

test('form snapshots ignore temporary disabled state but detect text, selection and checkbox edits', () => {
  const fields = [{ name: 'note', value: '保留原文' }, { name: 'scope', value: 'all' }, { name: 'starred', value: 'on', checked: false }];
  const form = { querySelectorAll: () => fields };
  const original = formSnapshot(form);
  fields.forEach(field => { field.disabled = true; });
  assert.equal(formSnapshot(form), original);
  for (const [index, property, value] of [[0, 'value', '新笔记'], [1, 'value', 'paper'], [2, 'checked', true]]) {
    const previous = fields[index][property];
    fields[index][property] = value;
    assert.notEqual(formSnapshot(form), original);
    fields[index][property] = previous;
    assert.equal(formSnapshot(form), original);
  }
  assert.equal(formSnapshot(null), null);
});
