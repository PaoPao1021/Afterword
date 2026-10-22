import { learningDay } from './learning.js';
import { isReviewDue } from './review.js';

export function reviewForecast(words, time = new Date()) {
  const instant = Number(new Date(time));
  const today = learningDay(instant);
  const days = Array.from({ length: 7 }, (_, index) => ({ day: learningDay(instant + index * 86400000), count: 0, wordIds: [] }));
  const buckets = new Map(days.map(day => [day.day, day]));
  let dueNow = 0, overdue = 0, unscheduled = 0, laterToday = 0, later = 0;
  const learned = words.filter(word => word.status !== 'new').toSorted((first, second) => (Date.parse(first.due_at) || 0) - (Date.parse(second.due_at) || 0) || first.english.localeCompare(second.english));
  for (const word of learned) {
    const due = isReviewDue(word, instant);
    const day = word.due_at ? learningDay(word.due_at) : today;
    if (due) dueNow++;
    if (!word.due_at) unscheduled++;
    else if (day < today) overdue++;
    if (!due && day === today) laterToday++;
    const bucket = buckets.get(day < today ? today : day);
    if (bucket) { bucket.count++; bucket.wordIds.push(word.id); }
    else later++;
  }
  return { dueNow, overdue, unscheduled, laterToday, later, days };
}
