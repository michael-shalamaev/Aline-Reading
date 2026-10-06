/**
 * Sessions.gs — one reading session per child per day (plus optional extra stories).
 * Stored in the stories tab: one row per session, story and progress as JSON.
 */

var STORY_COLS = ['מזהה', 'ילד', 'תאריך', 'נוסף', 'מצב', 'נושא', 'כותרת', 'נוצר', 'סיפור', 'התקדמות'];
var C = { id: 0, child: 1, date: 2, extra: 3, status: 4, topic: 5, title: 6, created: 7, story: 8, state: 9 };

/** Runs fn while holding the script lock. Keep the work inside short: other requests wait. */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  var t0 = Date.now();
  if (!lock.tryLock(20000)) fail('busy', 'Server busy, lock not free after 20s');
  REQ.lockWaitMs += Date.now() - t0;
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

/**
 * Today's session for a child. Extra stories: the latest unfinished one.
 * Speed: the row number is remembered in the cache, so usually only that one row is read.
 * Without it, only the first four (short) columns of all rows are scanned, never the stories.
 */
function findSession(child, extra) {
  var sh = sheet(SHEETS.stories);
  var today = todayStr();
  var cache = CacheService.getScriptCache();
  var key = sessionCacheKey(child, extra, today);
  var hint = String(cache.get(key) || '').split('|');
  var hintRow = parseInt(hint[0], 10);
  if (hintRow >= 2) {
    var row = sh.getRange(hintRow, 1, 1, STORY_COLS.length).getValues()[0];
    if (String(row[C.id]) === hint[1] && rowMatches(row, child, extra, today)) return sessionFromRow(row, hintRow, extra);
  }

  var last = sh.getLastRow();
  if (last < 2) return null;
  var keys = sh.getRange(2, 1, last - 1, C.extra + 1).getValues();
  for (var i = keys.length - 1; i >= 0; i--) {
    if (!rowMatches(keys[i], child, extra, today)) continue;
    var full = sh.getRange(i + 2, 1, 1, STORY_COLS.length).getValues()[0];
    cache.put(key, (i + 2) + '|' + full[C.id], 21600);
    return sessionFromRow(full, i + 2, extra);
  }
  return null;
}

function sessionCacheKey(child, extra, day) {
  return 'sess_' + child.id + '_' + day + (extra ? '_x' : '');
}

function rowMatches(r, child, extra, today) {
  return String(r[C.child]) === child.id && dateKey(r[C.date]) === today &&
    (String(r[C.extra]) === 'כן') === !!extra;
}

function sessionFromRow(r, rowNum, extra) {
  var state = JSON.parse(r[C.state]);
  if (extra && state.finished) return null;
  return {
    row: rowNum,
    created: r[C.created],
    story: r[C.story] ? JSON.parse(r[C.story]) : null,
    state: state
  };
}

function createSession(child, extra) {
  var state = blankState(child, extra);
  var sh = sheet(SHEETS.stories);
  var created = new Date();
  sh.appendRow([state.id, child.id, state.date, extra ? 'כן' : 'לא', 'חדש', '', '', created, '', JSON.stringify(state)]);
  var row = sh.getLastRow();
  CacheService.getScriptCache().put(sessionCacheKey(child, extra, state.date), row + '|' + state.id, 21600);
  return { row: row, created: created, story: null, state: state };
}

function getOrCreateSession(child, extra) {
  return findSession(child, extra) || createSession(child, extra);
}

function statusOf(state) {
  if (state.finished) return state.result && state.result.passed ? 'עבר' : 'לא עבר';
  if (state.startedAt) return 'בקריאה';
  return 'נבחר נושא';
}

/** One write for the whole session (status, topic, title, created, story, progress). */
function saveSession(sess) {
  var s = sess.state;
  sheet(SHEETS.stories).getRange(sess.row, C.status + 1, 1, STORY_COLS.length - C.status).setValues([[
    statusOf(s),
    s.topics.length ? s.topics[s.topics.length - 1] : '',
    sess.story ? sess.story.title : '',
    sess.created || new Date(),
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
    story: publicStory(sess.story, s.id),
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
