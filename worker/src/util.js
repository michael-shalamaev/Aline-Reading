// util.js — shared helpers for the Cloudflare server. Mirrors server/Util.gs.

export const SERVER_VERSION = '2.0.2';
export const TIME_ZONE = 'Asia/Jerusalem';

/** The clock, replaceable in tests. */
export const clock = { now: () => Date.now() };

/** Error the router turns into a clean {ok:false} answer for the page. */
export class AppError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export function fail(code, message) {
  throw new AppError(code, message);
}

function parts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return p;
}

/** Today's date in Israel, as yyyy-MM-dd. */
export function todayStr() {
  const p = parts(clock.now());
  return `${p.year}-${p.month}-${p.day}`;
}

export function newId() {
  return crypto.randomUUID().slice(0, 8);
}

export function round1(x) {
  return Math.round(x * 10) / 10;
}

// Word tokenizer. KEEP IN SYNC with js/text.js and server/Util.gs (tests check all three).
const WORD_RE = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g;

export function tokenize(text) {
  return String(text || '').match(WORD_RE) || [];
}

export function normWord(w) {
  return String(w || '').toLowerCase().replace(/['’]/g, '');
}

/** Answer key for instant feedback on the phone. KEEP IN SYNC with js/answers.js. */
export function answerKey(sessId, qref, answer) {
  const str = `${sessId}|${qref}|${answer}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
