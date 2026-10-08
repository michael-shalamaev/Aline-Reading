/**
 * Router.gs — the web app's entry point. Every request is one JSON object
 * {action, k, ...}; every answer is {ok:true, data} or {ok:false, error:{code, message}}.
 */

var ACTIONS = {
  ping: actPing,
  init: actInit,
  newStory: actNewStory,
  startPage: actStartPage,
  speechToken: actSpeechToken,
  submitPage: actSubmitPage,
  answer: actAnswer,
  practice: actPractice,
  finish: actFinish,
  clientError: actClientError,
  // Wrapped: Bridge.gs may load after this file (Apps Script does not promise an order).
  bridgeSettings: function (child, req) { return actBridgeSettings(child, req); },
  bridgeReport: function (child, req) { return actBridgeReport(child, req); }
};

function doGet(e) {
  return handle((e && e.parameter) || {});
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) { body = {}; }
  return handle(body);
}

/**
 * Every answer names the action it answers (a): Google has been seen to hand back the answer
 * to an empty request (a ping) instead of ours, and the phone must notice.
 * Every answer carries ms (time spent in this script) and lockMs (of it, waiting for
 * another request to finish), so the page's log can tell slow server from slow network.
 */
function handle(req) {
  REQ = newReq();
  var action = req.action || 'ping';
  var childId = '';
  var out;
  try {
    var fn = ACTIONS[action];
    if (!fn) fail('unknown_action', action);
    // The bridge (Bridge.gs) has its own secret instead of a child's code.
    var child = action === 'ping' || action === 'bridgeSettings' || action === 'bridgeReport' ? null : authChild(req.k);
    childId = child ? child.id : '';
    var data = fn(child, req);
    out = { ok: true, a: action, v: SERVER_VERSION, t: Date.now(), ms: Date.now() - REQ.t0, lockMs: REQ.lockWaitMs, data: data };
  } catch (e) {
    var known = e instanceof AppError;
    if (!known || LOGGED_ERRORS.indexOf(e.code) >= 0) logError(childId, action, e);
    out = {
      ok: false, a: action, v: SERVER_VERSION, t: Date.now(), ms: Date.now() - REQ.t0, lockMs: REQ.lockWaitMs,
      error: { code: known ? e.code : 'server_error', message: e.message || String(e) }
    };
  }
  // Shows in the Apps Script editor under Executions.
  console.log(action + ' ' + (out.ok ? 'ok' : out.error.code) + ' ' + out.ms + 'ms (lock wait ' + out.lockMs + 'ms)');
  return jsonOut(out);
}

/** Expected refusals (page_not_allowed, too_early...) are not errors; these are. */
var LOGGED_ERRORS = ['gemini_error', 'topic_blocked', 'speech_token_error', 'bad_story', 'busy', 'sheet_missing', 'config_missing'];

/* ---------- actions ---------- */

function actPing() {
  return { version: SERVER_VERSION, time: new Date().toISOString() };
}

function actInit(child) {
  return withLock(function () {
    var main = findSession(child, false);
    if (main && checkWindow(main, child)) saveSession(main);
    var extra = null;
    if (main && main.state.finished && main.state.result.passed && child.extraAllowed) {
      extra = findSession(child, true);
      if (extra && checkWindow(extra, child)) saveSession(extra);
    }
    return {
      version: SERVER_VERSION,
      today: todayStr(),
      child: publicSettings(child),
      session: publicSession(main, child),
      extraSession: publicSession(extra, child)
    };
  });
}

function requireExtraAllowed(child) {
  var main = findSession(child, false);
  if (!child.extraAllowed || !main || !main.state.finished || !main.state.result.passed) {
    fail('extra_not_allowed', 'Extra story is available after passing today\'s story');
  }
}

function actNewStory(child, req) {
  var extra = !!req.extra;
  var topic = String(req.topic || '').trim().slice(0, 80);
  if (!topic) fail('bad_payload', 'Topic is empty');

  // Check before the slow call, so a locked story never costs a generation.
  withLock(function () {
    if (extra) requireExtraAllowed(child);
    var sess = findSession(child, extra);
    if (sess && sess.state.startedAt) fail('locked', 'Reading already started');
    if (sess && sess.story && sess.state.regenUsed >= child.regenPerDay) fail('no_regen_left', 'No more changes today');
  });

  var withQuestions = !extra || child.extraQuestions;
  var story = generateStory(child, topic, withQuestions);

  return withLock(function () {
    var sess = getOrCreateSession(child, extra);
    if (sess.state.startedAt) fail('locked', 'Reading already started');
    if (sess.story) sess.state.regenUsed++;
    sess.story = story;
    sess.state.topics.push(topic);
    resetProgress(sess.state, story.pages.length);
    saveSession(sess);
    return publicSession(sess, child);
  });
}

