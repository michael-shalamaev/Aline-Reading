// router.js — one action per request, same actions and answers as server/Router.gs, so the
// page works with either server. Every answer: {ok, a, v, t, ms, lockMs, data | error}.

import { SERVER_VERSION, AppError, fail, clock, todayStr } from './util.js';
import { ensureSchema, findSession, findOrCreateSession, updateSession } from './store.js';
import { authChild } from './auth.js';
import { publicSettings } from './settings.js';
import { generateStory } from './stories.js';
import { issueSpeechToken } from './speech.js';
import { scoreAttempt, pageBelowBar, bestIndex, summaryOfAttempt, finalResult, MAX_ATTEMPTS } from './scoring.js';
import { blankState, resetProgress, checkWindow, publicSession } from './sessions.js';
import { report, flushReports } from './reports.js';

const ACTIONS = {
  ping: actPing, init: actInit, newStory: actNewStory, startPage: actStartPage, speechToken: actSpeechToken,
  submitPage: actSubmitPage, answer: actAnswer, practice: actPractice, finish: actFinish, clientError: actClientError
};

// Expected refusals (page_not_allowed, too_early...) are not errors; these are.
const LOGGED_ERRORS = new Set(['gemini_error', 'topic_blocked', 'speech_token_error', 'bad_story', 'busy', 'config_missing', 'settings_unavailable']);

/** ctx.waitUntil lets work go on after the answer was sent (reports to the sheet). */
export async function handle(req, env, ctx) {
  const t0 = clock.now();
  const action = req.action || 'ping';
  let childId = '';
  let out;
  try {
    await ensureSchema(env.DB);
    const fn = ACTIONS[action];
    if (!fn) fail('unknown_action', action);
    const child = action === 'ping' ? null : await authChild(env, req.k, ctx);
    childId = child ? child.id : '';
    const data = await fn(env, child, req);
    out = { ok: true, a: action, v: SERVER_VERSION, t: clock.now(), ms: clock.now() - t0, lockMs: 0, data };
  } catch (e) {
    const known = e instanceof AppError;
    if (!known || LOGGED_ERRORS.has(e.code)) {
      try {
        await report(env, { kind: 'error', childId, action, message: `${known ? e.code + ': ' : ''}${e.message}`, details: known ? '' : String(e.stack || '').slice(0, 1000) });
      } catch { /* the database itself failed; nothing more to do */ }
    }
    out = {
      ok: false, a: action, v: SERVER_VERSION, t: clock.now(), ms: clock.now() - t0, lockMs: 0,
      error: { code: known ? e.code : 'server_error', message: e.message || String(e) }
    };
  }
  // Rows and mails for the parent go out after the answer, without the child waiting.
  if (ctx && ctx.waitUntil) ctx.waitUntil(flushReports(env).catch(() => {}));
  return out;
}

/* ---------- helpers ---------- */

const loader = (env, child, extra, includeFinished = false) => () => findSession(env.DB, child, todayStr(), !!extra, includeFinished);

function loadActive(sess) {
  if (!sess || !sess.story) fail('no_story', 'No story yet');
  if (sess.state.finished) fail('finished', 'This story is finished');
  return sess;
}

function pageIndex(sess, req) {
  const i = parseInt(req.page, 10);
  if (!(i >= 0 && i < sess.state.pages.length)) fail('bad_payload', 'Bad page');
  return i;
}

function allowedToRead(child, sess, i) {
  const pages = sess.state.pages;
  let next = -1;
  for (let j = 0; j < pages.length; j++) { if (pages[j].best < 0) { next = j; break; } }
  if (i === next) return true;
  const p = pages[i];
  const lastDone = next < 0 ? pages.length - 1 : next - 1;
  return i === lastDone && p.attempts.length === 1 && pageBelowBar(child, p.attempts[0], sess.story.wordCount);
}

function storyComplete(child, sess) {
  const s = sess.state;
  if (s.finished || s.pages.some((p) => p.best < 0)) return false;
  if (s.extra && !child.extraQuestions) return true;
  return !s.pages.some((p) => !p.answer) && !s.finalAnswers.some((a) => !a);
}

/** Sums the story up; the parent's log row, hard words and mail follow in the background. */
function closeStory(env, child, sess) {
  const s = sess.state;
  const r = finalResult(child, sess);
  s.result = r;
  s.finished = true;
  s.finishedAt = clock.now();
  sess.dirty = true;
  const snapshot = JSON.parse(JSON.stringify({ state: s, story: { title: sess.story.title } }));
  sess.after.push(() => report(env, { kind: 'session', childId: child.id, sess: snapshot, result: r }));
  return r;
}

