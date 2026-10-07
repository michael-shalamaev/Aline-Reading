// store.js — everything kept in the database (Cloudflare D1, which is SQLite).
// Tables: sessions (one row per story, like the hidden stories tab), kv (small cached
// values with an expiry), reports (rows and mails waiting to be handed to the sheet).

import { clock, fail } from './util.js';

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
export async function ensureSchema(db) {
  if (!ready) {
    ready = db.batch(SCHEMA.map((sql) => db.prepare(sql))).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export function resetSchemaFlag() { ready = null; } // tests start new databases

/* ---------- kv: small values with an expiry ---------- */

export async function kvGet(db, k, { allowStale = false } = {}) {
  const row = await db.prepare('SELECT v, until FROM kv WHERE k = ?').bind(k).first();
  if (!row) return null;
  if (row.until < clock.now() && !allowStale) return null;
  return JSON.parse(row.v);
}

export async function kvPut(db, k, value, seconds) {
  await db.prepare('INSERT INTO kv (k, v, until) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, until = excluded.until')
    .bind(k, JSON.stringify(value), clock.now() + seconds * 1000).run();
}

export async function kvDelete(db, k) {
  await db.prepare('DELETE FROM kv WHERE k = ?').bind(k).run();
}

/* ---------- sessions ---------- */

function fromRow(r) {
  return { row: r.id, version: r.version, created: r.created, story: r.story ? JSON.parse(r.story) : null, state: JSON.parse(r.state) };
}

/** Today's session for a child; extra stories: the latest one (finished or not only if asked). */
export async function findSession(db, child, day, extra, includeFinished = false) {
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
export async function findOrCreateSession(db, child, day, extra, makeState) {
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
export async function saveSession(db, sess) {
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
export async function updateSession(db, load, step) {
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
