/**
 * Mailer.gs — the summary e-mail to the parent.
 */

function recipients(child) {
  var list = child.emails ? child.emails.split(',').map(function (s) { return s.trim(); }).filter(String) : [];
  if (!list.length) list = [Session.getEffectiveUser().getEmail()];
  return list.join(',');
}

function sheetUrl() {
  return 'https://docs.google.com/spreadsheets/d/' + prop('SHEET_ID', true);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sendSummaryMail(child, sess, r) {
  var s = sess.state;
  var verdict = r.passed ? 'עבר ✅' : 'לא עבר ❌';
  var subject = (s.extra ? 'סיפור נוסף, ' : 'קריאה יומית, ') + child.name + ': ' + verdict + ' · דיוק ' + r.acc + '%';

  var missed = [];
  s.pages.forEach(function (p) {
    p.attempts[p.best].errWords.forEach(function (e) { missed.push(e.w + ' (' + TYPE_HE[e.t] + ')'); });
  });

  var rows = [
    ['הנושא שנבחר', s.topics[s.topics.length - 1] || ''],
    ['כותרת', sess.story.title],
    ['תוצאה', verdict + (r.readingPassed && !r.quizPassed ? ' (בגלל שאלות ההבנה)' : '')],
    ['דיוק', r.acc + '% · ' + r.errors + ' שגיאות מתוך ' + r.words + ' מילים'],
    ['פירוט', 'הושמטו ' + r.om + ' · מילה אחרת ' + (r.sub || 0) + ' · הגייה ' + r.mis + ' · נוספו ' + r.ins + ' · רמזים ' + r.hint],
    ['זמן', fmtTime(s.startedAt) + ' עד ' + fmtTime(s.finishedAt || Date.now()) + ' · ' + r.minutes + ' דקות, מתוכן ' + r.readMinutes + ' קריאה'],
    ['קצב', r.wpm + ' מילים לדקה'],
    ['קריאות חוזרות', String(r.attempts - s.pages.length)],
    ['שאלות הבנה', r.quizTotal ? r.quizCorrect + ' מתוך ' + r.quizTotal : 'אין']
  ];
  if (r.flags.length) rows.push(['שים לב', r.flags.join('<br>')]);
  if (missed.length) rows.push(['מילים שפוספסו', missed.join(', ')]);

  var html = '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px">' +
    '<h2 style="margin:0 0 12px">' + esc(subject) + '</h2>' +
    '<table cellpadding="6" style="border-collapse:collapse">' +
    rows.map(function (r2) {
      return '<tr><td style="color:#666;vertical-align:top;white-space:nowrap">' + esc(r2[0]) +
        '</td><td>' + (r2[0] === 'שים לב' ? r2[1] : esc(r2[1])) + '</td></tr>';
    }).join('') +
    '</table><p><a href="' + sheetUrl() + '">לגיליון ההתקדמות</a></p></div>';

  MailApp.sendEmail({ to: recipients(child), subject: subject, htmlBody: html });
}

function sendExpiredMail(child, sess, pagesDone) {
  try {
    MailApp.sendEmail({
      to: recipients(child),
      subject: child.name + ': חלון הזמן פג באמצע הסיפור',
      htmlBody: '<div dir="rtl" style="font-family:Arial,sans-serif">הקריאה של "' + esc(sess.story.title) +
        '" התחילה בשעה ' + fmtTime(sess.state.startedAt) + ', והושלמו ' + pagesDone +
        ' עמודים לפני שחלון הזמן פג. ההתקדמות אופסה, והסיפור יתחיל שוב מהעמוד הראשון.</div>'
    });
  } catch (e) {
    logError(child.id, 'sendExpiredMail', e);
  }
}
