// Built by tools/build-worker.mjs from worker/src — do not edit here; edit the sources.

// ---- util.js ----
const __util = (() => {
// util.js — shared helpers for the Cloudflare server. Mirrors server/Util.gs.

const SERVER_VERSION = '2.0.1';
const TIME_ZONE = 'Asia/Jerusalem';

/** The clock, replaceable in tests. */
const clock = { now: () => Date.now() };

/** Error the router turns into a clean {ok:false} answer for the page. */
class AppError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function fail(code, message) {
  throw new AppError(code, message);
}

function parts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return p;
}

/** Today's date in Israel, as yyyy-MM-dd. */
function todayStr() {
  const p = parts(clock.now());
  return `${p.year}-${p.month}-${p.day}`;
}

function newId() {
  return crypto.randomUUID().slice(0, 8);
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

// Word tokenizer. KEEP IN SYNC with js/text.js and server/Util.gs (tests check all three).
const WORD_RE = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g;

function tokenize(text) {
  return String(text || '').match(WORD_RE) || [];
}

function normWord(w) {
  return String(w || '').toLowerCase().replace(/['’]/g, '');
}

/** Answer key for instant feedback on the phone. KEEP IN SYNC with js/answers.js. */
function answerKey(sessId, qref, answer) {
  const str = `${sessId}|${qref}|${answer}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

return { SERVER_VERSION, TIME_ZONE, clock, AppError, fail, todayStr, newId, round1, tokenize, normWord, answerKey };
})();

// ---- store.js ----
const __store = (() => {
// store.js — everything kept in the database (Cloudflare D1, which is SQLite).
// Tables: sessions (one row per story, like the hidden stories tab), kv (small cached
// values with an expiry), reports (rows and mails waiting to be handed to the sheet).

const { clock, fail } = __util;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY, child TEXT NOT NULL, day TEXT NOT NULL, extra INTEGER NOT NULL,
     created INTEGER NOT NULL, story TEXT, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS sessions_by_day ON sessions (child, day, extra, created)',
  // One main story per child per day, even when two requests create it at the same moment.
  'CREATE UNIQUE INDEX IF NOT EXISTS one_main_per_day ON sessions (child, day) WHERE extra = 0',
  'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, until INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS reports (
     id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0,
     next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT)`
];

let ready = null;

/** Creates the tables on first use, so setting up needs no SQL from the parent. */
async function ensureSchema(db) {
  if (!ready) {
    ready = db.batch(SCHEMA.map((sql) => db.prepare(sql))).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

function resetSchemaFlag() { ready = null; } // tests start new databases

/* ---------- kv: small values with an expiry ---------- */

async function kvGet(db, k, { allowStale = false } = {}) {
  const row = await db.prepare('SELECT v, until FROM kv WHERE k = ?').bind(k).first();
  if (!row) return null;
  if (row.until < clock.now() && !allowStale) return null;
  return JSON.parse(row.v);
}

async function kvPut(db, k, value, seconds) {
  await db.prepare('INSERT INTO kv (k, v, until) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, until = excluded.until')
    .bind(k, JSON.stringify(value), clock.now() + seconds * 1000).run();
}

async function kvDelete(db, k) {
  await db.prepare('DELETE FROM kv WHERE k = ?').bind(k).run();
}

/* ---------- sessions ---------- */

function fromRow(r) {
  return { row: r.id, version: r.version, created: r.created, story: r.story ? JSON.parse(r.story) : null, state: JSON.parse(r.state) };
}

/** Today's session for a child; extra stories: the latest one (finished or not only if asked). */
async function findSession(db, child, day, extra, includeFinished = false) {
  const r = await db.prepare('SELECT * FROM sessions WHERE child = ? AND day = ? AND extra = ? ORDER BY created DESC, rowid DESC LIMIT 1')
    .bind(child.id, day, extra ? 1 : 0).first();
  if (!r) return null;
  const sess = fromRow(r);
  if (extra && sess.state.finished && !includeFinished) return null;
  return sess;
}

/**
 * Today's session, created if there is none. Two requests at the same moment get the same
 * row: the main story has a unique index, an extra one is only added if no unfinished one exists.
 */
async function findOrCreateSession(db, child, day, extra, makeState) {
  const found = await findSession(db, child, day, extra);
  if (found) return found;
  const state = makeState();
  const created = clock.now();
  if (extra) {
    await db.prepare(`INSERT INTO sessions (id, child, day, extra, created, story, state, version)
      SELECT ?, ?, ?, 1, ?, NULL, ?, 0 WHERE NOT EXISTS (
        SELECT 1 FROM sessions WHERE child = ? AND day = ? AND extra = 1 AND json_extract(state, '$.finished') = 0)`)
      .bind(state.id, child.id, day, created, JSON.stringify(state), child.id, day).run();
  } else {
    await db.prepare('INSERT OR IGNORE INTO sessions (id, child, day, extra, created, story, state, version) VALUES (?, ?, ?, 0, ?, NULL, ?, 0)')
      .bind(state.id, child.id, day, created, JSON.stringify(state)).run();
  }
  return findSession(db, child, day, extra);
}

/**
 * Saves only if nobody else saved this session since it was read (optimistic lock).
 * Returns false on a conflict: the caller reads again and repeats its step.
 */
async function saveSession(db, sess) {
  const res = await db.prepare('UPDATE sessions SET story = ?, state = ?, version = version + 1 WHERE id = ? AND version = ?')
    .bind(sess.story ? JSON.stringify(sess.story) : null, JSON.stringify(sess.state), sess.row, sess.version).run();
  if (!res.meta || res.meta.changes !== 1) return false;
  sess.version++;
  return true;
}

/**
 * Runs step(sess) on a fresh copy of the session and saves it if step set sess.dirty.
 * On a conflict with another request it reads again and repeats (a few times), so step
 * must only change sess: anything else (reports, mails) goes in sess.after, and runs once,
 * after the save succeeded.
 */
async function updateSession(db, load, step) {
  for (let i = 0; i < 4; i++) {
    const sess = await load();
    if (sess) sess.after = [];
    const out = await step(sess);
    if (sess && sess.dirty) {
      delete sess.dirty;
      if (!(await saveSession(db, sess))) continue;
    }
    if (sess) {
      for (const fn of sess.after) {
        try { await fn(); } catch (e) { console.error('after save', e); } // the state is saved; the rest still runs
      }
    }
    return out;
  }
  fail('busy', 'The session kept changing; try again');
}

return { ensureSchema, resetSchemaFlag, kvGet, kvPut, kvDelete, findSession, findOrCreateSession, saveSession, updateSession };
})();

// ---- bridge.js ----
const __bridge = (() => {
// bridge.js — talks to the existing Google Apps Script (server/Bridge.gs): settings from
// the sheet, and rows and mails for the parent. Rows and mails never keep the child waiting;
// settings only on the very first request (afterwards they are refreshed in the background).

const { AppError } = __util;
const BRIDGE_TIMEOUT_MS = 60000;

async function bridgeCall(env, action, body = {}, timeoutMs = BRIDGE_TIMEOUT_MS) {
  if (!env.BRIDGE_URL || !env.BRIDGE_SECRET) throw new AppError('config_missing', 'BRIDGE_URL / BRIDGE_SECRET not set');
  let res;
  try {
    res = await fetch(env.BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, secret: env.BRIDGE_SECRET, ...body }),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    throw new AppError('bridge_down', String(e));
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* Google's own error page */ }
  if (!json) throw new AppError('bridge_down', `HTTP ${res.status}: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`);
  if (json.a && json.a !== action) throw new AppError('bridge_down', `asked ${action}, got ${json.a}`);
  if (!json.ok) {
    const code = json.error && json.error.code === 'unauthorized' ? 'bridge_unauthorized' : 'bridge_error';
    throw new AppError(code, json.error && json.error.message);
  }
  return json.data;
}

return { bridgeCall };
})();

// ---- reports.js ----
const __reports = (() => {
// reports.js — rows and mails for the parent's sheet wait here (table "reports") and are
// handed to the Apps Script bridge in order, in the background. If Google does not answer,
// they are tried again later (with growing pauses), also by the every-few-minutes job.

const { clock } = __util;
const { bridgeCall } = __bridge;
const BATCH = 5;            // small, so a batch fits in the time Cloudflare gives after an answer
const SEND_TIMEOUT_MS = 25000;
const CLAIM_MS = 120000; // a batch being sent is not picked up by a second request meanwhile

async function report(env, item) {
  await env.DB.prepare('INSERT INTO reports (item) VALUES (?)').bind(JSON.stringify({ ...item, at: clock.now() })).run();
}

/** Sends what is due. Returns {sent, failed}. Safe to call from any request (claims rows first). */
async function flushReports(env) {
  const now = clock.now();
  const claimed = await env.DB.prepare(
    'UPDATE reports SET next_at = ? WHERE id IN (SELECT id FROM reports WHERE next_at <= ? ORDER BY id LIMIT ?) RETURNING id, item, tries'
  ).bind(now + CLAIM_MS, now, BATCH).all();
  const rows = (claimed.results || []).sort((a, b) => a.id - b.id);
  if (!rows.length) return { sent: 0, failed: 0 };
  const items = rows.map((r) => ({ ...JSON.parse(r.item), id: r.id }));
  try {
    await bridgeCall(env, 'bridgeReport', { items }, SEND_TIMEOUT_MS);
  } catch (e) {
    // Google did not take them: try again later, waiting longer each time (at most 30 minutes).
    const stmts = rows.map((r) => env.DB.prepare('UPDATE reports SET tries = tries + 1, next_at = ?, last_error = ? WHERE id = ?')
      .bind(now + Math.min(30 * 60000, 30000 * 2 ** r.tries), String(e.message).slice(0, 300), r.id));
    await env.DB.batch(stmts);
    return { sent: 0, failed: rows.length };
  }
  // Taken (an item that failed inside the script is recorded there, in the errors tab).
  await env.DB.batch(rows.map((r) => env.DB.prepare('DELETE FROM reports WHERE id = ?').bind(r.id)));
  return { sent: rows.length, failed: 0 };
}

async function pendingReports(env) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports').first();
  return r.n;
}

return { report, flushReports, pendingReports };
})();

// ---- settings.js ----
const __settings = (() => {
// settings.js — the children's settings come from the sheet (through the bridge).
// They are refreshed every 10 minutes in the background: a request never waits for Google,
// except the very first one ever. If the sheet cannot be reached, the last known settings stay.

const { fail, clock } = __util;
const { kvGet, kvPut } = __store;
const { bridgeCall } = __bridge;
const { report } = __reports;
const SETTINGS_CACHE_SEC = 600;
const KEY = 'children';
const KEEP_SEC = 365 * 86400;
const FIRST_TIMEOUT_MS = 20000;

async function fetchChildren(env, timeoutMs) {
  const data = await bridgeCall(env, 'bridgeSettings', {}, timeoutMs);
  await kvPut(env.DB, KEY, { children: data.children, fresh: clock.now() + SETTINGS_CACHE_SEC * 1000 }, KEEP_SEC);
  if (data.sheetUrl) await kvPut(env.DB, 'sheetUrl', data.sheetUrl, KEEP_SEC);
  return data.children;
}

async function readChildren(env, ctx) {
  const kept = await kvGet(env.DB, KEY);
  if (kept && kept.fresh > clock.now()) return kept.children;
  if (kept) {
    // Old but usable: answer with it now, refresh for the next request.
    await kvPut(env.DB, KEY, { ...kept, fresh: clock.now() + 60000 }, KEEP_SEC); // one refresh at a time
    const refresh = fetchChildren(env).catch((e) =>
      report(env, { kind: 'error', childId: '', action: 'settings refresh (the last known are used)', message: `${e.code}: ${e.message}` }));
    if (ctx && ctx.waitUntil) ctx.waitUntil(refresh); else await refresh;
    return kept.children;
  }
  try {
    return await fetchChildren(env, FIRST_TIMEOUT_MS);
  } catch (e) {
    if (e.code === 'bridge_unauthorized' || e.code === 'config_missing') fail('config_missing', 'The bridge to the sheet is not set up: ' + e.message);
    fail('settings_unavailable', 'Settings could not be read: ' + e.message);
  }
}

/** What the page is allowed to see of a child's settings. Mirrors server/Settings.gs. */
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

return { SETTINGS_CACHE_SEC, readChildren, publicSettings };
})();

// ---- auth.js ----
const __auth = (() => {
// auth.js — the child is known by the secret code in the link; a simple request limit.

const { fail, clock } = __util;
const { readChildren } = __settings;
const RATE_LIMIT_PER_MINUTE = 60;

async function authChild(env, code, ctx) {
  if (!code) fail('unauthorized', 'Missing code');
  const children = await readChildren(env, ctx);
  const child = children.find((c) => c.code === String(code).trim());
  if (!child) fail('unauthorized', 'Unknown code');
  if (!child.active) fail('inactive', 'This child is not active');
  await rateLimit(env, child.code);
  return child;
}

async function rateLimit(env, code) {
  const key = 'rl_' + code + '_' + Math.floor(clock.now() / 60000);
  const row = await env.DB.prepare(
    "INSERT INTO kv (k, v, until) VALUES (?, '1', ?) ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT) RETURNING v"
  ).bind(key, clock.now() + 120000).first();
  if (Number(row.v) > (Number(env.RATE_LIMIT_PER_MINUTE) || RATE_LIMIT_PER_MINUTE)) fail('rate_limited', 'Too many requests');
}

return { authChild };
})();

// ---- stories.js ----
const __stories = (() => {
// stories.js — asks Gemini for a story split into pages, with hard words and questions,
// and checks the answer before it is used. Mirrors server/Stories.gs.

const { fail, tokenize, normWord, answerKey, clock } = __util;
const { kvGet, kvPut, kvDelete } = __store;
const { report } = __reports;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const LEVEL_GUIDE = {
  'מתחילים': 'CEFR A1: very short sentences (5-8 words), present simple and past simple only, the 500 most common English words.',
  'בינוני': 'CEFR A2: short sentences (6-12 words), simple tenses, everyday vocabulary, a few new words that the story makes clear.',
  'מתקדם': 'CEFR B1: sentences up to 16 words, varied tenses, richer vocabulary.'
};

const versionOf = (name) => { const m = name.match(/gemini-([\d.]+)-/); return m ? parseFloat(m[1]) : 0; };

/** Newest two Flash models, then one Flash-Lite; GEMINI_MODEL first if set. Cached 6 hours. */
async function geminiModels(env) {
  let list = await kvGet(env.DB, 'gemini_models');
  if (!list) {
    const res = await fetch(GEMINI_BASE + '/models?pageSize=200', { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
    if (res.status !== 200) fail('gemini_error', 'List models failed: ' + (await res.text()).slice(0, 300));
    const names = ((await res.json()).models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace('models/', ''));
    const byVersion = (a, b) => versionOf(b) - versionOf(a);
    const flash = names.filter((n) => /^gemini-[\d.]+-flash$/.test(n)).sort(byVersion);
    const lite = names.filter((n) => /^gemini-[\d.]+-flash-lite$/.test(n)).sort(byVersion);
    list = flash.slice(0, 2).concat(lite.slice(0, 1));
    if (!list.length) fail('gemini_error', 'No Flash model available. Set GEMINI_MODEL.');
    await kvPut(env.DB, 'gemini_models', list, 21600);
  }
  const fixed = env.GEMINI_MODEL;
  if (fixed) list = [fixed].concat(list.filter((n) => n !== fixed));
  return list;
}

function storySchema() {
  const question = {
    type: 'OBJECT',
    properties: { q: { type: 'STRING' }, options: { type: 'ARRAY', items: { type: 'STRING' } }, answer: { type: 'INTEGER' } },
    required: ['q', 'options', 'answer']
  };
  return {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      topicUsed: { type: 'STRING' },
      topicAdjusted: { type: 'BOOLEAN' },
      pages: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { text: { type: 'STRING' }, hardWords: { type: 'ARRAY', items: { type: 'STRING' } }, question },
          required: ['text', 'hardWords', 'question']
        }
      },
      finalQuestions: { type: 'ARRAY', items: question }
    },
    required: ['title', 'topicUsed', 'topicAdjusted', 'pages', 'finalQuestions']
  };
}

function storyPrompt(child, topic, withQuestions) {
  const perPage = Math.round(child.words / child.pages);
  return [
    'Write an original, gentle and friendly children\'s story in English for a young learner of English as a second language.',
    'The reader will read it aloud, and speech recognition will check every word.',
    '',
    'Topic chosen by the reader (it may be written in Hebrew): "' + String(topic).slice(0, 120) + '".',
    'If the topic does not fit a gentle children\'s story, or names real brands or famous people, ',
    'write about a close, friendly version of it and set topicAdjusted to true.',
    '',
    'The story should suit readers about ' + child.age + ' years old: interests, characters and humor for that age.',
    'English level: ' + (LEVEL_GUIDE[child.level] || LEVEL_GUIDE['בינוני']),
    'Length: exactly ' + child.pages + ' pages, about ' + perPage + ' words each (total about ' + child.words + ' words).',
    'Split pages at natural points. Each page is one to three paragraphs separated by a blank line.',
    '',
    'Reading-aloud rules, very important:',
    '- Write numbers as words ("three", not "3").',
    '- No abbreviations, no symbols, no hyphenated words, no words in other languages.',
    '- Use common, easy-to-say English names for characters.',
    '- Dialogue is allowed, with plain double quotes.',
    '',
    'For each page: hardWords = 4 or 5 words from that page that may be hard to read, copied exactly as they appear.',
    withQuestions
      ? 'For each page: one simple multiple-choice question about that page, 4 options, answer = index 0-3 of the correct option. Vary the position of the correct answer.'
      : 'For each page: a question is still required by the format; make it simple.',
    'finalQuestions: exactly 3 multiple-choice questions about the whole story, 4 options each, answer = index 0-3.',
    'Questions and options are in simple English.',
    'The story should be warm, fun and have a clear ending.'
  ].join('\n');
}

/** Calls Gemini and returns a checked story. A bad story is retried once. */
async function generateStory(env, child, topic, withQuestions) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const story = await callGemini(env, storyPrompt(child, topic, withQuestions));
      return validateStory(story, child);
    } catch (e) {
      lastErr = e;
      await report(env, { kind: 'error', childId: child.id, action: 'generateStory#' + attempt, message: `${e.code || ''}: ${e.message}` });
      if (e.code === 'gemini_busy' || e.code === 'topic_blocked') break;
    }
  }
  throw lastErr;
}

const GEMINI_TRY_NEXT = new Set([404, 429, 500, 503]);

async function geminiRequest(env, model, prompt, lowThinking) {
  const config = { responseMimeType: 'application/json', responseSchema: storySchema(), temperature: 1 };
  if (lowThinking) config.thinkingConfig = { thinkingLevel: 'low' };
  return fetch(GEMINI_BASE + '/models/' + model + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: config })
  });
}

