export const normalize = value => value.trim().replace(/\s+/g, ' ').toLowerCase();
export const cleanMeanings = value => [...new Set(value.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];

const englishHeaders = /^(英文|单词|词汇|词语|词组|短语|表达|词汇[与和或\/]短语|英文[词汇短语表达/与和或（）()\s]*|english|word|words|phrase|expression|term)$/i;
const meaningHeaders = /^(中文|释义|中文释义|中文含义|含义|意思|翻译|meaning|definition|translation|chinese)$/i;

export function parseText(text) {
  const rows = [];
  let ignored = 0;
  let insideFence = false;
  let seenHeader = false;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (/^```(?:\w+)?$/.test(line)) { insideFence = !insideFence; ignored++; continue; }
    let parts;
    if (raw.includes('\t')) parts = raw.split('\t').map(s => s.trim());
    else if (line.includes('|')) {
      const body = line.replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
      parts = body.split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, '|'));
      if (parts.length === 2 && parts.every(s => /^:?-{3,}:?$/.test(s)) && seenHeader) { ignored++; continue; }
    } else {
      const separator = line.indexOf('=');
      if (separator >= 0) parts = [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }
    if (parts?.length === 2 && englishHeaders.test(parts[0]) && meaningHeaders.test(parts[1])) {
      seenHeader = true; ignored++; continue;
    }
    const english = parts?.[0] || '';
    const meaning = parts?.[1] || '';
    const error = !parts ? '无法识别，请使用两列表格或「英文 = 中文释义」' : parts.length !== 2 ? '需要恰好两列，请调整后重新预览' : !english || !meaning ? '英文和中文释义均不能为空' : english.length > 300 || meaning.length > 5000 ? '英文最多 300 字符，释义最多 5000 字符' : '';
    rows.push({ line: index + 1, raw, english, meaning, error, excluded: false, strategy: 'merge' });
  }
  return { rows, ignored, unclosedFence: insideFence };
}
