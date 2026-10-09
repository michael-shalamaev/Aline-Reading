/**
 * StoryTexts.gs — a readable copy of every story the new server writes, for the parent:
 * one row per story (a story written again replaces nothing; it gets a row of its own,
 * with the same id). The tab is made the first time it is needed.
 */

var STORY_TEXTS_TAB = 'טקסט סיפורים';
var STORY_TEXTS_HEADERS = ['נוצר', 'ילד', 'תאריך', 'סיפור נוסף', 'נושא שנבחר', 'נושא בפועל', 'הנושא שונה', 'כותרת',
  'מילים', 'הטקסט', 'שאלות (✓ התשובה הנכונה)', 'מזהה'];

function storyTextsSheet() {
  var book = ss();
  var sh = book.getSheetByName(STORY_TEXTS_TAB);
  if (sh) return sh;
  sh = book.insertSheet(STORY_TEXTS_TAB);
  sh.setRightToLeft(true);
  sh.getRange(1, 1, 1, STORY_TEXTS_HEADERS.length).setValues([STORY_TEXTS_HEADERS])
    .setFontWeight('bold').setBackground('#eef3fb');
  sh.setFrozenRows(1);
  sh.setColumnWidth(10, 420);
  sh.setColumnWidth(11, 360);
  return sh;
}

function storyQuestionText(label, q) {
  return label + ': ' + q.q + '\n' + q.options.map(function (o, i) {
    return '   ' + (i + 1) + '. ' + o + (i === q.answer ? ' ✓' : '');
  }).join('\n');
}

/** it: { at, childId, sessId, date, extra, topic, story } from the new server. */
function logStoryText(it) {
  var st = it.story;
  var text = st.pages.map(function (p, i) { return 'עמוד ' + (i + 1) + '\n' + p.text; }).join('\n\n');
  var questions = st.pages
    .map(function (p, i) { return p.question ? storyQuestionText('עמוד ' + (i + 1), p.question) : ''; })
    .concat((st.finalQuestions || []).map(function (q, i) { return storyQuestionText('סיכום ' + (i + 1), q); }))
    .filter(function (x) { return x; });
  storyTextsSheet().appendRow([
    new Date(it.at || Date.now()), it.childId || '', it.date || '', it.extra ? 'כן' : 'לא', it.topic || '',
    st.topicUsed || '', st.topicAdjusted ? 'כן' : 'לא', st.title || '', st.wordCount || '',
    text.slice(0, 45000), (it.withQuestions === false ? 'בלי שאלות' : questions.join('\n\n')).slice(0, 45000), it.sessId || ''
  ]);
}