async function callGemini(env, prompt) {
  if (!env.GEMINI_API_KEY) fail('config_missing', 'GEMINI_API_KEY not set');
  const models = await geminiModels(env);
  const notes = [];
  for (const model of models) {
    const started = clock.now();
    let res = await geminiRequest(env, model, prompt, true);
    if (res.status === 400) res = await geminiRequest(env, model, prompt, false); // model rejects the thinking field
    const body = await res.text();
    if (res.status === 200) {
      const data = JSON.parse(body);
      const c0 = data.candidates && data.candidates[0];
      const blocked = (data.promptFeedback && data.promptFeedback.blockReason) ||
        (c0 && /SAFETY|PROHIBITED|BLOCKLIST/.test(c0.finishReason || '') && c0.finishReason);
      if (blocked) fail('topic_blocked', 'Gemini refused the topic: ' + blocked);
      const text = c0 && c0.content && c0.content.parts.map((p) => p.text || '').join('');
      if (!text) fail('gemini_error', model + ' gave an empty answer: ' + body.slice(0, 300));
      const story = JSON.parse(text);
      story._model = model;
      story._ms = clock.now() - started;
      return story;
    }
    notes.push(model + ' ' + res.status);
    if (res.status === 404) await kvDelete(env.DB, 'gemini_models');
    if (!GEMINI_TRY_NEXT.has(res.status)) fail('gemini_error', 'Gemini ' + res.status + ': ' + body.slice(0, 300));
  }
  fail('gemini_busy', 'All models busy: ' + notes.join(', '));
}

