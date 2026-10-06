/**
 * Settings.gs — the parent's settings tab: one row per setting, one column per child.
 * Column A = technical key (do not edit), column B = Hebrew explanation,
 * columns C onward = one child each.
 */

var SETTINGS_CACHE_SEC = 600;

var SHEETS = {
  settings: 'הגדרות',
  log: 'יומן',
  pages: 'עמודים',
  words: 'מילים קשות',
  stories: 'סיפורים',
  errors: 'שגיאות'
};

/** Every setting, its explanation for the parent, its default and type. */
var SETTING_DEFS = [
  { key: 'name', label: 'שם הילד, כפי שיופיע במסך ובמייל', def: 'אלין', type: 'string' },
  { key: 'code', label: 'קוד סודי לקישור. לא לשתף', def: '', type: 'string' },
  { key: 'link', label: 'הקישור האישי, נוצר אוטומטית', def: '', type: 'string' },
  { key: 'active', label: 'פעיל: כן או לא', def: 'כן', type: 'bool' },
  { key: 'words', label: 'אורך הסיפור במילים', def: 400, type: 'int' },
  { key: 'pages', label: 'מספר עמודים', def: 5, type: 'int' },
  { key: 'level', label: 'רמה: מתחילים, מתחילים מתקדמים, בינוני', def: 'מתחילים מתקדמים', type: 'string' },
  { key: 'passMode', label: 'סוג סף: אחוזים או שגיאות', def: 'אחוזים', type: 'string' },
  { key: 'passPercent', label: 'סף מעבר באחוזי דיוק', def: 85, type: 'int' },
  { key: 'maxErrors', label: 'מספר שגיאות מקסימלי, כשסוג הסף הוא שגיאות', def: 60, type: 'int' },
  { key: 'quizBlocks', label: 'שאלות ההבנה חוסמות מעבר: כן או לא', def: 'לא', type: 'bool' },
  { key: 'quizMinPercent', label: 'אחוז תשובות נכונות מינימלי, כשהשאלות חוסמות', def: 70, type: 'int' },
  { key: 'hintsPerPage', label: 'רמזים לעמוד במהלך הקריאה. 0 מכבה. כל רמז נספר כשגיאה', def: 3, type: 'int' },
  { key: 'windowMinutes', label: 'חלון זמן לסיום הסיפור, בדקות', def: 60, type: 'int' },
  { key: 'regenPerDay', label: 'כמה פעמים אפשר להחליף סיפור לפני תחילת הקריאה', def: 3, type: 'int' },
  { key: 'pronThreshold', label: 'רגישות הגייה: ציון מיקרוסופט (0-100) שמתחתיו מילה נספרת כשגיאת הגייה. נמוך = סלחני', def: 60, type: 'int' },
  { key: 'maxWpm', label: 'קצב חשוד: מילים לדקה', def: 160, type: 'int' },
  { key: 'accent', label: 'מבטא: אמריקאי או בריטי', def: 'אמריקאי', type: 'string' },
  { key: 'extraAllowed', label: 'סיפור נוסף אחרי מעבר: כן או לא', def: 'כן', type: 'bool' },
  { key: 'extraQuestions', label: 'שאלות בסיפור הנוסף: כן או לא', def: 'לא', type: 'bool' },
  { key: 'suggestions', label: 'הצעות נושאים, מופרדות בפסיק. ריק = בלי הצעות', def: 'Animals, Space, Magic, Football, Ocean, Dragons, Friends, Robots', type: 'string' },
  { key: 'emails', label: 'כתובות למייל הסיכום, מופרדות בפסיק. ריק = בעל הסקריפט', def: '', type: 'string' }
];

/** The spreadsheet, opened once per request (opening it is one of the slowest calls). */
function ss() {
  if (!REQ.book) REQ.book = SpreadsheetApp.openById(prop('SHEET_ID', true));
  return REQ.book;
}

function sheet(name) {
  if (REQ.sheets[name]) return REQ.sheets[name];
  var sh = ss().getSheetByName(name);
  if (!sh) fail('sheet_missing', 'Missing tab: ' + name + '. Run setup().');
  REQ.sheets[name] = sh;
  return sh;
}

function parseSetting(def, raw) {
  if (raw === '' || raw === null || raw === undefined) raw = def.def;
  switch (def.type) {
    case 'int':
      var n = parseInt(raw, 10);
      return isNaN(n) ? def.def : n;
    case 'bool':
      if (raw === true || raw === false) return raw;
      var s = String(raw).trim().toLowerCase();
      return s === 'כן' || s === 'true' || s === 'yes' || s === '1';
    default:
      return String(raw).trim();
  }
}

/** All children, keyed by column. Cached for 10 minutes; setup() clears the cache. */
function readChildren() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('children');
  if (hit) return JSON.parse(hit);

  var values = sheet(SHEETS.settings).getDataRange().getValues();
  var rowOf = {};
  values.forEach(function (r, i) { rowOf[String(r[0]).trim()] = i; });

  var children = [];
  var width = values[0].length;
  for (var col = 2; col < width; col++) {
    var child = { col: col + 1 };
    SETTING_DEFS.forEach(function (d) {
      var row = rowOf[d.key];
      child[d.key] = parseSetting(d, row === undefined ? '' : values[row][col]);
    });
    if (child.code) children.push(normalizeChild(child));
  }
  cache.put('children', JSON.stringify(children), SETTINGS_CACHE_SEC);
  return children;
}

function normalizeChild(c) {
  c.id = String(c.name || ('child' + c.col));
  c.pages = Math.max(1, Math.min(12, c.pages));
  c.words = Math.max(60, Math.min(2000, c.words));
  c.hintsPerPage = Math.max(0, c.hintsPerPage);
  c.lang = c.accent.indexOf('בריט') === 0 ? 'en-GB' : 'en-US';
  c.passByErrors = c.passMode.indexOf('שגיא') === 0;
  c.suggestionList = c.suggestions
    ? c.suggestions.split(',').map(function (s) { return s.trim(); }).filter(String)
    : [];
  return c;
}

/** What the page is allowed to see of a child's settings. */
function publicSettings(c) {
  return {
    name: c.name,
    pages: c.pages,
    words: c.words,
    hintsPerPage: c.hintsPerPage,
    regenPerDay: c.regenPerDay,
    windowMinutes: c.windowMinutes,
    lang: c.lang,
    extraAllowed: c.extraAllowed,
    suggestions: c.suggestionList,
    passByErrors: c.passByErrors,
    passPercent: c.passPercent,
    maxErrors: c.maxErrors,
    pronThreshold: Math.max(0, Math.min(100, c.pronThreshold))
  };
}

function clearSettingsCache() {
  CacheService.getScriptCache().remove('children');
}
