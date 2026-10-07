// index.js — the Cloudflare entry point. The page sends POST requests with a text/plain
// JSON body (no pre-flight request); every answer allows the page's address (CORS).
// The scheduled job (every few minutes) sends any rows and mails still waiting for Google.

import { handle } from './router.js';
import { ensureSchema } from './store.js';
import { flushReports } from './reports.js';
import { clock } from './util.js';

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(env, obj) {
  return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(env) } });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    let req = {};
    if (request.method === 'POST') {
      try { req = JSON.parse(await request.text() || '{}'); } catch { req = {}; }
    } else {
      req = Object.fromEntries(new URL(request.url).searchParams);
      if (req.k) delete req.k; // codes do not travel in addresses
    }
    return json(env, await handle(req, env, ctx));
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env.DB);
    ctx.waitUntil((async () => {
      for (let i = 0; i < 5; i++) {
        const r = await flushReports(env);
        if (!r.sent) break;
      }
      await env.DB.prepare('DELETE FROM kv WHERE until < ?').bind(clock.now() - 86400000).run();
    })());
  }
};