function validateQuestion(q, where) {
  if (!q || !q.q || !q.options || q.options.length !== 4) fail('bad_story', 'Bad question at ' + where);
  const a = parseInt(q.answer, 10);
  if (!(a >= 0 && a <= 3)) fail('bad_story', 'Bad answer index at ' + where);
  return { q: String(q.q), options: q.options.map(String), answer: a };
}

function validateStory(s, child) {
  if (!s || !s.pages || s.pages.length !== child.pages) {
    fail('bad_story', 'Expected ' + child.pages + ' pages, got ' + (s && s.pages ? s.pages.length : 0));
  }
  let total = 0;
  const pages = s.pages.map((p, i) => {
    const text = String(p.text || '').trim();
    const words = tokenize(text);
    if (words.length < 10) fail('bad_story', 'Page ' + (i + 1) + ' too short');
    total += words.length;
    const present = {};
    words.forEach((w) => { present[normWord(w)] = w; });
    const hard = (p.hardWords || [])
      .map((w) => present[normWord(w)])
      .filter((w, idx, arr) => w && arr.indexOf(w) === idx)
      .slice(0, 5);
    return { text, hardWords: hard, question: validateQuestion(p.question, 'page ' + (i + 1)) };
  });
  if (total < child.words * 0.6 || total > child.words * 1.5) fail('bad_story', 'Length ' + total + ' far from ' + child.words);
  if (!s.finalQuestions || s.finalQuestions.length < 3) fail('bad_story', 'Missing final questions');
  return {
    model: s._model || '',
    genMs: s._ms || 0,
    title: String(s.title || 'A Story'),
    topicUsed: String(s.topicUsed || ''),
    topicAdjusted: !!s.topicAdjusted,
    wordCount: total,
    pages,
    finalQuestions: s.finalQuestions.slice(0, 3).map((q, i) => validateQuestion(q, 'final ' + (i + 1)))
  };
}

