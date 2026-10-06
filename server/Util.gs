/**
 * Util.gs — shared helpers: versioning, script properties, dates, JSON output,
 * word tokenizing (must stay identical to js/text.js), errors.
 */

var SERVER_VERSION = '1.0.1';

/** Error type the router turns into a clean {ok:false} answer for the page. */
function AppError(code, message) {
  this.code = code;
  this.message = message || code;
}
AppError.prototype = Object.create(Error.prototype);

function fail(code, message) {
  throw new AppError(code, message);
}

function prop(name, required) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (required && !v) fail('config_missing', 'Missing script property: ' + name);
  return v;
}

function setProp(name, value) {
  PropertiesService.getScriptProperties().setProperty(name, value);
}

function tz() {
  return Session.getScriptTimeZone() || 'Asia/Jerusalem';
}

/** Today's date in the script time zone, as yyyy-MM-dd. */
function todayStr() {
  return Utilities.formatDate(new Date(Date.now()), tz(), 'yyyy-MM-dd');
}

function fmtTime(d) {
  return d ? Utilities.formatDate(new Date(d), tz(), 'HH:mm') : '';
}

function nowMs() {
  return Date.now();
}

function newId() {
  return Utilities.getUuid().slice(0, 8);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

/**
 * Word tokenizer. KEEP IN SYNC with js/text.js (tests/text.test.mjs checks both).
 * Returns the words of a text, in order, as they are displayed.
 */
var WORD_RE = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g;

function tokenize(text) {
  return String(text || '').match(WORD_RE) || [];
}

/** Lower-case, straight apostrophes removed: the form used for comparing words. */
function normWord(w) {
  return String(w || '').toLowerCase().replace(/['’]/g, '');
}
