// scoring.js — counting, pass rules and the best attempt. Mirrors server/Scoring.gs.

import { tokenize, round1, fail, clock } from './util.js';

const WORD_STATUS = { ok: 1, om: 1, sub: 1, mis: 1, hint: 1 };
export const MAX_ATTEMPTS = 2;

export function scoreAttempt(pageText, payload, durSec) {
  const ref = tokenize(pageText);
  const statuses = payload.words || [];
  if (statuses.length !== ref.length) fail('bad_payload', `Expected ${ref.length} word results, got ${statuses.length}`);
  const count = { ok: 0, om: 0, sub: 0, mis: 0, hint: 0 };
  const errWords = [];
  const said = payload.said || {};
  statuses.forEach((st0, i) => {
    const st = WORD_STATUS[st0] ? st0 : 'om';
    count[st]++;
    if (st === 'sub') errWords.push({ w: ref[i], t: st, said: String(said[i] || '').slice(0, 40) });
    else if (st !== 'ok') errWords.push({ w: ref[i], t: st });
  });
  const ins = Math.max(0, Math.min(ref.length, parseInt(payload.insertions, 10) || 0));
  const n = ref.length;
  const errors = count.om + count.sub + count.mis + count.hint + ins;
  const minutes = Math.max(durSec, 1) / 60;
  return {
    at: clock.now(),
    n, ok: count.ok, om: count.om, sub: count.sub, mis: count.mis, hint: count.hint, ins,
    errors,
    acc: round1(Math.max(0, (n - errors) / n * 100)),
    durSec: Math.round(durSec),
    wpm: Math.round((count.ok + count.mis + count.sub) / minutes),
    errWords,
    extraWords: (payload.extraWords || []).slice(0, 40).map((w) => String(w).slice(0, 30))
  };
}

export function pageBelowBar(child, attempt, totalWords) {
  if (child.passByErrors) {
    const budget = Math.ceil(child.maxErrors * attempt.n / Math.max(totalWords, 1));
    return attempt.errors > budget;
  }
  return attempt.acc < child.passPercent;
}

export function bestIndex(attempts) {
  let best = -1;
  attempts.forEach((a, i) => { if (best < 0 || a.acc > attempts[best].acc) best = i; });
  return best;
}

export function summaryOfAttempt(a) {
  if (!a) return null;
  return { n: a.n, acc: a.acc, errors: a.errors, om: a.om, sub: a.sub || 0, mis: a.mis, hint: a.hint, ins: a.ins, wpm: a.wpm, durSec: a.durSec };
}

export function finalResult(child, sess) {
  const s = sess.state;
  const t = { n: 0, errors: 0, om: 0, sub: 0, mis: 0, hint: 0, ins: 0, durSec: 0, attempts: 0 };
  const fastPages = [];
  s.pages.forEach((p, i) => {
    const a = p.attempts[p.best];
    t.n += a.n; t.errors += a.errors; t.om += a.om; t.sub += a.sub || 0; t.mis += a.mis;
    t.hint += a.hint; t.ins += a.ins; t.durSec += a.durSec;
    t.attempts += p.attempts.length;
    if (a.wpm > child.maxWpm) fastPages.push(i + 1);
  });
  const acc = round1(Math.max(0, (t.n - t.errors) / t.n * 100));
  const readingPassed = child.passByErrors ? t.errors <= child.maxErrors : acc >= child.passPercent;
  const withQuestions = !s.extra || child.extraQuestions;
  const answers = withQuestions ? s.pages.map((p) => p.answer).concat(s.finalAnswers) : [];
  const correct = answers.filter((a) => a && a.correct).length;
  const quizPct = answers.length ? Math.round(correct / answers.length * 100) : null;
  const quizPassed = !withQuestions || !child.quizBlocks || quizPct >= child.quizMinPercent;
  const flags = [];
  if (fastPages.length) flags.push('קצב מהיר מדי בעמודים ' + fastPages.join(', '));
  if (s.expiredCount) flags.push('חלון הזמן פג ' + s.expiredCount + ' פעמים קודם');
  if (sess.story.topicAdjusted) flags.push('הנושא שונה כי לא התאים לגיל');
  return {
    passed: readingPassed && quizPassed, readingPassed, quizPassed,
    acc, words: t.n, errors: t.errors, om: t.om, sub: t.sub, mis: t.mis, hint: t.hint, ins: t.ins,
    attempts: t.attempts,
    minutes: round1((clock.now() - s.startedAt) / 60000),
    readMinutes: round1(t.durSec / 60),
    wpm: Math.round((t.n - t.om) / Math.max(t.durSec / 60, 0.1)),
    quizCorrect: correct, quizTotal: answers.length, quizPct, flags
  };
}