/** The story as the phone sees it: questions carry an answer key, never the answer. */
function publicStory(story, sessId) {
  if (!story) return null;
  return {
    title: story.title,
    wordCount: story.wordCount,
    pages: story.pages.map((p, i) => ({
      text: p.text,
      hardWords: p.hardWords,
      question: { q: p.question.q, options: p.question.options, key: answerKey(sessId, 'p' + i, p.question.answer) }
    })),
    finalQuestions: story.finalQuestions.map((q, f) => ({ q: q.q, options: q.options, key: answerKey(sessId, 'f' + f, q.answer) }))
  };
}

return { geminiModels, storyPrompt, generateStory, validateStory, publicStory };
})();

// ---- speech.js ----
const __speech = (() => {
// speech.js — a short-lived Microsoft Speech token. The key never leaves this server.

const { fail, clock } = __util;
const { kvGet, kvPut } = __store;
const TOKEN_LIFE_SEC = 600;
const TOKEN_REUSE_SEC = 300;

async function issueSpeechToken(env) {
  const region = env.AZURE_SPEECH_REGION;
  if (!region || !env.AZURE_SPEECH_KEY) fail('config_missing', 'AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not set');
  const hit = await kvGet(env.DB, 'speech_token');
  if (hit) return { token: hit.token, region, ttlSec: TOKEN_LIFE_SEC - Math.floor((clock.now() - hit.at) / 1000) };
  const res = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY },
    body: ''
  });
  const text = await res.text();
  if (res.status !== 200) fail('speech_token_error', `Microsoft ${res.status}: ${text.slice(0, 200)}`);
  await kvPut(env.DB, 'speech_token', { token: text, at: clock.now() }, TOKEN_REUSE_SEC);
  return { token: text, region, ttlSec: TOKEN_LIFE_SEC };
}

