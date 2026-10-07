// d1-shim.mjs — Cloudflare D1's API on top of Node's built-in SQLite, for tests.
// Every call is asynchronous like the real one, so requests can interleave.

import { DatabaseSync } from 'node:sqlite';

const tick = () => new Promise((r) => setImmediate(r));

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.db, this.sql, params); }
  _exec() {
    const st = this.db.prepare(this.sql);
    if (/\bRETURNING\b/i.test(this.sql) || /^\s*SELECT/i.test(this.sql)) {
      const results = st.all(...this.params);
      return { results, meta: { changes: results.length } };
    }
    const r = st.run(...this.params);
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first(col) { await tick(); const row = this._exec().results[0] || null; return row && col ? row[col] : row; }
  async all() { await tick(); return this._exec(); }
  async run() { await tick(); return this._exec(); }
}

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      await tick();
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql) { await tick(); db.exec(sql); return { count: 1 }; }
  };
}
