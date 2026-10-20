import { AppError } from './errors.js';
import { normalize } from './parser.js';

const learningSteps = ['choice', 'recall', 'recall', 'recall'];
const previousSteps = ['choice', 'recall', 'recall', 'reverse'];
const stepsFor = state => state.protocolVersion === 2 ? learningSteps : previousSteps;
const requireState = (condition, message = '当前学习操作无效') => { if (!condition) throw new AppError(message); };
const meaningOf = item => [...new Set(item.sources.flatMap(source => source.meanings))].join('；');
const ordered = values => values.map(value => ({ value, order: Math.random() })).sort((first, second) => first.order - second.order).map(item => item.value);

export function preparePractice(state, words, { spelling = true, practice = 'mixed' } = {}) {
  requireState(typeof spelling === 'boolean' && ['mixed', 'spelling'].includes(practice), '学习设置无效');
  state.mode = 'context';
  state.protocolVersion = 2;
  state.spelling = spelling;
  state.practice = practice;
  state.pending = null;
  state.lastWordId = null;
  state.tracks = state.items.map(item => {
    const word = words.find(candidate => candidate.id === item.wordId);
    const answer = meaningOf(item);
    const meanings = new Set(item.sources.flatMap(source => source.meanings));
    const distractors = [...new Set(words.filter(candidate => candidate.id !== item.wordId && !candidate.sources.some(source => source.meanings.some(meaning => meanings.has(meaning)))).map(meaningOf))].filter(meaning => meaning !== answer);
    return { wordId: item.wordId, initialStatus: word.status, steps: word.status === 'mastered' ? ['recall'] : [...learningSteps], step: 0, options: ordered([answer, ...ordered(distractors).slice(0, 3)]) };
  });
  state.queue = state.items.map(item => item.wordId);
  state.phase = practice === 'spelling' ? 'spell' : state.tracks[0].steps[0];
  return state;
}

export function practiceAction(state, { action, answer }) {
  const failures = [], completions = [];
  const track = state.tracks.find(item => item.wordId === state.queue[0]);
  const item = state.items.find(item => item.wordId === state.queue[0]);
  if (action === 'end') {
    state.phase = 'done'; state.reason = 'ended'; state.queue = []; state.pending = null; state.revealed = false;
    return { failures, completions };
  }
  requireState(item && track);
  if (action === 'correct') {
    requireState(state.pending?.correct && state.phase !== 'spell', '只能在核对答案时标记记错');
    state.pending.correct = false; state.pending.rating = 'wrong';
  } else if (action === 'continue') {
    requireState(state.pending, '请先作答并核对答案');
    const correct = state.pending.correct;
    const wordId = state.queue.shift();
    state.lastWordId = wordId;
    state.answers++;
    if (!correct) {
      if (!state.failed.includes(wordId)) state.failed.push(wordId);
      failures.push(wordId);
      if (state.phase !== 'spell') { track.steps = [...stepsFor(state)]; track.step = 0; }
      state.queue.splice(Math.min(3, state.queue.length), 0, wordId);
    } else if (state.phase === 'spell') {
      state.passedZh.push(wordId); completions.push(wordId);
    } else {
      track.step++;
      if (track.step === track.steps.length) {
        state.passedEn.push(wordId);
        if (!state.spelling) { state.passedZh.push(wordId); completions.push(wordId); }
      } else state.queue.push(wordId);
    }
    state.pending = null; state.revealed = false;
    if (!state.queue.length) {
      if (state.phase !== 'spell' && state.spelling) { state.phase = 'spell'; state.queue = state.items.map(item => item.wordId); }
      else { state.phase = 'done'; state.reason = 'completed'; }
    } else if (state.phase !== 'spell') {
      const next = state.tracks.find(item => item.wordId === state.queue[0]);
      state.phase = next.steps[next.step];
    }
  } else {
    requireState(!state.pending, '请先核对当前答案');
    if (action === 'choose') {
      requireState(state.phase === 'choice' && typeof answer === 'string' && track.options.includes(answer));
      state.pending = { correct: answer === meaningOf(item), rating: 'choice', answer };
    } else if (action === 'spell') {
      requireState(state.phase === 'spell' && typeof answer === 'string' && answer.trim().length > 0 && answer.length <= 300, '请输入英文，最多 300 字符');
      state.pending = { correct: normalize(answer) === normalize(item.english), rating: 'spelling', answer };
    } else if (action === 'known' || action === 'vague') {
      requireState(['recall', 'reverse'].includes(state.phase));
      state.pending = { correct: action === 'known', rating: action };
    } else if (action === 'unknown') {
      state.pending = { correct: false, rating: 'unknown' };
    } else throw new AppError('未知学习操作');
    state.revealed = true;
  }
  if (state.pending && !state.pending.correct) {
    if (!state.failed.includes(item.wordId)) state.failed.push(item.wordId);
    failures.push(item.wordId);
  }
  return { failures, completions };
}

export function validatePractice(state) {
  const ids = state.items.map(item => item.wordId);
  const valid = condition => requireState(condition, '备份中的分轮学习进度无效');
  valid(state.protocolVersion === undefined || state.protocolVersion === 2);
  valid(typeof state.spelling === 'boolean' && ['mixed', 'spelling'].includes(state.practice));
  valid(Array.isArray(state.tracks) && state.tracks.length === ids.length && new Set(state.tracks.map(track => track?.wordId)).size === ids.length);
  for (const track of state.tracks) {
    valid(track && ids.includes(track.wordId) && ['new', 'unfamiliar', 'mastered'].includes(track.initialStatus));
    valid(Array.isArray(track.steps) && (JSON.stringify(track.steps) === JSON.stringify(stepsFor(state)) || JSON.stringify(track.steps) === '["recall"]'));
    valid(Number.isInteger(track.step) && track.step >= 0 && track.step <= track.steps.length);
    valid(Array.isArray(track.options) && track.options.length >= 1 && track.options.length <= 4 && track.options.every(option => typeof option === 'string' && option.length > 0 && option.length <= 50000));
    valid(new Set(track.options).size === track.options.length && track.options.includes(meaningOf(state.items.find(item => item.wordId === track.wordId))));
  }
  valid(state.lastWordId === null || ids.includes(state.lastWordId));
  valid(state.pending === null || (state.pending && typeof state.pending.correct === 'boolean' && ['choice', 'spelling', 'known', 'vague', 'unknown', 'wrong'].includes(state.pending.rating) && (state.pending.answer === undefined || (typeof state.pending.answer === 'string' && state.pending.answer.length <= 50000))));
  valid(state.revealed === !!state.pending);
  if (state.phase === 'done') { valid(!state.queue.length && !state.pending); return; }
  valid(state.queue.length > 0);
  if (state.phase === 'spell') {
    valid(state.queue.length + state.passedZh.length === ids.length && !state.queue.some(id => state.passedZh.includes(id)));
    valid(state.practice === 'spelling' || (state.spelling && state.passedEn.length === ids.length));
  } else {
    valid(state.practice === 'mixed');
    valid(state.queue.length + state.passedEn.length === ids.length && !state.queue.some(id => state.passedEn.includes(id)));
    valid(state.spelling ? state.passedZh.length === 0 : JSON.stringify(state.passedZh) === JSON.stringify(state.passedEn));
    for (const track of state.tracks) valid(state.passedEn.includes(track.wordId) === (track.step === track.steps.length));
    const current = state.tracks.find(track => track.wordId === state.queue[0]);
    valid(current.steps[current.step] === state.phase);
  }
}
