// api.js — every call to the Google Apps Script server goes through here.

import { VERSION, SCRIPT_URL, NEW_SERVER_URL, DEFAULT_SERVER, API_TIMEOUT_MS, API_TIMEOUT_STORY_MS } from './config.js';
import { log } from './debug.js';
import { reportError } from './report.js';

// The child's code comes from the personal link once, and is remembered, so the
// installed app (which always starts without it) still knows who is reading.
const CODE_KEY = 'reading_code';
const code = (() => {
  const fromLink = new URLSearchParams(location.search).get('k');
  try {
    if (fromLink) {
      localStorage.setItem(CODE_KEY, fromLink);
      // Saved: take it out of the address bar, so it is not on screen or in a shared link.
      const url = new URL(location.href);
      url.searchParams.delete('k');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    return fromLink || localStorage.getItem(CODE_KEY) || '';
  } catch {
    return fromLink || '';
  }
})();

// Which server this phone talks to: ?server=new / ?server=old in the link switches it, and
// it is remembered. Without the new server's address, it is always the old one.
const SERVER_KEY = 'reading_server';
export const serverName = (() => {
  const asked = new URLSearchParams(location.search).get('server');
  let chosen = DEFAULT_SERVER;
  try {
    if (asked === 'new' || asked === 'old') {
      localStorage.setItem(SERVER_KEY, asked);
      const url = new URL(location.href);
      url.searchParams.delete('server');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    chosen = asked || localStorage.getItem(SERVER_KEY) || DEFAULT_SERVER;
  } catch {
    chosen = asked || DEFAULT_SERVER;
  }
  return chosen === 'new' && NEW_SERVER_URL ? 'new' : 'old';
})();
const serverUrl = serverName === 'new' ? NEW_SERVER_URL : SCRIPT_URL;

export class ApiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// Server clock minus phone clock. Each answer carries the server's time, but Google can hold
// a request for many seconds before or after the script runs, so a single answer can be off
// by half its round trip. Only the quickest answer seen (smallest possible error) is used;
// after 10 minutes a new one may replace it.
let clockOffset = 0;
let bestRtt = Infinity;
let bestAt = 0;

/** Server time in ms (phone clocks can be off; the time window is measured on the server). */
export function serverNow() {
  return Date.now() + clockOffset;
}

export function hasCode() {
  return !!code;
}

/**
 * Sends {action, k, ...payload}. text/plain keeps the browser from a CORS
 * pre-flight request, which Apps Script does not answer.
 */
// Safe to send twice: the server recognises a repeat (attemptId, first answer wins) or only reads.
const RETRY_SAFE = new Set(['init', 'speechToken', 'startPage', 'submitPage', 'answer', 'finish']);
// Worth one more try: no answer, Google's own error page instead of ours, or the lock was busy.
const RETRY_ON = new Set(['timeout', 'network', 'server_html', 'busy', 'wrong_answer']);
const RETRY_DELAY_MS = 1500;

// Calls that change the day's progress go out one at a time, in the order they were made
// (a reading is saved before the next page starts, even when saving runs in the background).
const IN_ORDER = new Set(['startPage', 'submitPage', 'answer', 'practice', 'finish']);
let queue = Promise.resolve();

/*
 * The outbox: every such call is also written on the phone until the server has it.
 * If the app is closed while Google is slow and calls are still waiting, nothing is lost:
 * the next time the app opens, they are sent first, in the same order (sendOutbox).
 * All of them are safe to send twice (attemptId, first answer wins, repeatable finish).
 */
const OUTBOX_KEY = 'reading_outbox';

function outboxLoad() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
}
function outboxStore(box) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(box)); } catch { /* private mode: in memory only */ }
}
function outboxAdd(action, payload) {
  const box = outboxLoad();
  const body = JSON.stringify(payload);
  const same = box.find((it) => it.k === code && it.srv === serverName && it.action === action && JSON.stringify(it.payload) === body);
  if (same) return same.id; // a retry of the same call: kept once
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  box.push({ id, k: code, srv: serverName, action, payload });
  outboxStore(box);
  return id;
}
function outboxDone(id) {
  outboxStore(outboxLoad().filter((it) => it.id !== id));
}

export function outboxSize() {
  return outboxLoad().filter((it) => it.k === code && (it.srv || 'old') === serverName).length;
}

// A page's start alone is not kept: if its reading is in the outbox, the start is sent again with it.
const KEPT = new Set(['submitPage', 'answer', 'practice', 'finish']);

export function call(action, payload = {}) {
  if (!IN_ORDER.has(action)) return callWithRetry(action, payload);
  const id = KEPT.has(action) ? outboxAdd(action, payload) : null;
  const p = queue.then(() => callWithRetry(action, payload)).then(
    (res) => { if (id) outboxDone(id); return res; },
    (e) => { if (id && !RETRY_ON.has(e.code)) outboxDone(id); throw e; } // a clear answer from the server ends it too
  );
  queue = p.catch(() => {});
  return p;
}

