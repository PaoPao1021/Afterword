import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { writeBackup } from '../lib/backup.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
try { loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
try {
  const dataPath = process.env.CET6_DATA_PATH || join(root, 'data/cet6.sqlite');
  const directory = process.argv[2] ? resolve(process.argv[2]) : join(dirname(dataPath), 'backups');
  console.log(JSON.stringify(writeBackup({ dataPath, directory })));
} catch (error) { console.error(`备份失败：${error.message}`); process.exitCode = 1; }