/* ---------- actions ---------- */

async function actPing() {
  return { version: SERVER_VERSION, time: new Date(clock.now()).toISOString() };
}

async function actInit(env, child) {
  const main = await updateSession(env.DB, loader(env, child, false), async (sess) => {
    if (sess) checkWindow(env, sess, child);
    return sess;
  });
  let extra = null;
  if (main && main.state.finished && main.state.result.passed && child.extraAllowed) {
    extra = await updateSession(env.DB, loader(env, child, true), async (sess) => {
      if (sess) checkWindow(env, sess, child);
      return sess;
    });
  }
  return {
    version: SERVER_VERSION,
    today: todayStr(),
    child: publicSettings(child),
    session: publicSession(main, child),
    extraSession: publicSession(extra, child)
  };
}

async function requireExtraAllowed(env, child) {
  const main = await findSession(env.DB, child, todayStr(), false);
  if (!child.extraAllowed || !main || !main.state.finished || !main.state.result.passed) {
    fail('extra_not_allowed', 'Extra story is available after passing today\'s story');
  }
}

async function actNewStory(env, child, req) {
  const extra = !!req.extra;
  const topic = String(req.topic || '').trim().slice(0, 80);
  if (!topic) fail('bad_payload', 'Topic is empty');
  // Check before the slow call, so a locked story never costs a generation.
  if (extra) await requireExtraAllowed(env, child);
  const before = await findSession(env.DB, child, todayStr(), extra);
  if (before && before.state.startedAt) fail('locked', 'Reading already started');
  if (before && before.story && before.state.regenUsed >= child.regenPerDay) fail('no_regen_left', 'No more changes today');

  const story = await generateStory(env, child, topic, !extra || child.extraQuestions);

  const load = () => findOrCreateSession(env.DB, child, todayStr(), extra, () => blankState(child, extra));
  return updateSession(env.DB, load, async (sess) => {
    if (sess.state.startedAt) fail('locked', 'Reading already started');
    if (sess.story) sess.state.regenUsed++;
    sess.story = story;
    sess.state.topics.push(topic);
    resetProgress(sess.state, story.pages.length);
    sess.dirty = true;
    return publicSession(sess, child);
  });
}

async function actStartPage(env, child, req) {
  const out = await updateSession(env.DB, loader(env, child, req.extra), async (sess) => {
    loadActive(sess);
    if (checkWindow(env, sess, child)) return { expired: true, session: publicSession(sess, child) };
    const i = pageIndex(sess, req);
    if (!allowedToRead(child, sess, i)) fail('page_not_allowed', 'This page cannot be read now');
    if (!sess.state.startedAt) sess.state.startedAt = clock.now();
    sess.state.pageStartedAt[i] = clock.now();
    sess.dirty = true;
    return { expired: false, startedAt: sess.state.startedAt };
  });
  if (!out.expired) {
    out.speech = null;
    try { out.speech = await issueSpeechToken(env); } catch (e) {
      await report(env, { kind: 'error', childId: child.id, action: 'startPage token', message: `${e.code || e.name}: ${e.message}` });
    }
  }
  return out;
}

async function actSpeechToken(env) {
  return issueSpeechToken(env);
}

function submitAnswer(child, sess, i, a) {
  const p = sess.state.pages[i];
  const below = pageBelowBar(child, a, sess.story.wordCount);
  return {
    expired: false,
    attempt: summaryOfAttempt(a),
    errWords: a.errWords,
    below,
    canRetry: below && p.attempts.length < MAX_ATTEMPTS,
    best: summaryOfAttempt(p.attempts[p.best])
  };
}

