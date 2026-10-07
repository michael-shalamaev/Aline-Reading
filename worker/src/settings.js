// settings.js — the children's settings come from the sheet (through the bridge).
// They are refreshed every 10 minutes in the background: a request never waits for Google,
// except the very first one ever. If the sheet cannot be reached, the last known settings stay.

import { fail, clock } from './util.js';
import { kvGet, kvPut } from './store.js';
import { bridgeCall } from './bridge.js';
import { report } from './reports.js';

export const SETTINGS_CACHE_SEC = 600;
const KEY = 'children';
const KEEP_SEC = 365 * 86400;
const FIRST_TIMEOUT_MS = 20000;

async function fetchChildren(env, timeoutMs) {
  const data = await bridgeCall(env, 'bridgeSettings', {}, timeoutMs);
  await kvPut(env.DB, KEY, { children: data.children, fresh: clock.now() + SETTINGS_CACHE_SEC * 1000 }, KEEP_SEC);
  if (data.sheetUrl) await kvPut(env.DB, 'sheetUrl', data.sheetUrl, KEEP_SEC);
  return data.children;
}

export async function readChildren(env, ctx) {
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
export function publicSettings(c) {
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
