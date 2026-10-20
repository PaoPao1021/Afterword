const intervals = [1, 3, 7, 14, 30, 60];
const dayMs = 24 * 60 * 60 * 1000;

export function isReviewDue(word, time = Date.now()) {
  return word.status !== 'new' && (!word.due_at || Date.parse(word.due_at) <= Number(time));
}

export function nextReview(word, time = Date.now()) {
  if (word.due_at && Date.parse(word.due_at) > Number(time) && word.review_streak > 0) {
    return { dueAt: word.due_at, streak: word.review_streak };
  }
  const streak = Math.min((word.review_streak || 0) + 1, intervals.length);
  return { dueAt: new Date(Number(time) + intervals[streak - 1] * dayMs).toISOString(), streak };
}
