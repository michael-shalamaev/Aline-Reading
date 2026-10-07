// reports.js — rows and mails for the parent's sheet wait here (table "reports") and are
// handed to the Apps Script bridge in order, in the background. If Google does not answer,
// they are tried again later (with growing pauses), also by the every-few-minutes job.

import { clock } from './util.js';
import { bridgeCall } from './bridge.js';

const BATCH = 5;            // small, so a batch fits in the time Cloudflare gives after an answer
const SEND_TIMEOUT_MS = 25000;
const CLAIM_MS = 120000; // a batch being sent is not picked up by a second request meanwhile

export async function report(env, item) {
  await env.DB.prepare('INSERT INTO reports (item) VALUES (?)').bind(JSON.stringify({ ...item, at: clock.now() })).run();
}

/** Sends what is due. Returns {sent, failed}. Safe to call from any request (claims rows first). */
export async function flushReports(env) {
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

export async function pendingReports(env) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports').first();
  return r.n;
}
