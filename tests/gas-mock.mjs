// gas-mock.mjs — a small in-memory Google Apps Script, enough to run server/*.gs in Node.
// Spreadsheets, properties, cache, lock, mail and UrlFetch (Gemini + Microsoft) are faked.

import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

// Every call that costs a round trip to Google in real life is counted here, so tests can
// check how much work an action does (and how much of it happens while the lock is held).
// The milliseconds are rough real-world costs, measured from typical Apps Script runs.
export const COST_MS = { open: 400, read: 150, write: 200, append: 250, fetch: 600, cache: 25, lock: 50, mail: 600, meta: 60 };
let STATS = null;
function count(kind, extraMs = 0) {
  if (!STATS) return;
  STATS.calls[kind] = (STATS.calls[kind] || 0) + 1;
  const ms = COST_MS[kind] + extraMs;
  STATS.ms += ms;
  if (STATS.locked) STATS.lockedMs += ms;
}
// Reading a big range takes longer: about 100 ms more per 20,000 characters.
const sizeMs = (rows) => Math.round(rows.reduce((n, r) => n + r.reduce((m, x) => m + String(x).length, 0), 0) / 200);

class Range {
  constructor(sheet, row, col, rows = 1, cols = 1) { Object.assign(this, { sheet, row, col, rows, cols }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = [];
      for (let c = 0; c < this.cols; c++) line.push(this.sheet.cell(this.row + r, this.col + c));
      out.push(line);
    }
    count('read', sizeMs(out));
    return out;
  }
  getValue() { count('read'); return this.sheet.cell(this.row, this.col); }
  setValues(v) { count('write'); v.forEach((line, r) => line.forEach((x, c) => this.sheet.set(this.row + r, this.col + c, x))); return this; }
  setValue(x) { count('write'); this.sheet.set(this.row, this.col, x); return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
  setNumberFormat() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; this.hidden = false; }
  cell(r, c) { return (this.data[r - 1] || [])[c - 1] ?? ''; }
  set(r, c, x) {
    while (this.data.length < r) this.data.push([]);
    const row = this.data[r - 1];
    while (row.length < c) row.push('');
    // Like Sheets: a yyyy-MM-dd string becomes a Date.
    row[c - 1] = typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? new Date(x + 'T00:00:00+03:00') : x;
  }
  getName() { return this.name; }
  getLastRow() { count('meta'); return this.data.length; }
  getLastColumn() { return Math.max(0, ...this.data.map((r) => r.length)); }
  getRange(a, b, c, d) {
    if (typeof a === 'string') return new Range(this, 1, 1, Math.max(1, this.data.length), 1);
    return new Range(this, a, b, c || 1, d || 1);
  }
  getDataRange() { return new Range(this, 1, 1, Math.max(1, this.data.length), Math.max(1, this.getLastColumn())); }
  appendRow(row) { count('append'); const r = this.data.length + 1; row.forEach((x, i) => this.set(r, i + 1, x)); return this; }
  setFrozenRows() {} setFrozenColumns() {} setRightToLeft() {} setColumnWidth() {}
  hideSheet() { this.hidden = true; }
  rows() { return this.data; }
}

class Book {
  constructor(name) { this.name = name; this.id = 'sheet-' + randomUUID().slice(0, 6); this.sheets = [new Sheet('Sheet1')]; }
  getId() { return this.id; }
  getName() { return this.name; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSheetByName(n) { count('meta'); return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n, i) { const s = new Sheet(n); this.sheets.splice(i ?? this.sheets.length, 0, s); return s; }
  getSheets() { return this.sheets; }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
}

function fmtDate(d, tz, fmt) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(d)).map((p) => [p.type, p.value]));
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute);
}

/** A fake Gemini answer that follows the prompt's page count and length. */
function fakeStory(prompt, opts) {
  if (!/exactly (\d+) pages/.test(prompt)) return 'OK';
  const pages = Number(prompt.match(/exactly (\d+) pages/)[1]);
  const per = Number(prompt.match(/about (\d+) words each/)[1]);
  const base = 'Mia found a tiny dragon in the garden and it wanted to eat warm pizza with her friends';
  const words = base.split(' ');
  const mk = (k) => Array.from({ length: per }, (_, i) => words[(i + k) % words.length]).join(' ') + '.';
  const q = (a) => ({ q: 'What did Mia find?', options: ['A cat', 'A dragon', 'A dog', 'A fish'], answer: a });
  return {
    title: 'Mia and the Tiny Dragon',
    topicUsed: 'dragon',
    topicAdjusted: !!opts.adjust,
    pages: Array.from({ length: opts.wrongPages ? pages - 1 : pages }, (_, k) => ({
      text: mk(k), hardWords: ['dragon', 'garden', 'NotInText'], question: q(1)
    })),
    finalQuestions: [q(1), q(1), q(1)]
  };
}

