/**
 * Logging.gs — everything the parent reads in the sheet: daily log, per-page
 * attempts, the hard-words list, and technical errors.
 */

/**
 * Column headers per tab. A function, not a top-level object: Apps Script loads
 * files in an order we do not control, so nothing at top level may use another file.
 */
function headersFor(name) {
  var h = {};
  h[SHEETS.log] = ['תאריך', 'ילד', 'סיפור נוסף', 'נושא', 'כותרת', 'מילים', 'עמודים', 'התחלה', 'סיום', 'דקות כולל', 'דקות קריאה',
    'דיוק %', 'שגיאות', 'הושמטו', 'הגייה', 'נוספו', 'רמזים', 'מילים לדקה', 'ניסיונות', 'שאלות נכונות', 'עבר', 'הערות', 'מזהה', 'מילה אחרת'];
  h[SHEETS.pages] = ['זמן', 'ילד', 'מזהה', 'עמוד', 'ניסיון', 'מילים', 'דיוק %', 'שגיאות', 'הושמטו', 'הגייה', 'נוספו', 'רמזים',
    'שניות', 'מילים לדקה', 'מתחת לסף', 'מילים שגויות', 'מילה אחרת'];
  h[SHEETS.words] = ['ילד', 'מילה', 'שגיאות', 'מתוכן רמזים', 'פעם אחרונה', 'תרגול מוצלח', 'תרגול לא מוצלח', 'תרגול אחרון'];
  h[SHEETS.stories] = STORY_COLS;
  h[SHEETS.errors] = ['זמן', 'ילד', 'פעולה', 'הודעה', 'פרטים'];
  return h[name];
}

var TYPE_HE = { om: 'הושמטה', sub: 'מילה אחרת', mis: 'הגייה', hint: 'רמז' };

function logPageAttempt(child, sess, pageIdx, attemptNo, a, below) {
  sheet(SHEETS.pages).appendRow([
    new Date(), child.id, sess.state.id, pageIdx + 1, attemptNo, a.n, a.acc, a.errors, a.om, a.mis, a.ins, a.hint,
    a.durSec, a.wpm, below ? 'כן' : 'לא',
    a.errWords.map(function (e) { return e.w + ' (' + TYPE_HE[e.t] + (e.said ? ': ' + e.said : '') + ')'; }).join(', '),
    a.sub || 0
  ]);
}

function logSession(child, sess, r) {
  var s = sess.state;
  sheet(SHEETS.log).appendRow([
    s.date, child.id, s.extra ? 'כן' : 'לא', s.topics[s.topics.length - 1] || '', sess.story.title,
    r.words, s.pages.length, fmtTime(s.startedAt), fmtTime(Date.now()), r.minutes, r.readMinutes,
    r.acc, r.errors, r.om, r.mis, r.ins, r.hint, r.wpm, r.attempts,
    r.quizTotal ? r.quizCorrect + '/' + r.quizTotal : '', r.passed ? 'כן' : 'לא', r.flags.join('; '), s.id, r.sub || 0
  ]);
}

function logExpired(child, sess, pagesDone) {
  var s = sess.state;
  sheet(SHEETS.log).appendRow([
    s.date, child.id, s.extra ? 'כן' : 'לא', s.topics[s.topics.length - 1] || '', sess.story.title,
    '', s.pages.length, fmtTime(s.startedAt), '', '', '', '', '', '', '', '', '', '', '', '',
    'לא', 'חלון הזמן פג אחרי ' + pagesDone + ' עמודים. ההתקדמות אופסה', s.id
  ]);
}

/** Adds this session's error words to the hard-words list (best attempt of each page). */
function updateHardWords(child, sess) {
  var tally = {};
  sess.state.pages.forEach(function (p) {
    p.attempts[p.best].errWords.forEach(function (e) {
      var k = normWord(e.w);
      tally[k] = tally[k] || { w: e.w.toLowerCase(), n: 0, hints: 0 };
      tally[k].n++;
      if (e.t === 'hint') tally[k].hints++;
    });
  });
  var keys = Object.keys(tally);
  if (!keys.length) return;

  var sh = sheet(SHEETS.words);
  var data = sh.getDataRange().getValues();
  var rowOf = {};
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === child.id) rowOf[normWord(data[i][1])] = i;
  }
  var today = todayStr();
  var appends = [];
  keys.forEach(function (k) {
    var t = tally[k];
    if (rowOf[k] !== undefined) {
      var r = data[rowOf[k]];
      sh.getRange(rowOf[k] + 1, 3, 1, 3).setValues([[(+r[2] || 0) + t.n, (+r[3] || 0) + t.hints, today]]);
    } else {
      appends.push([child.id, t.w, t.n, t.hints, today, 0, 0, '']);
    }
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, 8).setValues(appends);
}

function logPracticeResults(child, results) {
  if (!results || !results.length) return;
  var sh = sheet(SHEETS.words);
  var data = sh.getDataRange().getValues();
  var today = todayStr();
  results.forEach(function (res) {
    var k = normWord(res.word);
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === child.id && normWord(data[i][1]) === k) {
        var col = res.ok ? 6 : 7;
        data[i][col - 1] = (+data[i][col - 1] || 0) + 1;
        sh.getRange(i + 1, col).setValue(data[i][col - 1]);
        sh.getRange(i + 1, 8).setValue(today);
        return;
      }
    }
    data.push([child.id, String(res.word).toLowerCase(), 0, 0, '', res.ok ? 1 : 0, res.ok ? 0 : 1, today]);
    sh.appendRow(data[data.length - 1]);
  });
}

/** Technical errors: never throws, so it is safe inside catch blocks. */
function logError(childId, action, e) {
  try {
    console.error(action, e && e.message, e && e.stack);
    sheet(SHEETS.errors).appendRow([
      new Date(), childId || '', action, (e && (e.code ? e.code + ': ' : '') + e.message) || String(e),
      (e && e.stack ? String(e.stack).slice(0, 1000) : '')
    ]);
  } catch (ignored) { /* the error tab itself is broken; console has it */ }
}
