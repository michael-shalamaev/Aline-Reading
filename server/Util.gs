/**
 * Util.gs — shared helpers: versioning, script properties, dates, JSON output,
 * word tokenizing (must stay identical to js/text.js), errors.
 */

var SERVER_VERSION = '1.0.9';

/** Error type the router turns into a clean {ok:false} answer for the page. */
function AppError(code, message) {
  this.code = code;
  this.message = message || code;
}
AppError.prototype = Object.create(Error.prototype);

function fail(code, message) {
  throw new AppError(code, message);
}

/**
 * Per-request memory: Apps Script starts every request fresh, but the tests run many
 * requests in one process, so handle() resets this at the start of each one.
 */
var REQ = newReq();

function newReq() {
  return { t0: Date.now(), lockWaitMs: 0, book: null, sheets: {}, props: {} };
}

function prop(name, required) {
  if (!(name in REQ.props)) REQ.props[name] = PropertiesService.getScriptProperties().getProperty(name);
  var v = REQ.props[name];
  if (required && !v) fail('config_missing', 'Missing script property: ' + name);
  return v;
}

function setProp(name, value) {
  REQ.props[name] = value;
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

/**
 * Answer key for instant feedback on the phone. KEEP IN SYNC with js/answers.js.
 * A short FNV-1a hash of session id, question and the correct option: the phone can
 * check a choice without the answer being written out in plain sight. It hides the
 * answer from a child, not from someone who knows programming.
 */
function answerKey(sessId, qref, answer) {
  var str = sessId + '|' + qref + '|' + answer;
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}
