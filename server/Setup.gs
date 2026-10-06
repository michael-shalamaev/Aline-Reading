/**
 * Setup.gs — run once from the editor. Creates the sheet and its tabs,
 * a first child with a secret code, and writes the child's link.
 * Also: addChild() for another child, selfTest() to check every connection.
 */

function setup() {
  var id = prop('SHEET_ID');
  var book;
  if (id) {
    book = SpreadsheetApp.openById(id);
  } else {
    book = SpreadsheetApp.create('קריאה באנגלית: הגדרות ויומן');
    setProp('SHEET_ID', book.getId());
  }

  // Tabs with headers, in reading order for the parent.
  [SHEETS.settings, SHEETS.log, SHEETS.pages, SHEETS.words, SHEETS.stories, SHEETS.errors].forEach(function (name, i) {
    var sh = book.getSheetByName(name) || book.insertSheet(name, i);
    sh.setRightToLeft(true);
    if (name === SHEETS.settings) return;
    var h = headersFor(name);
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#eef3fb');
    sh.setFrozenRows(1);
  });
  var stray = book.getSheetByName('Sheet1') || book.getSheetByName('גיליון1');
  if (stray && book.getSheets().length > 1) book.deleteSheet(stray);

  // The stories tab holds JSON for the app; hide it to keep the sheet readable.
  book.getSheetByName(SHEETS.stories).hideSheet();

  var st = book.getSheetByName(SHEETS.settings);
  if (st.getLastRow() < 2) {
    var rows = [['מפתח', 'הסבר', 'ילד 1']];
    SETTING_DEFS.forEach(function (d) {
      rows.push([d.key, d.label, d.key === 'code' ? makeCode() : d.def]);
    });
    st.getRange(1, 1, rows.length, 3).setValues(rows);
    st.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#eef3fb');
    st.setFrozenRows(1);
    st.setFrozenColumns(2);
    st.setColumnWidth(1, 120);
    st.setColumnWidth(2, 380);
    st.setColumnWidth(3, 220);
    st.getRange('A:A').setFontColor('#888888');
  }
  addMissingSettings(st);
  writeLinks();
  clearSettingsCache();
  Logger.log('הגיליון מוכן: ' + book.getUrl());
  readChildren().forEach(function (c) { Logger.log(c.name + ': ' + c.link); });
}

/** New settings from a code update get their row, with the default for every child. */
function addMissingSettings(st) {
  var values = st.getDataRange().getValues();
  var have = {};
  values.forEach(function (r) { have[String(r[0])] = true; });
  var width = Math.max(3, values[0].length);
  SETTING_DEFS.forEach(function (d) {
    if (have[d.key]) return;
    var row = [d.key, d.label];
    for (var c = 2; c < width; c++) row.push(d.def);
    st.appendRow(row);
    Logger.log('נוספה הגדרה חדשה: ' + d.key);
  });
}

/** Adds a column for another child, with defaults and a new secret code. */
function addChild() {
  var st = sheet(SHEETS.settings);
  var col = st.getLastColumn() + 1;
  var values = st.getRange(1, 1, st.getLastRow(), 1).getValues();
  st.getRange(1, col).setValue('ילד ' + (col - 2)).setFontWeight('bold').setBackground('#eef3fb');
  values.forEach(function (r, i) {
    var d = SETTING_DEFS.filter(function (x) { return x.key === r[0]; })[0];
    if (d) st.getRange(i + 1, col).setValue(d.key === 'code' ? makeCode() : (d.key === 'name' ? '' : d.def));
  });
  st.setColumnWidth(col, 220);
  writeLinks();
  clearSettingsCache();
  Logger.log('נוספה עמודה ' + col + '. מלא שם בשורה הראשונה של ההגדרות.');
}

/** Writes each child's personal link next to its code. Needs PAGE_URL. */
function writeLinks() {
  var page = prop('PAGE_URL');
  var st = sheet(SHEETS.settings);
  var values = st.getDataRange().getValues();
  var codeRow = -1, linkRow = -1;
  values.forEach(function (r, i) {
    if (r[0] === 'code') codeRow = i;
    if (r[0] === 'link') linkRow = i;
  });
  if (codeRow < 0 || linkRow < 0) return;
  for (var col = 2; col < values[0].length; col++) {
    var code = values[codeRow][col];
    var link = page && code ? page.replace(/\/?$/, '/') + '?k=' + encodeURIComponent(code) : 'חסר PAGE_URL';
    st.getRange(linkRow + 1, col + 1).setValue(link);
  }
}

function makeCode() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

/** Checks every connection and prints a report in the execution log. */
function selfTest() {
  var report = [];
  function check(name, fn) {
    try { report.push('✅ ' + name + ': ' + fn()); } catch (e) { report.push('❌ ' + name + ': ' + (e.message || e)); }
  }
  check('גרסת שרת', function () { return SERVER_VERSION; });
  check('אזור זמן', function () { return tz() + ', היום ' + todayStr(); });
  check('גיליון', function () { return ss().getName(); });
  check('ילדים', function () {
    return readChildren().map(function (c) { return c.name + (c.active ? '' : ' (לא פעיל)'); }).join(', ') || 'אין';
  });
  check('כתובת העמוד', function () { return prop('PAGE_URL', true); });
  check('ג\'מיני: מודל', function () { return geminiModel(); });
  check('ג\'מיני: ניסיון קצר', function () {
    var res = UrlFetchApp.fetch(GEMINI_BASE + '/models/' + geminiModel() + ':generateContent', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-goog-api-key': prop('GEMINI_API_KEY', true) },
      payload: JSON.stringify({ contents: [{ parts: [{ text: 'Say OK' }] }] })
    });
    if (res.getResponseCode() !== 200) throw new Error(res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
    return 'עונה';
  });
  check('מיקרוסופט: אישור זמני', function () {
    CacheService.getScriptCache().remove('speech_token');
    var t = issueSpeechToken();
    return 'התקבל, אזור ' + t.region;
  });
  check('מייל: מכסה יומית שנותרה', function () { return MailApp.getRemainingDailyQuota(); });
  Logger.log('\n' + report.join('\n'));
  return report;
}

/** Full story generation test, without saving anything. Prints the story. */
// The topic testStory() tries. Change it here to check a topic a child had trouble with.
var TEST_TOPIC = 'a friendly dragon who loves pizza';

function testStory() {
  var child = readChildren()[0];
  if (!child) throw new Error('No child configured');
  var story = generateStory(child, TEST_TOPIC, true);
  Logger.log(JSON.stringify(story, null, 2));
}
