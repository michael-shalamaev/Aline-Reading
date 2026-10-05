/**
 * Auth.gs — identifies the child from the secret code in the link,
 * and applies a simple per-code request limit.
 */

var RATE_LIMIT_PER_MINUTE = 60;

function authChild(code) {
  if (!code) fail('unauthorized', 'Missing code');
  var children = readChildren();
  var child = null;
  for (var i = 0; i < children.length; i++) {
    if (children[i].code === String(code).trim()) { child = children[i]; break; }
  }
  if (!child) fail('unauthorized', 'Unknown code');
  if (!child.active) fail('inactive', 'This child is not active');
  rateLimit(child.code);
  return child;
}

function rateLimit(code) {
  var cache = CacheService.getScriptCache();
  var key = 'rl_' + code + '_' + Math.floor(Date.now() / 60000);
  var n = parseInt(cache.get(key) || '0', 10) + 1;
  cache.put(key, String(n), 120);
  if (n > RATE_LIMIT_PER_MINUTE) fail('rate_limited', 'Too many requests');
}
