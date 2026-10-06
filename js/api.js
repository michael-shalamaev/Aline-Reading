// api.js — every call to the Google Apps Script server goes through here.

import { VERSION, SCRIPT_URL, API_TIMEOUT_MS, API_TIMEOUT_STORY_MS } from './config.js';
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

export class ApiError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

let clockOffset = 0;

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
const RETRY_ON = new Set(['timeout', 'network', 'server_html', 'busy']);
const RETRY_DELAY_MS = 1500;

// Calls that change the day's progress go out one at a time, in the order they were made
// (a reading is saved before the next page starts, even when saving runs in the background).
const IN_ORDER = new Set(['startPage', 'submitPage', 'answer', 'practice', 'finish']);
let queue = Promise.resolve();

export function call(action, payload = {}) {
  if (!IN_ORDER.has(action)) return callWithRetry(action, payload);
  const p = queue.then(() => callWithRetry(action, payload));
  queue = p.catch(() => {});
  return p;
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
  if (!SCRIPT_URL || SCRIPT_URL.startsWith('PASTE')) throw new ApiError('not_configured', 'SCRIPT_URL is not set');
  const timeout = action === 'newStory' ? API_TIMEOUT_STORY_MS : API_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const started = performance.now();
  const took = () => Math.round(performance.now() - started);
  log('api', '→ ' + action, action === 'submitPage' ? { page: payload.page, words: payload.words?.length }
    : action === 'clientError' ? { where: payload.where } : payload);
  let res;
  try {
    res = await fetch(SCRIPT_URL, {
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
  if (json.t) clockOffset = json.t - Date.now() + ms / 2;
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
