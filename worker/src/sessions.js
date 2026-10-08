// sessions.js — one reading session per child per day (plus extra stories): the state,
// the time window, and what the phone may see. Mirrors server/Sessions.gs.

import { newId, todayStr, clock } from './util.js';
import { summaryOfAttempt } from './scoring.js';
import { publicStory } from './stories.js';
import { report } from './reports.js';

export function blankState(child, extra) {
  return {
    id: newId(), child: child.id, date: todayStr(), extra: !!extra,
    regenUsed: 0, topics: [], startedAt: null, pageStartedAt: {}, pages: [],
    finalAnswers: [null, null, null], finished: false, result: null, expiredCount: 0
  };
}

export function resetProgress(state, pageCount) {
  state.startedAt = null;
  state.pageStartedAt = {};
  state.pages = [];
  for (let i = 0; i < pageCount; i++) state.pages.push({ attempts: [], best: -1, answer: null });
  state.finalAnswers = [null, null, null];
}

/** The time window ran out before the story was finished: progress starts over (and the parent hears). */
export function checkWindow(env, sess, child) {
  const s = sess.state;
  if (!s.startedAt || s.finished || !sess.story) return false;
  if (clock.now() - s.startedAt <= child.windowMinutes * 60000) return false;
  const pagesDone = s.pages.filter((p) => p.best >= 0).length;
  const snapshot = JSON.parse(JSON.stringify({ state: s, story: { title: sess.story.title } }));
  sess.after.push(() => report(env, { kind: 'expired', childId: child.id, sess: snapshot, pagesDone }));
  s.expiredCount++;
  resetProgress(s, sess.story.pages.length);
  sess.dirty = true;
  return true;
}

export function publicSession(sess, child) {
  if (!sess) return null;
  const s = sess.state;
  return {
    id: s.id,
    extra: s.extra,
    questions: !s.extra || child.extraQuestions,
    story: publicStory(sess.story, s.id),
    regenLeft: Math.max(0, child.regenPerDay - s.regenUsed),
    locked: !!s.startedAt,
    startedAt: s.startedAt,
    windowMinutes: child.windowMinutes,
    expiredCount: s.expiredCount,
    pages: s.pages.map((p) => ({
      attempts: p.attempts.length,
      best: p.best >= 0 ? summaryOfAttempt(p.attempts[p.best]) : null,
      answered: p.answer ? { choice: p.answer.choice, correct: p.answer.correct } : null
    })),
    finalAnswers: s.finalAnswers.map((a) => (a ? { choice: a.choice, correct: a.correct } : null)),
    finished: s.finished,
    result: s.result
  };
}