async function actSubmitPage(env, child, req) {
  return updateSession(env.DB, loader(env, child, req.extra), async (sess) => {
    loadActive(sess);
    const i = pageIndex(sess, req);
    const p = sess.state.pages[i];
    // The phone may send the same reading twice (after a timeout): answer, don't count again.
    const id = String(req.attemptId || '');
    if (id) {
      const same = p.attempts.find((x) => x.id === id);
      if (same) return submitAnswer(child, sess, i, same);
    }
    if (checkWindow(env, sess, child)) return { expired: true, session: publicSession(sess, child) };
    const started = sess.state.pageStartedAt[i];
    if (!started) fail('page_not_started', 'Page was not started');
    const phoneSec = Number(req.durSec);
    const dur = phoneSec > 0 && phoneSec < 1800 ? phoneSec : (clock.now() - started) / 1000;
    const a = scoreAttempt(sess.story.pages[i].text, req, dur);
    a.id = id;
    p.attempts.push(a);
    p.best = bestIndex(p.attempts);
    delete sess.state.pageStartedAt[i];
    sess.dirty = true;
    const below = pageBelowBar(child, a, sess.story.wordCount);
    const attemptNo = p.attempts.length;
    sess.after.push(() => report(env, {
      kind: 'pageAttempt', childId: child.id, sess: { state: { id: sess.state.id } }, page: i, attemptNo, attempt: a, below
    }));
    const answer = submitAnswer(child, sess, i, a);
    // A story without questions is complete with its last page (unless that page may still be read again).
    if (!answer.canRetry && storyComplete(child, sess)) closeStory(env, child, sess);
    return answer;
  });
}

async function actAnswer(env, child, req) {
  return updateSession(env.DB, loader(env, child, req.extra), async (sess) => {
    loadActive(sess);
    const choice = parseInt(req.choice, 10);
    if (!(choice >= 0 && choice <= 3)) fail('bad_payload', 'Bad choice');
    let slot, q;
    if (req.kind === 'final') {
      const f = parseInt(req.index, 10);
      if (!(f >= 0 && f < 3)) fail('bad_payload', 'Bad question');
      if (sess.state.pages.some((p) => p.best < 0)) fail('too_early', 'Finish the pages first');
      q = sess.story.finalQuestions[f];
      if (!sess.state.finalAnswers[f]) { sess.state.finalAnswers[f] = { choice, correct: choice === q.answer }; sess.dirty = true; }
      slot = sess.state.finalAnswers[f];
    } else {
      const i = pageIndex(sess, req);
      const p = sess.state.pages[i];
      if (p.best < 0) fail('too_early', 'Read the page first');
      q = sess.story.pages[i].question;
      if (!p.answer) { p.answer = { choice, correct: choice === q.answer }; sess.dirty = true; }
      slot = p.answer;
    }
    // The last answer completes the story: it is summed up here, not depending on the phone.
    if (storyComplete(child, sess)) closeStory(env, child, sess);
    return { correct: slot.correct, choice: slot.choice, correctIndex: q.answer };
  });
}

async function actPractice(env, child, req) {
  const results = (req.results || []).slice(0, 30)
    .map((r) => ({ word: String(r.word || '').slice(0, 40), ok: !!r.ok }))
    .filter((r) => r.word);
  if (results.length) await report(env, { kind: 'practice', childId: child.id, results });
  return { saved: results.length };
}

async function actFinish(env, child, req) {
  return updateSession(env.DB, loader(env, child, req.extra, true), async (sess) => {
    // Summing up twice (the first answer got lost, or two at once) gives the same result again.
    if (sess && sess.story && sess.state.finished) {
      return { result: sess.state.result, extraAllowed: !sess.state.extra && sess.state.result.passed && child.extraAllowed, again: true };
    }
    loadActive(sess);
    const s = sess.state;
    if (s.pages.some((p) => p.best < 0)) fail('too_early', 'Not all pages were read');
    if (!s.extra || child.extraQuestions) {
      // Every answer the phone has comes along, so one whose own save was lost is not asked again.
      const given = req.answers || {};
      s.pages.forEach((p, i) => {
        const c = parseInt((given.pages || [])[i], 10);
        if (!p.answer && c >= 0 && c <= 3) p.answer = { choice: c, correct: c === sess.story.pages[i].question.answer };
      });
      s.finalAnswers.forEach((a, f) => {
        const c = parseInt((given.final || [])[f], 10);
        if (!a && c >= 0 && c <= 3) s.finalAnswers[f] = { choice: c, correct: c === sess.story.finalQuestions[f].answer };
      });
      if (s.pages.some((p) => !p.answer) || s.finalAnswers.some((a) => !a)) fail('too_early', 'Not all questions were answered');
    }
    const r = closeStory(env, child, sess);
    return { result: r, extraAllowed: !s.extra && r.passed && child.extraAllowed };
  });
}

async function actClientError(env, child, req) {
  const cut = (x, n) => String(x || '').slice(0, n);
  await report(env, {
    kind: 'error', childId: child.id, action: 'טלפון: ' + cut(req.where, 80),
    message: cut(req.code, 40) + ': ' + cut(req.message, 500), details: cut(req.details, 4000)
  });
  return { saved: true };
}