return { issueSpeechToken };
})();

// ---- scoring.js ----
const __scoring = (() => {
// scoring.js — counting, pass rules and the best attempt. Mirrors server/Scoring.gs.

const { tokenize, round1, fail, clock } = __util;
const WORD_STATUS = { ok: 1, om: 1, sub: 1, mis: 1, hint: 1 };
const MAX_ATTEMPTS = 2;

function scoreAttempt(pageText, payload, durSec) {
  const ref = tokenize(pageText);
  const statuses = payload.words || [];
  if (statuses.length !== ref.length) fail('bad_payload', `Expected ${ref.length} word results, got ${statuses.length}`);
  const count = { ok: 0, om: 0, sub: 0, mis: 0, hint: 0 };
  const errWords = [];
  const said = payload.said || {};
  statuses.forEach((st0, i) => {
    const st = WORD_STATUS[st0] ? st0 : 'om';
    count[st]++;
    if (st === 'sub') errWords.push({ w: ref[i], t: st, said: String(said[i] || '').slice(0, 40) });
    else if (st !== 'ok') errWords.push({ w: ref[i], t: st });
  });
  const ins = Math.max(0, Math.min(ref.length, parseInt(payload.insertions, 10) || 0));
  const n = ref.length;
  const errors = count.om + count.sub + count.mis + count.hint + ins;
  const minutes = Math.max(durSec, 1) / 60;
  return {
    at: clock.now(),
    n, ok: count.ok, om: count.om, sub: count.sub, mis: count.mis, hint: count.hint, ins,
    errors,
    acc: round1(Math.max(0, (n - errors) / n * 100)),
    durSec: Math.round(durSec),
    wpm: Math.round((count.ok + count.mis + count.sub) / minutes),
    errWords,
    extraWords: (payload.extraWords || []).slice(0, 40).map((w) => String(w).slice(0, 30))
  };
}

function pageBelowBar(child, attempt, totalWords) {
  if (child.passByErrors) {
    const budget = Math.ceil(child.maxErrors * attempt.n / Math.max(totalWords, 1));
    return attempt.errors > budget;
  }
  return attempt.acc < child.passPercent;
}

function bestIndex(attempts) {
  let best = -1;
  attempts.forEach((a, i) => { if (best < 0 || a.acc > attempts[best].acc) best = i; });
  return best;
}

function summaryOfAttempt(a) {
  if (!a) return null;
  return { n: a.n, acc: a.acc, errors: a.errors, om: a.om, sub: a.sub || 0, mis: a.mis, hint: a.hint, ins: a.ins, wpm: a.wpm, durSec: a.durSec };
}

function finalResult(child, sess) {
  const s = sess.state;
  const t = { n: 0, errors: 0, om: 0, sub: 0, mis: 0, hint: 0, ins: 0, durSec: 0, attempts: 0 };
  const fastPages = [];
  s.pages.forEach((p, i) => {
    const a = p.attempts[p.best];
    t.n += a.n; t.errors += a.errors; t.om += a.om; t.sub += a.sub || 0; t.mis += a.mis;
    t.hint += a.hint; t.ins += a.ins; t.durSec += a.durSec;
    t.attempts += p.attempts.length;
    if (a.wpm > child.maxWpm) fastPages.push(i + 1);
  });
  const acc = round1(Math.max(0, (t.n - t.errors) / t.n * 100));
  const readingPassed = child.passByErrors ? t.errors <= child.maxErrors : acc >= child.passPercent;
  const withQuestions = !s.extra || child.extraQuestions;
  const answers = withQuestions ? s.pages.map((p) => p.answer).concat(s.finalAnswers) : [];
  const correct = answers.filter((a) => a && a.correct).length;
  const quizPct = answers.length ? Math.round(correct / answers.length * 100) : null;
  const quizPassed = !withQuestions || !child.quizBlocks || quizPct >= child.quizMinPercent;
  const flags = [];
  if (fastPages.length) flags.push('קצב מהיר מדי בעמודים ' + fastPages.join(', '));
  if (s.expiredCount) flags.push('חלון הזמן פג ' + s.expiredCount + ' פעמים קודם');
  if (sess.story.topicAdjusted) flags.push('הנושא שונה כי לא התאים לגיל');
  return {
    passed: readingPassed && quizPassed, readingPassed, quizPassed,
    acc, words: t.n, errors: t.errors, om: t.om, sub: t.sub, mis: t.mis, hint: t.hint, ins: t.ins,
    attempts: t.attempts,
    minutes: round1((clock.now() - s.startedAt) / 60000),
    readMinutes: round1(t.durSec / 60),
    wpm: Math.round((t.n - t.om) / Math.max(t.durSec / 60, 0.1)),
    quizCorrect: correct, quizTotal: answers.length, quizPct, flags
  };
}

return { MAX_ATTEMPTS, scoreAttempt, pageBelowBar, bestIndex, summaryOfAttempt, finalResult };
})();

