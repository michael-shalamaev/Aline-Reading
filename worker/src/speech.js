// speech.js — a short-lived Microsoft Speech token. The key never leaves this server.

import { fail, clock } from './util.js';
import { kvGet, kvPut } from './store.js';

const TOKEN_LIFE_SEC = 600;
const TOKEN_REUSE_SEC = 300;

export async function issueSpeechToken(env) {
  const region = env.AZURE_SPEECH_REGION;
  if (!region || !env.AZURE_SPEECH_KEY) fail('config_missing', 'AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not set');
  const hit = await kvGet(env.DB, 'speech_token');
  if (hit) return { token: hit.token, region, ttlSec: TOKEN_LIFE_SEC - Math.floor((clock.now() - hit.at) / 1000) };
  const res = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY },
    body: ''
  });
  const text = await res.text();
  if (res.status !== 200) fail('speech_token_error', `Microsoft ${res.status}: ${text.slice(0, 200)}`);
  await kvPut(env.DB, 'speech_token', { token: text, at: clock.now() }, TOKEN_REUSE_SEC);
  return { token: text, region, ttlSec: TOKEN_LIFE_SEC };
}
