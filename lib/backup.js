import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';

export function writeBackup({ dataPath, directory }) {
  if (dataPath === ':memory:' || !existsSync(dataPath)) throw new Error('数据库不存在；不会创建空库代替备份');
  const store = new Store(dataPath);
  let temporary;
  try {
    const snapshot = store.transaction(() => store.backup());
    const counts = store.validateBackup(snapshot);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, `afterword-${snapshot.exportedAt.replace(/[:.]/g, '-')}-${randomUUID()}.json`);
    temporary = `${filename}.partial`;
    writeFileSync(temporary, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temporary, filename);
    temporary = null;
    return { filename, counts };
  } finally {
    if (temporary) rmSync(temporary, { force: true });
    store.close();
  }
}
