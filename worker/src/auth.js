// auth.js — the child is known by the secret code in the link; a simple request limit.

import { fail, clock } from './util.js';
import { readChildren } from './settings.js';

const RATE_LIMIT_PER_MINUTE = 60;

export async function authChild(env, code) {
  if (!code) fail('unauthorized', 'Missing code');
  const children = await readChildren(env);
  const child = children.find((c) => c.code === String(code).trim());
  if (!child) fail('unauthorized', 'Unknown code');
  if (!child.active) fail('inactive', 'This child is not active');
  await rateLimit(env, child.code);
  return child;
}

async function rateLimit(env, code) {
  const key = 'rl_' + code + '_' + Math.floor(clock.now() / 60000);
  const row = await env.DB.prepare(
    "INSERT INTO kv (k, v, until) VALUES (?, '1', ?) ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT) RETURNING v"
  ).bind(key, clock.now() + 120000).first();
  if (Number(row.v) > (Number(env.RATE_LIMIT_PER_MINUTE) || RATE_LIMIT_PER_MINUTE)) fail('rate_limited', 'Too many requests');
}