function loadActive(child, req) {
  var sess = findSession(child, !!req.extra);
  if (!sess || !sess.story) fail('no_story', 'No story yet');
  if (sess.state.finished) fail('finished', 'This story is finished');
  return sess;
}

function pageIndex(sess, req) {
  var i = parseInt(req.page, 10);
  if (!(i >= 0 && i < sess.state.pages.length)) fail('bad_payload', 'Bad page');
  return i;
}

/** Which page may be read now: the next unread page, or a single retry of the last read page. */
function allowedToRead(child, sess, i) {
  var pages = sess.state.pages;
  var next = -1;
  for (var j = 0; j < pages.length; j++) { if (pages[j].best < 0) { next = j; break; } }
  if (i === next) return true;
  var p = pages[i];
  var lastDone = next < 0 ? pages.length - 1 : next - 1;
  return i === lastDone && p.attempts.length === 1 && pageBelowBar(child, p.attempts[0], sess.story.wordCount);
}

function actStartPage(child, req) {
  var out = withLock(function () {
    var sess = loadActive(child, req);
    if (checkWindow(sess, child)) {
      saveSession(sess);
      return { expired: true, session: publicSession(sess, child) };
    }
    var i = pageIndex(sess, req);
    if (!allowedToRead(child, sess, i)) fail('page_not_allowed', 'This page cannot be read now');
    if (!sess.state.startedAt) sess.state.startedAt = Date.now();
    sess.state.pageStartedAt[i] = Date.now();
    saveSession(sess);
    return { expired: false, startedAt: sess.state.startedAt };
  });
  // The speech token rides along, saving the phone a second round trip.
  // Fetched after the lock is released: Microsoft can be slow, and nobody should wait for it.
  if (!out.expired) {
    out.speech = null;
    try { out.speech = issueSpeechToken(); } catch (e) { logError(child.id, 'startPage token', e); }
  }
  return out;
}

function actSpeechToken() {
  return issueSpeechToken();
}

function submitAnswer(child, sess, i, a) {
  var p = sess.state.pages[i];
  var below = pageBelowBar(child, a, sess.story.wordCount);
  return {
    expired: false,
    attempt: summaryOfAttempt(a),
    errWords: a.errWords,
    below: below,
    canRetry: below && p.attempts.length < MAX_ATTEMPTS,
    best: summaryOfAttempt(p.attempts[p.best])
  };
}

function actSubmitPage(child, req) {
  var logRow = null;
  var closing = null;
  var out = withLock(function () {
    var sess = loadActive(child, req);
    var i = pageIndex(sess, req);
    var p = sess.state.pages[i];
    // The phone may send the same attempt twice (it retries after a timeout): answer, don't count again.
    var id = String(req.attemptId || '');
    if (id) {
      for (var k = 0; k < p.attempts.length; k++) {
        if (p.attempts[k].id === id) return submitAnswer(child, sess, i, p.attempts[k]);
      }
    }
    if (checkWindow(sess, child)) {
      saveSession(sess);
      return { expired: true, session: publicSession(sess, child) };
    }
    var started = sess.state.pageStartedAt[i];
    if (!started) fail('page_not_started', 'Page was not started');
    // The phone measures the reading itself (the server may hear of the start late);
    // the server's own measure is the fallback.
    var phoneSec = Number(req.durSec);
    var dur = phoneSec > 0 && phoneSec < 1800 ? phoneSec : (Date.now() - started) / 1000;
    var a = scoreAttempt(sess.story.pages[i].text, req, dur);
    a.id = id;
    p.attempts.push(a);
    p.best = bestIndex(p.attempts);
    delete sess.state.pageStartedAt[i];
    saveSession(sess);
    logRow = function () { logPageAttempt(child, sess, i, p.attempts.length, a, pageBelowBar(child, a, sess.story.wordCount)); };
    var answer = submitAnswer(child, sess, i, a);
    // A story without questions is complete with its last page (unless that page may still be read again).
    if (!answer.canRetry && storyComplete(child, sess)) closing = closeStory(child, sess);
    return answer;
  });
  // The attempt is saved; the parent's log row is written after the lock is released.
  if (logRow) { try { logRow(); } catch (e) { logError(child.id, 'logPageAttempt', e); } }
  if (closing) closing();
  return out;
}

