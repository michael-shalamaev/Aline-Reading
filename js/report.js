// report.js — sends what went wrong on the phone to the parent's sheet (tab שגיאות),
// with the last log lines, so problems are visible even without the debug panel.
// A report that cannot be sent (no internet) waits on the phone and goes with the next one.

import { VERSION } from './config.js';
import { callOnce } from './api.js';
import { log, recentLog } from './debug.js';

const QUEUE_KEY = 'reading_error_reports';
const MAX_PER_LOAD = 20;
let sent = 0;
let sending = false;

function load() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function store(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-10))); } catch { /* private mode */ }
}

/** where: what the page was doing; err: the error; screen: what the child saw. */
export function reportError(where, err, screen = '') {
  const code = (err && err.code) || (err && err.name) || 'error';
  const message = String((err && err.message) || err || '').slice(0, 500);
  const item = {
    where,
    code,
    message,
    details: `v${VERSION}, screen ${screen || '-'}, at ${new Date().toLocaleTimeString('en-GB')}, ` +
      `online=${navigator.onLine}, visible=${document.visibilityState}\n` + recentLog(40)
  };
  const q = load();
  q.push(item);
  store(q);
  flushReports();
}

export async function flushReports() {
  if (sending) return;
  sending = true;
  try {
    let q = load();
    while (q.length && sent < MAX_PER_LOAD) {
      await callOnce('clientError', q[0]);
      sent++;
      q = load().slice(1);
      store(q);
    }
  } catch (e) {
    log('report', 'not sent yet, kept on the phone', String(e && e.code));
  } finally {
    sending = false;
  }
}
