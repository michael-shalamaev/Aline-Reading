/**
 * Scoring.gs — the server decides. The phone sends a status per word of the page
 * (as aligned against Microsoft's results); this file counts, applies the parent's
 * rules and keeps the best attempt. Durations are measured here, not on the phone.
 */

var WORD_STATUS = { ok: 1, om: 1, sub: 1, mis: 1, hint: 1 };
var MAX_ATTEMPTS = 2;

function scoreAttempt(pageText, payload, durSec) {
  var ref = tokenize(pageText);
  var statuses = payload.words || [];
  if (statuses.length !== ref.length) {
    fail('bad_payload', 'Expected ' + ref.length + ' word results, got ' + statuses.length);
  }
  var count = { ok: 0, om: 0, sub: 0, mis: 0, hint: 0 };
  var errWords = [];
  var said = payload.said || {};
  statuses.forEach(function (st, i) {
    if (!WORD_STATUS[st]) st = 'om';
    count[st]++;
    if (st === 'sub') errWords.push({ w: ref[i], t: st, said: String(said[i] || '').slice(0, 40) });
    else if (st !== 'ok') errWords.push({ w: ref[i], t: st });
  });
  var ins = Math.max(0, Math.min(ref.length, parseInt(payload.insertions, 10) || 0));
  var n = ref.length;
  var errors = count.om + count.sub + count.mis + count.hint + ins;
  var minutes = Math.max(durSec, 1) / 60;
  return {
    at: Date.now(),
    n: n,
    ok: count.ok,
    om: count.om,
    sub: count.sub,
    mis: count.mis,
    hint: count.hint,
    ins: ins,
    errors: errors,
    acc: round1(Math.max(0, (n - errors) / n * 100)),
    durSec: Math.round(durSec),
    wpm: Math.round((count.ok + count.mis + count.sub) / minutes),
    errWords: errWords,
    extraWords: (payload.extraWords || []).slice(0, 40).map(function (w) { return String(w).slice(0, 30); })
  };
}

/** Is a single page below the bar? In error mode, the error budget is split by page length. */
function pageBelowBar(child, attempt, totalWords) {
  if (child.passByErrors) {
    var budget = Math.ceil(child.maxErrors * attempt.n / Math.max(totalWords, 1));
    return attempt.errors > budget;
  }
  return attempt.acc < child.passPercent;
}

function bestIndex(attempts) {
  var best = -1;
  attempts.forEach(function (a, i) {
    if (best < 0 || a.acc > attempts[best].acc) best = i;
  });
  return best;
}

function summaryOfAttempt(a) {
  if (!a) return null;
  return { n: a.n, acc: a.acc, errors: a.errors, om: a.om, sub: a.sub || 0, mis: a.mis, hint: a.hint, ins: a.ins, wpm: a.wpm, durSec: a.durSec };
}

/** Totals over the best attempt of every page, and the pass decision. */
function finalResult(child, sess) {
  var s = sess.state;
  var story = sess.story;
  var t = { n: 0, errors: 0, om: 0, sub: 0, mis: 0, hint: 0, ins: 0, durSec: 0, attempts: 0 };
  var fastPages = [];
  s.pages.forEach(function (p, i) {
    var a = p.attempts[p.best];
    t.n += a.n; t.errors += a.errors; t.om += a.om; t.sub += a.sub || 0; t.mis += a.mis;
    t.hint += a.hint; t.ins += a.ins; t.durSec += a.durSec;
    t.attempts += p.attempts.length;
    if (a.wpm > child.maxWpm) fastPages.push(i + 1);
  });
  var acc = round1(Math.max(0, (t.n - t.errors) / t.n * 100));
  var readingPassed = child.passByErrors ? t.errors <= child.maxErrors : acc >= child.passPercent;

  var withQuestions = !s.extra || child.extraQuestions;
  var answers = withQuestions
    ? s.pages.map(function (p) { return p.answer; }).concat(s.finalAnswers)
    : [];
  var correct = answers.filter(function (a) { return a && a.correct; }).length;
  var quizPct = answers.length ? Math.round(correct / answers.length * 100) : null;
  var quizPassed = !withQuestions || !child.quizBlocks || quizPct >= child.quizMinPercent;

  var flags = [];
  if (fastPages.length) flags.push('קצב מהיר מדי בעמודים ' + fastPages.join(', '));
  if (s.expiredCount) flags.push('חלון הזמן פג ' + s.expiredCount + ' פעמים קודם');
  if (story.topicAdjusted) {
    var chosen = s.topics[s.topics.length - 1];
    flags.push('הנושא שונה' + (chosen ? ' מ"' + chosen + '"' : '') + (story.topicUsed ? ' ל"' + story.topicUsed + '"' : '') + ', כי לא התאים לסיפור ילדים');
  }

  return {
    passed: readingPassed && quizPassed,
    readingPassed: readingPassed,
    quizPassed: quizPassed,
    acc: acc,
    words: t.n,
    errors: t.errors,
    om: t.om,
    sub: t.sub,
    mis: t.mis,
    hint: t.hint,
    ins: t.ins,
    attempts: t.attempts,
    minutes: round1((Date.now() - s.startedAt) / 60000),
    readMinutes: round1(t.durSec / 60),
    wpm: Math.round((t.n - t.om) / Math.max(t.durSec / 60, 0.1)),
    quizCorrect: correct,
    quizTotal: answers.length,
    quizPct: quizPct,
    flags: flags
  };
}