export function loadServer(options = {}) {
  const props = new Map();
  const cache = new Map();
  const books = new Map();
  const mails = [];
  const fetches = [];
  const clock = { now: Date.parse('2026-10-06T15:00:00+03:00') };
  let geminiFailures = options.geminiFailures || 0;

  const ctx = {
    console: { log() {}, error() {} },
    Logger: { log() {} },
    __clock: clock,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => props.get(k) ?? null,
      setProperty: (k, v) => props.set(k, v)
    }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => {
        count('cache');
        const e = cache.get(k);
        if (!e) return null;
        if (e.until < clock.now) { cache.delete(k); return null; }
        return e.v;
      },
      put: (k, v, sec = 600) => { count('cache'); cache.set(k, { v, until: clock.now + sec * 1000 }); },
      remove: (k) => { count('cache'); cache.delete(k); }
    }) },
    LockService: { getScriptLock: () => ({
      waitLock() { count('lock'); if (STATS) STATS.locked = true; },
      tryLock() { if (options.lockBusy) return false; count('lock'); if (STATS) STATS.locked = true; return true; },
      releaseLock() { if (STATS) STATS.locked = false; }
    }) },
    SpreadsheetApp: {
      create: (n) => { const b = new Book(n); books.set(b.id, b); return b; },
      openById: (id) => { count('open'); return books.get(id); }
    },
    Utilities: { getUuid: () => randomUUID(), formatDate: fmtDate },
    Session: { getScriptTimeZone: () => 'Asia/Jerusalem', getEffectiveUser: () => ({ getEmail: () => 'dad@example.com' }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; } })
    },
    MailApp: { sendEmail: (m) => { count('mail'); mails.push(m); }, getRemainingDailyQuota: () => 100 },
    UrlFetchApp: {
      fetch(url, opts = {}) {
        count('fetch');
        fetches.push(url);
        const reply = (code, body) => ({
          getResponseCode: () => code,
          getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body))
        });
        if (url.includes('/models?')) {
          return reply(200, { models: [
            { name: 'models/gemini-3.7-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.8-flash-lite', supportedGenerationMethods: ['generateContent'] }
          ] });
        }
        if (url.includes(':generateContent')) {
          const model = url.match(/models\/([^:]+):/)[1];
          fetches.push('model:' + model);
          if ((options.busyModels || []).includes(model)) return reply(503, '{"error":{"status":"UNAVAILABLE"}}');
          if (geminiFailures > 0) { geminiFailures--; return reply(500, 'boom'); }
          const prompt = JSON.parse(opts.payload).contents[0].parts[0].text;
          const story = fakeStory(prompt, options);
          return reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(story) }] } }] });
        }
        if (url.includes('issueToken')) return reply(200, 'TOKEN-' + clock.now);
        return reply(404, 'unknown');
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext('Date.now = function () { return __clock.now; };', ctx);

  const dir = new URL('../server/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.gs')).sort().reverse()) {
    vm.runInContext(readFileSync(new URL(f, dir), 'utf8'), ctx, { filename: f });
  }

  props.set('GEMINI_API_KEY', 'g-key');
  props.set('AZURE_SPEECH_KEY', 'a-key');
  props.set('AZURE_SPEECH_REGION', 'westeurope');
  props.set('PAGE_URL', 'https://michael-shalamaev.github.io/Aline-Reading/');

  const api = (req) => JSON.parse(ctx.handle(req).content);
  /** Runs one request and reports what it cost: {res, calls, ms, lockedMs}. */
  const measure = (req) => {
    STATS = { calls: {}, ms: 0, lockedMs: 0, locked: false };
    try { return { res: api(req), ...STATS }; } finally { STATS = null; }
  };
  const book = () => books.get(props.get('SHEET_ID'));
  return { ctx, api, measure, props, cache, mails, fetches, clock, book, setNow: (iso) => { clock.now = Date.parse(iso); } };
}