// ---- sessions.js ----
const __sessions = (() => {
// sessions.js — one reading session per child per day (plus extra stories): the state,
// the time window, and what the phone may see. Mirrors server/Sessions.gs.

const { newId, todayStr, clock } = __util;
const { summaryOfAttempt } = __scoring;
const { publicStory } = __stories;
const { report } = __reports;
function blankState(child, extra) {
  return {
    id: newId(), child: child.id, date: todayStr(), extra: !!extra,
    regenUsed: 0, topics: [], startedAt: null, pageStartedAt: {}, pages: [],
    finalAnswers: [null, null, null], finished: false, result: null, expiredCount: 0
  };
}

function resetProgress(state, pageCount) {
  state.startedAt = null;
  state.pageStartedAt = {};
  state.pages = [];
  for (let i = 0; i < pageCount; i++) state.pages.push({ attempts: [], best: -1, answer: null });
  state.finalAnswers = [null, null, null];
}

/** The time window ran out before the story was finished: progress starts over (and the parent hears). */
function checkWindow(env, sess, child) {
  const s = sess.state;
  if (!s.startedAt || s.finished || !sess.story) return false;
  if (clock.now() - s.startedAt <= child.windowMinutes * 60000) return false;
  const pagesDone = s.pages.filter((p) => p.best >= 0).length;
  const snapshot = JSON.parse(JSON.stringify({ state: s, story: { title: sess.story.title } }));
  sess.after.push(() => report(env, { kind: 'expired', childId: child.id, sess: snapshot, pagesDone }));
  s.expiredCount++;
  resetProgress(s, sess.story.pages.length);
  sess.dirty = true;
  return true;
}

function publicSession(sess, child) {
  if (!sess) return null;
  const s = sess.state;
  return {
    id: s.id,
    extra: s.extra,
    questions: !s.extra || child.extraQuestions,
    story: publicStory(sess.story, s.id),
    regenLeft: Math.max(0, child.regenPerDay - s.regenUsed),
    locked: !!s.startedAt,
    startedAt: s.startedAt,
    windowMinutes: child.windowMinutes,
    expiredCount: s.expiredCount,
    pages: s.pages.map((p) => ({
      attempts: p.attempts.length,
      best: p.best >= 0 ? summaryOfAttempt(p.attempts[p.best]) : null,
      answered: p.answer ? { choice: p.answer.choice, correct: p.answer.correct } : null
    })),
    finalAnswers: s.finalAnswers.map((a) => (a ? { choice: a.choice, correct: a.correct } : null)),
    finished: s.finished,
    result: s.result
  };
}

return { blankState, resetProgress, checkWindow, publicSession };
})();

