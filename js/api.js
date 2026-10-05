// api.js — every call to the Google Apps Script server goes through here.

import { SCRIPT_URL, API_TIMEOUT_MS, API_TIMEOUT_STORY_MS } from './config.js';
import { log } from './debug.js';

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
export async function call(action, payload = {}) {
  if (!SCRIPT_URL || SCRIPT_URL.startsWith('PASTE')) throw new ApiError('not_configured', 'SCRIPT_URL is not set');
  const timeout = action === 'newStory' ? API_TIMEOUT_STORY_MS : API_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const started = performance.now();
  log('api', '→ ' + action, action === 'submitPage' ? { page: payload.page, words: payload.words?.length } : payload);
  try {
    const res = await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, k: code, ...payload }),
      signal: ctrl.signal,
      redirect: 'follow'
    });
    const json = await res.json();
    const ms = Math.round(performance.now() - started);
    if (json.t) clockOffset = json.t - Date.now() + ms / 2;
    if (!json.ok) {
      log('api', `✗ ${action} ${ms}ms`, json.error);
      throw new ApiError(json.error?.code || 'server_error', json.error?.message);
    }
    log('api', `← ${action} ${ms}ms (server ${json.v})`, action === 'speechToken' ? '[token]' : json.data);
    return json.data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const net = e.name === 'AbortError' ? 'timeout' : 'network';
    log('api', `✗ ${action} ${net}`, String(e));
    throw new ApiError(net, String(e));
  } finally {
    clearTimeout(timer);
  }
}
