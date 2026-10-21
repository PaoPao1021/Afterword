import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../lib/store.js';
import { writeBackup } from '../lib/backup.js';

test('live WAL backup is complete, private, unique and restores into a separate database', context => {
  const directory = mkdtempSync(join(tmpdir(), 'afterword-backup-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const dataPath = join(directory, 'live.sqlite'), backupDirectory = join(directory, 'backups');
  const live = new Store(dataPath), restored = new Store(join(directory, 'restored.sqlite'));
  context.after(() => { live.close(); restored.close(); });
  const paper = live.createPaper({ examMonth: '2026-06' });
  live.confirmImport({ paperId: paper.id, rows: live.preview({ paperId: paper.id, text: 'remember = 记住' }).rows, requestId: 'backup-test' });
  const session = live.startSession({ mode: 'context' });
  live.sessionAction({ sessionId: session.id, revision: session.revision, action: 'unknown' });
  const first = writeBackup({ dataPath, directory: backupDirectory });
  const second = writeBackup({ dataPath, directory: backupDirectory });
  assert.notEqual(first.filename, second.filename);
  assert.equal(first.counts.activeSession, true);
  assert.equal(statSync(first.filename).mode & 0o777, 0o600);
  assert.equal(readdirSync(backupDirectory).some(name => name.endsWith('.partial')), false);
  restored.restore(JSON.parse(readFileSync(first.filename, 'utf8')));
  assert.deepEqual(restored.overview(), live.overview());
  assert.throws(() => writeBackup({ dataPath: join(directory, 'missing.sqlite'), directory: backupDirectory }), /不存在/);
});

test('opening a newer database is rejected without rewriting its version or data', context => {
  const directory = mkdtempSync(join(tmpdir(), 'afterword-version-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'future.sqlite');
  const future = new DatabaseSync(path);
  future.exec('PRAGMA user_version = 999; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES (\'keep\')');
  future.close();
  assert.throws(() => new Store(path), /更新版本/);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 999);
  assert.equal(check.prepare('SELECT value FROM future_data').get().value, 'keep');
  check.close();
});
