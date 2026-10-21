import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { passwordHash } from '../lib/access.js';

try {
  let password;
  if (process.stdin.isTTY) {
    const silent = new Writable({ write(chunk, encoding, callback) { callback(); } });
    const prompt = createInterface({ input: process.stdin, output: silent, terminal: true });
    try {
      process.stderr.write('输入访问密码（至少 12 字符，不会回显）：');
      password = await prompt.question('');
      process.stderr.write('\n再次输入：');
      if (password !== await prompt.question('')) throw new Error('两次密码不一致');
      process.stderr.write('\n');
    } finally { prompt.close(); }
  } else {
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 258) throw new Error('输入过长');
      chunks.push(chunk);
    }
    password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  console.log(`AFTERWORD_PASSWORD_HASH='${await passwordHash(password)}'`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