// ---- router.js ----
const __router = (() => {
// router.js — one action per request, same actions and answers as server/Router.gs, so the
// page works with either server. Every answer: {ok, a, v, t, ms, lockMs, data | error}.

const { SERVER_VERSION, AppError, fail, clock, todayStr } = __util;
const { ensureSchema, findSession, findOrCreateSession, updateSession } = __store;
const { authChild } = __auth;
const { publicSettings } = __settings;
const { generateStory } = __stories;
const { issueSpeechToken } = __speech;
const { scoreAttempt, pageBelowBar, bestIndex, summaryOfAttempt, finalResult, MAX_ATTEMPTS } = __scoring;
const { blankState, resetProgress, checkWindow, publicSession } = __sessions;
const { report, flushReports } = __reports;
const ACTIONS = {
  ping: actPing, init: actInit, newStory: actNewStory, startPage: actStartPage, speechToken: actSpeechToken,
  submitPage: actSubmitPage, answer: actAnswer, practice: actPractice, finish: actFinish, clientError: actClientError
};

// Expected refusals (page_not_allowed, too_early...) are not errors; these are.
const LOGGED_ERRORS = new Set(['gemini_error', 'topic_blocked', 'speech_token_error', 'bad_story', 'busy', 'config_missing', 'settings_unavailable']);

/** ctx.waitUntil lets work go on after the answer was sent (reports to the sheet). */
async function handle(req, env, ctx) {
  const t0 = clock.now();
  const action = req.action || 'ping';
  let childId = '';
  let out;
  try {
    await ensureSchema(env.DB);
    const fn = ACTIONS[action];
    if (!fn) fail('unknown_action', action);
    const child = action === 'ping' ? null : await authChild(env, req.k, ctx);
    childId = child ? child.id : '';
    const data = await fn(env, child, req);
    out = { ok: true, a: action, v: SERVER_VERSION, t: clock.now(), ms: clock.now() - t0, lockMs: 0, data };
  } catch (e) {
    const known = e instanceof AppError;
    if (!known || LOGGED_ERRORS.has(e.code)) {
      try {
        await report(env, { kind: 'error', childId, action, message: `${known ? e.code + ': ' : ''}${e.message}`, details: known ? '' : String(e.stack || '').slice(0, 1000) });
      } catch { /* the database itself failed; nothing more to do */ }
    }
    out = {
      ok: false, a: action, v: SERVER_VERSION, t: clock.now(), ms: clock.now() - t0, lockMs: 0,
      error: { code: known ? e.code : 'server_error', message: e.message || String(e) }
    };
  }
  // Rows and mails for the parent go out after the answer, without the child waiting.
  if (ctx && ctx.waitUntil) ctx.waitUntil(flushReports(env).catch(() => {}));
  return out;
}

/* ---------- helpers ---------- */

const loader = (env, child, extra, includeFinished = false) => () => findSession(env.DB, child, todayStr(), !!extra, includeFinished);

function loadActive(sess) {
  if (!sess || !sess.story) fail('no_story', 'No story yet');
  if (sess.state.finished) fail('finished', 'This story is finished');
  return sess;
}

function pageIndex(sess, req) {
  const i = parseInt(req.page, 10);
  if (!(i >= 0 && i < sess.state.pages.length)) fail('bad_payload', 'Bad page');
  return i;
}

function allowedToRead(child, sess, i) {
  const pages = sess.state.pages;
  let next = -1;
  for (let j = 0; j < pages.length; j++) { if (pages[j].best < 0) { next = j; break; } }
  if (i === next) return true;
  const p = pages[i];
  const lastDone = next < 0 ? pages.length - 1 : next - 1;
  return i === lastDone && p.attempts.length === 1 && pageBelowBar(child, p.attempts[0], sess.story.wordCount);
}

function storyComplete(child, sess) {
  const s = sess.state;
  if (s.finished || s.pages.some((p) => p.best < 0)) return false;
  if (s.extra && !child.extraQuestions) return true;
  return !s.pages.some((p) => !p.answer) && !s.finalAnswers.some((a) => !a);
}

/** Sums the story up; the parent's log row, hard words and mail follow in the background. */
function closeStory(env, child, sess) {
  const s = sess.state;
  const r = finalResult(child, sess);
  s.result = r;
  s.finished = true;
  s.finishedAt = clock.now();
  sess.dirty = true;
  const snapshot = JSON.parse(JSON.stringify({ state: s, story: { title: sess.story.title } }));
  sess.after.push(() => report(env, { kind: 'session', childId: child.id, sess: snapshot, result: r }));
  return r;
}

/* ---------- actions ---------- */

async function actPing() {
  return { version: SERVER_VERSION, time: new Date(clock.now()).toISOString() };
}

async function actInit(env, child) {
  const main = await updateSession(env.DB, loader(env, child, false), async (sess) => {
    if (sess) checkWindow(env, sess, child);
    return sess;
  });
  let extra = null;
  // Another story is offered after today's story is done, whatever its result: reading more is the goal.
  if (main && main.state.finished && child.extraAllowed) {
    extra = await updateSession(env.DB, loader(env, child, true), async (sess) => {
      if (sess) checkWindow(env, sess, child);
      return sess;
    });
  }
  return {
    version: SERVER_VERSION,
    today: todayStr(),
    child: publicSettings(child),
    session: publicSession(main, child),
    extraSession: publicSession(extra, child),
    // Tells the page that another story is open even when today's did not pass (the old server says nothing).
    extraAfterAny: true
  };
}

async function requireExtraAllowed(env, child) {
  const main = await findSession(env.DB, child, todayStr(), false);
  if (!child.extraAllowed || !main || !main.state.finished) {
    fail('extra_not_allowed', 'Extra story is available after today\'s story');
  }
}

async function actNewStory(env, child, req) {
  const extra = !!req.extra;
  const topic = String(req.topic || '').trim().slice(0, 80);
  if (!topic) fail('bad_payload', 'Topic is empty');
  // Check before the slow call, so a locked story never costs a generation.
  if (extra) await requireExtraAllowed(env, child);
  const before = await findSession(env.DB, child, todayStr(), extra);
  if (before && before.state.startedAt) fail('locked', 'Reading already started');
  if (before && before.story && before.state.regenUsed >= child.regenPerDay) fail('no_regen_left', 'No more changes today');

  const story = await generateStory(env, child, topic, !extra || child.extraQuestions);

  const load = () => findOrCreateSession(env.DB, child, todayStr(), extra, () => blankState(child, extra));
  return updateSession(env.DB, load, async (sess) => {
    if (sess.state.startedAt) fail('locked', 'Reading already started');
    if (sess.story) sess.state.regenUsed++;
    sess.story = story;
    sess.state.topics.push(topic);
    resetProgress(sess.state, story.pages.length);
    sess.dirty = true;
    return publicSession(sess, child);
  });
}

async function actStartPage(env, child, req) {
  const out = await updateSession(env.DB, loader(env, child, req.extra), async (sess) => {
    loadActive(sess);
    if (checkWindow(env, sess, child)) return { expired: true, session: publicSession(sess, child) };
    const i = pageIndex(sess, req);
    if (!allowedToRead(child, sess, i)) fail('page_not_allowed', 'This page cannot be read now');
    if (!sess.state.startedAt) sess.state.startedAt = clock.now();
    sess.state.pageStartedAt[i] = clock.now();
    sess.dirty = true;
    return { expired: false, startedAt: sess.state.startedAt };
  });
  if (!out.expired) {
    out.speech = null;
    try { out.speech = await issueSpeechToken(env); } catch (e) {
      await report(env, { kind: 'error', childId: child.id, action: 'startPage token', message: `${e.code || e.name}: ${e.message}` });
    }
  }
  return out;
}

async function actSpeechToken(env) {
  return issueSpeechToken(env);
}

function submitAnswer(child, sess, i, a) {
  const p = sess.state.pages[i];
  const below = pageBelowBar(child, a, sess.story.wordCount);
  return {
    expired: false,
    attempt: summaryOfAttempt(a),
    errWords: a.errWords,
    below,
    canRetry: below && p.attempts.length < MAX_ATTEMPTS,
    best: summaryOfAttempt(p.attempts[p.best])
  };
}

async function actSubmitPage(env, child, req) {
  return updateSession(env.DB, loader(env, child, req.extra), async (sess) => {
    loadActive(sess);
    const i = pageIndex(sess, req);
    const p = sess.state.pages[i];
    // The phone may send the same reading twice (after a timeout): answer, don't count again.
    const id = String(req.attemptId || '');
    if (id) {
      const same = p.attempts.find((x) => x.id === id);
      if (same) return submitAnswer(child, sess, i, same);
    }
    if (checkWindow(env, sess, child)) return { expired: true, session: publicSession(sess, child) };
    const started = sess.state.pageStartedAt[i];
    if (!started) fail('page_not_started', 'Page was not started');
    const phoneSec = Number(req.durSec);
    const dur = phoneSec > 0 && phoneSec < 1800 ? phoneSec : (clock.now() - started) / 1000;
    const a = scoreAttempt(sess.story.pages[i].text, req, dur);
    a.id = id;
    p.attempts.push(a);
    p.best = bestIndex(p.attempts);
    delete sess.state.pageStartedAt[i];
    sess.dirty = true;
    const below = pageBelowBar(child, a, sess.story.wordCount);
    const attemptNo = p.attempts.length;
    sess.after.push(() => report(env, {
      kind: 'pageAttempt', childId: child.id, sess: { state: { id: sess.state.id } }, page: i, attemptNo, attempt: a, below
    }));
    const answer = submitAnswer(child, sess, i, a);
    // A story without questions is complete with its last page (unless that page may still be read again).
    if (!answer.canRetry && storyComplete(child, sess)) closeStory(env, child, sess);
    return answer;
  });
}

async function actAnswer(env, child, req) {
  return updateSession(env.DB, loader(env, child, req.extra), async (sess) => {
    loadActive(sess);
    const choice = parseInt(req.choice, 10);
    if (!(choice >= 0 && choice <= 3)) fail('bad_payload', 'Bad choice');
    let slot, q;
    if (req.kind === 'final') {
      const f = parseInt(req.index, 10);
      if (!(f >= 0 && f < 3)) fail('bad_payload', 'Bad question');
      if (sess.state.pages.some((p) => p.best < 0)) fail('too_early', 'Finish the pages first');
      q = sess.story.finalQuestions[f];
      if (!sess.state.finalAnswers[f]) { sess.state.finalAnswers[f] = { choice, correct: choice === q.answer }; sess.dirty = true; }
      slot = sess.state.finalAnswers[f];
    } else {
      const i = pageIndex(sess, req);
      const p = sess.state.pages[i];
      if (p.best < 0) fail('too_early', 'Read the page first');
      q = sess.story.pages[i].question;
      if (!p.answer) { p.answer = { choice, correct: choice === q.answer }; sess.dirty = true; }
      slot = p.answer;
    }
    // The last answer completes the story: it is summed up here, not depending on the phone.
    if (storyComplete(child, sess)) closeStory(env, child, sess);
    return { correct: slot.correct, choice: slot.choice, correctIndex: q.answer };
  });
}

async function actPractice(env, child, req) {
  const results = (req.results || []).slice(0, 30)
    .map((r) => ({ word: String(r.word || '').slice(0, 40), ok: !!r.ok }))
    .filter((r) => r.word);
  if (results.length) await report(env, { kind: 'practice', childId: child.id, results });
  return { saved: results.length };
}

async function actFinish(env, child, req) {
  return updateSession(env.DB, loader(env, child, req.extra, true), async (sess) => {
    // Summing up twice (the first answer got lost, or two at once) gives the same result again.
    if (sess && sess.story && sess.state.finished) {
      return { result: sess.state.result, extraAllowed: child.extraAllowed, again: true };
    }
    loadActive(sess);
    const s = sess.state;
    if (s.pages.some((p) => p.best < 0)) fail('too_early', 'Not all pages were read');
    if (!s.extra || child.extraQuestions) {
      // Every answer the phone has comes along, so one whose own save was lost is not asked again.
      const given = req.answers || {};
      s.pages.forEach((p, i) => {
        const c = parseInt((given.pages || [])[i], 10);
        if (!p.answer && c >= 0 && c <= 3) p.answer = { choice: c, correct: c === sess.story.pages[i].question.answer };
      });
      s.finalAnswers.forEach((a, f) => {
        const c = parseInt((given.final || [])[f], 10);
        if (!a && c >= 0 && c <= 3) s.finalAnswers[f] = { choice: c, correct: c === sess.story.finalQuestions[f].answer };
      });
      if (s.pages.some((p) => !p.answer) || s.finalAnswers.some((a) => !a)) fail('too_early', 'Not all questions were answered');
    }
    const r = closeStory(env, child, sess);
    return { result: r, extraAllowed: child.extraAllowed };
  });
}

async function actClientError(env, child, req) {
  const cut = (x, n) => String(x || '').slice(0, n);
  await report(env, {
    kind: 'error', childId: child.id, action: 'טלפון: ' + cut(req.where, 80),
    message: cut(req.code, 40) + ': ' + cut(req.message, 500), details: cut(req.details, 4000)
  });
  return { saved: true };
}

return { handle };
})();

// ---- index.js ----
// index.js — the Cloudflare entry point. The page sends POST requests with a text/plain
// JSON body (no pre-flight request); every answer allows the page's address (CORS).
// The scheduled job (every few minutes) sends any rows and mails still waiting for Google.

const { handle } = __router;
const { ensureSchema } = __store;
const { flushReports } = __reports;
const { clock } = __util;
function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(env, obj) {
  return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(env) } });
}

const __default = {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    let req = {};
    if (request.method === 'POST') {
      try { req = JSON.parse(await request.text() || '{}'); } catch { req = {}; }
    } else {
      req = Object.fromEntries(new URL(request.url).searchParams);
      if (req.k) delete req.k; // codes do not travel in addresses
    }
    return json(env, await handle(req, env, ctx));
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env.DB);
    ctx.waitUntil((async () => {
      for (let i = 0; i < 5; i++) {
        const r = await flushReports(env);
        if (!r.sent) break;
      }
      await env.DB.prepare('DELETE FROM kv WHERE until < ?').bind(clock.now() - 86400000).run();
    })());
  }
};

export default __default;