function actAnswer(child, req) {
  var closing = null;
  var out = withLock(function () {
    var sess = loadActive(child, req);
    var choice = parseInt(req.choice, 10);
    if (!(choice >= 0 && choice <= 3)) fail('bad_payload', 'Bad choice');
    var slot, q;
    if (req.kind === 'final') {
      var f = parseInt(req.index, 10);
      if (!(f >= 0 && f < 3)) fail('bad_payload', 'Bad question');
      if (sess.state.pages.some(function (p) { return p.best < 0; })) fail('too_early', 'Finish the pages first');
      q = sess.story.finalQuestions[f];
      if (!sess.state.finalAnswers[f]) sess.state.finalAnswers[f] = { choice: choice, correct: choice === q.answer };
      slot = sess.state.finalAnswers[f];
    } else {
      var i = pageIndex(sess, req);
      var p = sess.state.pages[i];
      if (p.best < 0) fail('too_early', 'Read the page first');
      q = sess.story.pages[i].question;
      if (!p.answer) p.answer = { choice: choice, correct: choice === q.answer };
      slot = p.answer;
    }
    saveSession(sess);
    // The last answer completes the story: it is summed up here, on the server, so the
    // result, the log and the mail do not depend on the phone staying open.
    if (storyComplete(child, sess)) closing = closeStory(child, sess);
    // The first answer counts; the correct option is shown either way.
    return { correct: slot.correct, choice: slot.choice, correctIndex: q.answer };
  });
  if (closing) closing();
  return out;
}

/** Every page read and, if the story has questions, every question answered. */
function storyComplete(child, sess) {
  var s = sess.state;
  if (s.finished || s.pages.some(function (p) { return p.best < 0; })) return false;
  if (s.extra && !child.extraQuestions) return true;
  return !s.pages.some(function (p) { return !p.answer; }) && !s.finalAnswers.some(function (a) { return !a; });
}

/**
 * Sums the story up and saves it (inside the lock). Returns what comes after the lock:
 * the parent's log row, the hard words and the mail.
 */
function closeStory(child, sess) {
  var s = sess.state;
  var r = finalResult(child, sess);
  s.result = r;
  s.finished = true;
  s.finishedAt = Date.now();
  saveSession(sess);
  return function () {
    try { logSession(child, sess, r); } catch (e) { logError(child.id, 'logSession', e); }
    try { withLock(function () { updateHardWords(child, sess); }); } catch (e) { logError(child.id, 'updateHardWords', e); }
    try { sendSummaryMail(child, sess, r); } catch (e) { logError(child.id, 'sendSummaryMail', e); }
  };
}

function actPractice(child, req) {
  var results = (req.results || []).slice(0, 30).map(function (r) {
    return { word: String(r.word || '').slice(0, 40), ok: !!r.ok };
  }).filter(function (r) { return r.word; });
  withLock(function () { logPracticeResults(child, results); });
  return { saved: results.length };
}

function actFinish(child, req) {
  var after = null;
  var out = withLock(function () {
    // Summing up twice (the first answer got lost on the way) gives the same result again.
    var done = findSession(child, !!req.extra, true);
    if (done && done.story && done.state.finished) {
      return { result: done.state.result, extraAllowed: !done.state.extra && done.state.result.passed && child.extraAllowed, again: true };
    }
    var sess = loadActive(child, req);
    var s = sess.state;
    if (s.pages.some(function (p) { return p.best < 0; })) fail('too_early', 'Not all pages were read');
    var withQuestions = !s.extra || child.extraQuestions;
    if (withQuestions) {
      // The phone sends every answer it has with the finish request, so an answer whose own
      // save got lost on the way is not asked again. An answer already saved is never changed.
      var given = req.answers || {};
      s.pages.forEach(function (p, i) {
        var c = parseInt((given.pages || [])[i], 10);
        if (!p.answer && c >= 0 && c <= 3) p.answer = { choice: c, correct: c === sess.story.pages[i].question.answer };
      });
      s.finalAnswers.forEach(function (a, f) {
        var c = parseInt((given.final || [])[f], 10);
        if (!a && c >= 0 && c <= 3) s.finalAnswers[f] = { choice: c, correct: c === sess.story.finalQuestions[f].answer };
      });
      var missing = s.pages.some(function (p) { return !p.answer; }) ||
        s.finalAnswers.some(function (a) { return !a; });
      if (missing) fail('too_early', 'Not all questions were answered');
    }
    after = closeStory(child, sess);
    var r = s.result;
    return { result: r, extraAllowed: !s.extra && r.passed && child.extraAllowed };
  });
  // The story is finished and saved; the parent's log, hard words and mail come after the lock.
  if (after) after();
  return out;
}

/** Something went wrong on the phone: one row in the errors tab, with the phone's last log lines. */
function actClientError(child, req) {
  var cut = function (x, n) { return String(x || '').slice(0, n); };
  sheet(SHEETS.errors).appendRow([
    new Date(), child.id, 'טלפון: ' + cut(req.where, 80),
    cut(req.code, 40) + ': ' + cut(req.message, 500),
    cut(req.details, 4000)
  ]);
  return { saved: true };
}
