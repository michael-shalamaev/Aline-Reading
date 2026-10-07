// worker-harness.mjs — runs the Cloudflare server (worker/src) in Node: D1 = real SQLite,
// the bridge = the real Apps Script code in its in-memory mock (so rows land in the same
// mock sheet), Gemini and Microsoft = the same fakes the Apps Script tests use.

import { makeD1 } from './d1-shim.mjs';
import { loadServer } from './gas-mock.mjs';
import { handle } from '../worker/src/router.js';
import { clock } from '../worker/src/util.js';
import { resetSchemaFlag } from '../worker/src/store.js';
import { flushReports, pendingReports } from '../worker/src/reports.js';

export const BRIDGE_URL = 'https://bridge.test/exec';
const SECRET = 'bridge-secret-for-tests';

export function loadWorker(options = {}) {
  const gas = loadServer(options);
  gas.ctx.setup();
  gas.props.set('BRIDGE_SECRET', SECRET);
  const code = gas.book().getSheetByName('הגדרות').rows().find((r) => r[0] === 'code')[2];
  const env = {
    DB: makeD1(),
    GEMINI_API_KEY: 'g-key',
    AZURE_SPEECH_KEY: 'a-key',
    AZURE_SPEECH_REGION: 'westeurope',
    BRIDGE_URL,
    BRIDGE_SECRET: options.wrongSecret ? 'wrong' : SECRET,
    RATE_LIMIT_PER_MINUTE: options.rateLimit ? String(options.rateLimit) : undefined
  };
  resetSchemaFlag();
  clock.now = () => gas.clock.now;
  const bridge = { down: false, calls: [] };
  const workerFetches = [];

  // The world the worker talks to.
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    workerFetches.push(url);
    if (url.startsWith(BRIDGE_URL)) {
      const body = JSON.parse(init.body);
      bridge.calls.push(body.action);
      if (bridge.down) return new Response('<!DOCTYPE html><title>Error</title>', { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response(JSON.stringify(gas.api(body)), { headers: { 'content-type': 'application/json' } });
    }
    // Gemini and Microsoft: the Apps Script mock's fakes, reused.
    const r = gas.ctx.UrlFetchApp.fetch(url, { payload: init.body });
    return new Response(r.getContentText(), { status: r.getResponseCode() });
  };

  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const api = async (req) => handle(JSON.parse(JSON.stringify(req)), env, ctx);
  const settle = async () => { while (waits.length) await waits.shift(); };
  return {
    gas, env, code, bridge, workerFetches, api,
    k: (req) => api({ k: code, ...req }),
    settle,
    flush: () => flushReports(env),
    pending: () => pendingReports(env),
    book: gas.book, mails: gas.mails, fetches: gas.fetches, clock: gas.clock,
    rows: (tab) => gas.book().getSheetByName(tab).rows()
  };
}
