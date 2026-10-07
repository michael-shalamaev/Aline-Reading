// bridge.js — talks to the existing Google Apps Script (server/Bridge.gs): settings from
// the sheet, and rows and mails for the parent. Never on the child's waiting path.

import { AppError } from './util.js';

const BRIDGE_TIMEOUT_MS = 60000;

export async function bridgeCall(env, action, body = {}) {
  if (!env.BRIDGE_URL || !env.BRIDGE_SECRET) throw new AppError('config_missing', 'BRIDGE_URL / BRIDGE_SECRET not set');
  let res;
  try {
    res = await fetch(env.BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, secret: env.BRIDGE_SECRET, ...body }),
      redirect: 'follow',
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS)
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
