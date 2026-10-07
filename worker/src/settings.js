// settings.js — the children's settings come from the sheet (through the bridge), and are
// kept here for 10 minutes. If the sheet cannot be reached, the last known settings are used.

import { fail, AppError } from './util.js';
import { kvGet, kvPut } from './store.js';
import { bridgeCall } from './bridge.js';
import { report } from './reports.js';

export const SETTINGS_CACHE_SEC = 600;
const KEY = 'children';

export async function readChildren(env) {
  const fresh = await kvGet(env.DB, KEY);
  if (fresh) return fresh;
  try {
    const data = await bridgeCall(env, 'bridgeSettings');
    await kvPut(env.DB, KEY, data.children, SETTINGS_CACHE_SEC);
    if (data.sheetUrl) await kvPut(env.DB, 'sheetUrl', data.sheetUrl, 365 * 86400);
    return data.children;
  } catch (e) {
    const stale = await kvGet(env.DB, KEY, { allowStale: true });
    if (stale) {
      await report(env, { kind: 'error', childId: '', action: 'settings (using the last known)', message: `${e.code}: ${e.message}` });
      return stale;
    }
    if (e instanceof AppError && e.code === 'bridge_unauthorized') fail('config_missing', 'Bridge secret does not match the script');
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
