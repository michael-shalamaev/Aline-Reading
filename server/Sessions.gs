/**
 * Sessions.gs — one reading session per child per day (plus optional extra stories).
 * Stored in the stories tab: one row per session, story and progress as JSON.
 */

var STORY_COLS = ['מזהה', 'ילד', 'תאריך', 'נוסף', 'מצב', 'נושא', 'כותרת', 'נוצר', 'סיפור', 'התקדמות'];
var C = { id: 0, child: 1, date: 2, extra: 3, status: 4, topic: 5, title: 6, created: 7, story: 8, state: 9 };

function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function blankState(child, extra) {
  return {
    id: newId(),
    child: child.id,
    date: todayStr(),
    extra: !!extra,
    regenUsed: 0,
    topics: [],
    startedAt: null,
    pageStartedAt: {},
    pages: [],
    finalAnswers: [null, null, null],
    finished: false,
    result: null,
    expiredCount: 0
  };
}

function resetProgress(state, pageCount) {
  state.startedAt = null;
  state.pageStartedAt = {};
  state.pages = [];
  for (var i = 0; i < pageCount; i++) state.pages.push({ attempts: [], best: -1, answer: null });
  state.finalAnswers = [null, null, null];
}

/** Today's session for a child. Extra stories: the latest unfinished one. */
function findSession(child, extra) {
  var sh = sheet(SHEETS.stories);
  var last = sh.getLastRow();
  if (last < 2) return null;
  var rows = sh.getRange(2, 1, last - 1, STORY_COLS.length).getValues();
  var today = todayStr();
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i];
    if (String(r[C.child]) !== child.id || dateKey(r[C.date]) !== today) continue;
    if ((String(r[C.extra]) === 'כן') !== !!extra) continue;
    var state = JSON.parse(r[C.state]);
    if (extra && state.finished) return null;
    return {
      row: i + 2,
      story: r[C.story] ? JSON.parse(r[C.story]) : null,
      state: state
    };
  }
  return null;
}

function createSession(child, extra) {
  var state = blankState(child, extra);
  var sh = sheet(SHEETS.stories);
  sh.appendRow([state.id, child.id, state.date, extra ? 'כן' : 'לא', 'חדש', '', '', new Date(), '', JSON.stringify(state)]);
  return { row: sh.getLastRow(), story: null, state: state };
}

function getOrCreateSession(child, extra) {
  return findSession(child, extra) || createSession(child, extra);
}

function statusOf(state) {
  if (state.finished) return state.result && state.result.passed ? 'עבר' : 'לא עבר';
  if (state.startedAt) return 'בקריאה';
  return 'נבחר נושא';
}

function saveSession(sess) {
  var s = sess.state;
  var sh = sheet(SHEETS.stories);
  sh.getRange(sess.row, C.status + 1, 1, 3).setValues([[
    statusOf(s),
    s.topics.length ? s.topics[s.topics.length - 1] : '',
    sess.story ? sess.story.title : ''
  ]]);
  sh.getRange(sess.row, C.story + 1, 1, 2).setValues([[
    sess.story ? JSON.stringify(sess.story) : '',
    JSON.stringify(s)
  ]]);
}

/** A date cell as yyyy-MM-dd, whether Sheets kept it as text or turned it into a date. */
function dateKey(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, tz(), 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}

/** Resets progress if the time window ran out before the story was finished. */
function checkWindow(sess, child) {
  var s = sess.state;
  if (!s.startedAt || s.finished || !sess.story) return false;
  if (Date.now() - s.startedAt <= child.windowMinutes * 60000) return false;
  var pagesDone = s.pages.filter(function (p) { return p.best >= 0; }).length;
  logExpired(child, sess, pagesDone);
  sendExpiredMail(child, sess, pagesDone);
  s.expiredCount++;
  resetProgress(s, sess.story.pages.length);
  return true;
}

/** What the page needs to resume: story without answers, and progress. */
function publicSession(sess, child) {
  if (!sess) return null;
  var s = sess.state;
  return {
    id: s.id,
    extra: s.extra,
    questions: !s.extra || child.extraQuestions,
    story: publicStory(sess.story),
    regenLeft: Math.max(0, child.regenPerDay - s.regenUsed),
    locked: !!s.startedAt,
    startedAt: s.startedAt,
    windowMinutes: child.windowMinutes,
    expiredCount: s.expiredCount,
    pages: s.pages.map(function (p) {
      return {
        attempts: p.attempts.length,
        best: p.best >= 0 ? summaryOfAttempt(p.attempts[p.best]) : null,
        answered: p.answer ? { choice: p.answer.choice, correct: p.answer.correct } : null
      };
    }),
    finalAnswers: s.finalAnswers.map(function (a) { return a ? { choice: a.choice, correct: a.correct } : null; }),
    finished: s.finished,
    result: s.result
  };
}
