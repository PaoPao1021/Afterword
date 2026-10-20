import { AppError } from './errors.js';

export const defaultPreferences = { dailyGoal: 20, groupSize: 10, learnSpelling: true, reviewSpelling: true, accent: 'en-GB', theme: 'sky' };

export function validatePreferences(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !Object.hasOwn(defaultPreferences, key))) throw new AppError('学习偏好格式无效');
  const preferences = { ...defaultPreferences, ...value };
  if (!Number.isInteger(preferences.dailyGoal) || preferences.dailyGoal < 1 || preferences.dailyGoal > 200 || !Number.isInteger(preferences.groupSize) || preferences.groupSize < 1 || preferences.groupSize > 100 || typeof preferences.learnSpelling !== 'boolean' || typeof preferences.reviewSpelling !== 'boolean' || !['en-GB', 'en-US'].includes(preferences.accent) || !['sky', 'paper'].includes(preferences.theme)) throw new AppError('学习偏好数值无效');
  return preferences;
}

export function learningDay(time) {
  return new Date(Number(new Date(time)) + 4 * 3600000).toISOString().slice(0, 10);
}

export function learningStats(events, time = new Date()) {
  const today = learningDay(time);
  const days = Array.from({ length: 14 }, (_, index) => ({ day: learningDay(new Date(Number(new Date(time)) - (13 - index) * 86400000)), learned: 0, reviewed: 0 }));
  for (const day of days) {
    const completed = events.filter(event => learningDay(event.completed_at) === day.day);
    const learned = new Set(completed.filter(event => event.was_new).map(event => event.word_id || event.english));
    const reviewed = new Set(completed.filter(event => !event.was_new && !learned.has(event.word_id || event.english)).map(event => event.word_id || event.english));
    day.learned = learned.size; day.reviewed = reviewed.size;
  }
  const activityDays = new Set(events.map(event => learningDay(event.completed_at)));
  let streak = 0;
  let date = new Date(`${today}T00:00:00Z`);
  if (!activityDays.has(today)) date = new Date(Number(date) - 86400000);
  while (activityDays.has(date.toISOString().slice(0, 10))) { streak++; date = new Date(Number(date) - 86400000); }
  return { today: days.at(-1), days, streak, totalSessions: new Set(events.map(event => event.session_id)).size };
}

export function validateDetails(value) {
  if (!value || typeof value.starred !== 'boolean' || !['note', 'example', 'translation'].every(key => typeof value[key] === 'string' && value[key].length <= 5000)) throw new AppError('笔记格式无效，每项最多 5000 字符');
  return { starred: value.starred, note: value.note.trim(), example: value.example.trim(), translation: value.translation.trim() };
}