/**
 * Sends what an earlier visit left in the outbox, in order. Stops at the first call that
 * still cannot get through (kept for next time). onProgress(done, total) for the screen.
 */
export async function sendOutbox(onProgress) {
  const mine = outboxLoad().filter((it) => it.k === code && (it.srv || 'old') === serverName);
  outboxStore(outboxLoad().filter((it) => it.k === code)); // calls of another child's code are dropped
  for (let n = 0; n < mine.length; n++) {
    const it = mine[n];
    onProgress?.(n, mine.length);
    try {
      try {
        await callWithRetry(it.action, it.payload);
      } catch (e) {
        if (it.action !== 'submitPage' || e.code !== 'page_not_started') throw e;
        // The page's start never reached the server either: start it, then save the reading.
        await callWithRetry('startPage', { page: it.payload.page, extra: it.payload.extra });
        await callWithRetry(it.action, it.payload);
      }
      log('api', `outbox: ${it.action} sent`);
    } catch (e) {
      if (RETRY_ON.has(e.code)) { log('api', `outbox: ${it.action} still not through, kept`); return false; }
      log('api', `outbox: ${it.action} answered ${e.code}, dropped`); // already done, or no longer possible
    }
    outboxDone(it.id);
  }
  return true;
}

async function callWithRetry(action, payload) {
  try {
    return await callOnce(action, payload);
  } catch (e) {
    if (RETRY_SAFE.has(action) && RETRY_ON.has(e.code)) {
      log('api', `retry ${action} after ${e.code} in ${RETRY_DELAY_MS}ms`);
      // Reported even if the retry works: the parent's sheet should show every hiccup.
      reportError(action + ' (retried)', e);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return callOnce(action, payload);
    }
    throw e;
  }
}

let warnedVersion = false;

export async function callOnce(action, payload = {}) {
  if (!serverUrl || serverUrl.startsWith('PASTE')) throw new ApiError('not_configured', 'server address is not set');
  const timeout = action === 'newStory' ? API_TIMEOUT_STORY_MS : API_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const started = performance.now();
  const took = () => Math.round(performance.now() - started);
  log('api', '→ ' + action, action === 'submitPage' ? { page: payload.page, words: payload.words?.length }
    : action === 'clientError' ? { where: payload.where } : payload);
  let res;
  try {
    res = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, k: code, ...payload }),
      signal: ctrl.signal,
      redirect: 'follow'
    });
  } catch (e) {
    const kind = e.name === 'AbortError' ? 'timeout' : 'network';
    const detail = `${String(e)} after ${took()}ms, online=${navigator.onLine}, visible=${document.visibilityState}`;
    log('api', `✗ ${action} ${kind}`, detail);
    throw new ApiError(kind, detail);
  } finally {
    clearTimeout(timer);
  }

  let text = '';
  try { text = await res.text(); } catch (e) {
    log('api', `✗ ${action} body lost after ${took()}ms`, String(e));
    throw new ApiError('network', 'body lost: ' + String(e));
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* not ours: see below */ }
  if (!json || typeof json !== 'object') {
    // Google answered with its own page (an HTML error) instead of our script's answer.
    const title = (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    const body = text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    const detail = `HTTP ${res.status} ${res.headers.get('content-type') || ''}, ${took()}ms, ` +
      `from ${String(res.url).split('?')[0]}, title "${title}", text "${body}"`;
    log('api', `✗ ${action} not JSON`, detail);
    throw new ApiError('server_html', detail);
  }

  const ms = took();
  // Google sometimes returns the answer to an empty request (a ping) instead of ours.
  if (json.a && json.a !== action) {
    const detail = `asked ${action}, got the answer to ${json.a} after ${ms}ms: ${JSON.stringify(json.data || json.error).slice(0, 120)}`;
    log('api', `✗ ${action} wrong answer`, detail);
    throw new ApiError('wrong_answer', detail);
  }
  if (json.t && (ms < bestRtt || Date.now() - bestAt > 10 * 60000)) {
    clockOffset = Math.round(json.t - Date.now() + ms / 2);
    bestRtt = ms;
    bestAt = Date.now();
    log('api', `clock: server minus phone ${clockOffset}ms (±${Math.round(ms / 2)}ms)`);
  }
  const where = json.ms !== undefined ? `, script ${json.ms}ms, lock wait ${json.lockMs}ms` : '';
  if (!warnedVersion && json.v && json.v !== VERSION) {
    warnedVersion = true;
    log('api', `version mismatch: page ${VERSION}, script ${json.v}`);
  }
  if (!json.ok) {
    log('api', `✗ ${action} ${ms}ms (server ${json.v}${where})`, json.error);
    throw new ApiError(json.error?.code || 'server_error', json.error?.message);
  }
  log('api', `← ${action} ${ms}ms (server ${json.v}${where})`, redact(action, json.data));
  return json.data;
}

/** Tokens never go into the log (the log can be copied and sent). */
function redact(action, data) {
  if (action === 'speechToken') return '[token]';
  if (data && data.speech) return { ...data, speech: data.speech.token ? '[token]' : null };
  return data;
}
