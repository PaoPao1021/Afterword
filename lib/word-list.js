import { isReviewDue } from './review.js';

export const studyFilters = ['all', 'new', 'unfamiliar', 'due', 'starred'];

export function filterWords(words, { paperId = null, filter = 'all', query = '', time = Date.now() } = {}) {
  const needle = query.trim().toLowerCase();
  return words.filter(word => {
    const sources = word.sources.filter(source => !paperId || source.paperId === paperId);
    return sources.length > 0 && (filter === 'all' || (filter === 'starred' ? word.details?.starred : filter === 'due' ? isReviewDue(word, time) : word.status === filter)) &&
      (!needle || word.english.toLowerCase().includes(needle) || sources.some(source => source.meanings.some(meaning => meaning.toLowerCase().includes(needle))));
  });
}

export function wordTable(words, paperId = null) {
  const cell = value => value.replace(/[\t\r\n]+/g, ' ').trim();
  const rows = ['英文\t中文释义'];
  for (const word of words) {
    const meanings = new Set(word.sources.filter(source => !paperId || source.paperId === paperId).flatMap(source => source.meanings));
    for (const meaning of meanings) rows.push(`${cell(word.english)}\t${cell(meaning)}`);
  }
  return rows.join('\n') + '\n';
}
