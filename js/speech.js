// speech.js — everything that talks to Microsoft: loading the SDK, the short-lived
// token (refreshed in the background), reading a page, and checking a single word.

import { SPEECH_SDK_URLS, MISPRONOUNCED_BELOW } from './config.js';
import { call } from './api.js';
import { tokenize, normWord, sameWord } from './text.js';
import { log } from './debug.js';

let sdkPromise = null;
let token = null; // {token, region, expiresAt}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

export function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      for (const url of SPEECH_SDK_URLS) {
        try {
          await loadScript(url);
          if (window.SpeechSDK) { log('speech', 'SDK loaded', url); return window.SpeechSDK; }
        } catch (e) {
          log('speech', 'SDK load failed', String(e));
        }
      }
      sdkPromise = null;
      throw new Error('speech_sdk_unavailable');
    })();
  }
  return sdkPromise;
}

/** A token that arrived with another answer (startPage), so no separate request is needed. */
export function setToken(t) {
  if (t && t.token) token = { token: t.token, region: t.region, expiresAt: Date.now() + t.ttlSec * 1000 };
}

/** Fetches a token in the background if the one we have will not last for a page. */
export function prefetchToken() {
  if (token && token.expiresAt - Date.now() > 4 * 60000) return;
  getToken().catch((e) => log('speech', 'token prefetch failed', String(e)));
}

/** A valid token, fetched again when less than 90 seconds are left. */
let tokenRequest = null;

async function getToken() {
  if (token && token.expiresAt - Date.now() > 90000) return token;
  // One request at a time: a prefetch already on its way is shared, not repeated.
  if (!tokenRequest) {
    tokenRequest = call('speechToken').then((t) => {
      token = { token: t.token, region: t.region, expiresAt: Date.now() + t.ttlSec * 1000 };
      log('speech', 'token ok, seconds left', t.ttlSec);
      return token;
    }).finally(() => { tokenRequest = null; });
  }
  return tokenRequest;
}

function makeConfig(SDK, t, lang) {
  const cfg = SDK.SpeechConfig.fromAuthorizationToken(t.token, t.region);
  cfg.speechRecognitionLanguage = lang;
  try {
    // Tolerate short pauses inside a sentence without cutting it.
    cfg.setProperty(SDK.PropertyId.Speech_SegmentationSilenceTimeoutMs, '1200');
  } catch { /* older SDK: default is fine */ }
  return cfg;
}

function paConfig(SDK, referenceText) {
  return SDK.PronunciationAssessmentConfig.fromJSON(JSON.stringify({
    referenceText,
    gradingSystem: 'HundredMark',
    granularity: 'Word',
    enableMiscue: false // not supported in continuous mode; we align ourselves (scoring.js)
  }));
}

/** Microsoft's JSON result → [{word, acc, err}] */
function wordsOf(SDK, result) {
  try {
    const json = JSON.parse(result.properties.getProperty(SDK.PropertyId.SpeechServiceResponse_JsonResult));
    const words = json.NBest?.[0]?.Words || [];
    return words.map((w) => {
      const pa = w.PronunciationAssessment || w;
      return { word: w.Word, acc: pa.AccuracyScore, err: pa.ErrorType || 'None' };
    });
  } catch (e) {
    log('speech', 'could not parse result', String(e));
    return tokenize(result.text).map((word) => ({ word, acc: 100, err: 'None' }));
  }
}

/**
 * Starts reading a page. onProgress(heardWordsSoFar) fires on every partial result,
 * for the live highlight. onSilence() fires when nothing was said for silenceMs: the
 * caller may then pause() — Microsoft bills by the time it listens — and resume() later,
 * on a fresh connection; what was heard before is kept. stop() resolves to all heard words.
 */
export async function startReading({ referenceText, lang, onProgress, onProblem, onSilence, silenceMs = 0 }) {
  const SDK = await loadSdk();
  const finals = [];
  let interim = [];
  let rec = null;        // the open connection, null while paused
  let lastSpeech = Date.now();
  let silenceTold = false;
  const report = () => onProgress?.([...finals.map((f) => f.word), ...interim]);

  async function open() {
    const t = await getToken();
    const r = new SDK.SpeechRecognizer(makeConfig(SDK, t, lang), SDK.AudioConfig.fromDefaultMicrophoneInput());
    paConfig(SDK, referenceText).applyTo(r);
    // Any speech heard, right or wrong (sounding a word out, trying again), counts as talking.
    r.recognizing = (_, e) => {
      lastSpeech = Date.now();
      interim = tokenize(e.result.text);
      report();
    };
    r.recognized = (_, e) => {
      if (e.result.reason === SDK.ResultReason.RecognizedSpeech) {
        lastSpeech = Date.now();
        const words = wordsOf(SDK, e.result);
        finals.push(...words);
        log('speech', 'segment', words.map((w) => `${w.word}:${Math.round(w.acc)}`).join(' '));
      }
      interim = [];
      report();
    };
    r.canceled = (_, e) => {
      log('speech', 'canceled', { reason: e.reason, code: e.errorCode, details: e.errorDetails });
      if (r === rec && e.reason === SDK.CancellationReason.Error) onProblem?.(e.errorDetails || 'speech_error');
    };
    r.sessionStarted = () => log('speech', 'session started');
    r.sessionStopped = () => log('speech', 'session stopped');
    rec = r;
    await new Promise((resolve, reject) => r.startContinuousRecognitionAsync(resolve, (err) => {
      rec = null;
      reject(new Error(String(err)));
    }));
    lastSpeech = Date.now();
    silenceTold = false;
  }

  function close() {
    const r = rec;
    if (!r) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { if (rec === r) rec = null; try { r.close(); } catch { /* closed */ } interim = []; resolve(); };
      r.stopContinuousRecognitionAsync(done, (err) => { log('speech', 'stop error', String(err)); done(); });
    });
  }

  // Keep the token fresh for long pages.
  const refresher = setInterval(async () => {
    try {
      const fresh = await getToken();
      if (rec && rec.authorizationToken !== fresh.token) {
        rec.authorizationToken = fresh.token;
        log('speech', 'token refreshed');
      }
    } catch (e) {
      log('speech', 'token refresh failed', String(e));
    }
  }, 60000);
  const watcher = silenceMs > 0 && onSilence ? setInterval(() => {
    if (rec && !silenceTold && Date.now() - lastSpeech >= silenceMs) {
      silenceTold = true;
      log('speech', 'silence', Date.now() - lastSpeech);
      onSilence();
    }
  }, Math.min(1000, silenceMs / 3)) : null;
  const quit = () => { clearInterval(refresher); clearInterval(watcher); };

  try {
    await open();
  } catch (e) {
    quit();
    throw e;
  }

  let stopped = null;
  return {
    /** Stops listening (and paying), keeping what was heard. */
    pause() { log('speech', 'paused'); return close(); },
    /** Listens again, on a new connection; throws if it cannot. */
    async resume() { if (!rec && !stopped) { await open(); log('speech', 'resumed'); } },
    stop() {
      if (!stopped) stopped = close().then(() => { quit(); return finals; });
      return stopped;
    }
  };
}

/** One word, said once: {ok, heard, acc}. Used in the practice after each page. */
export async function checkWord(word, lang, misBelow = MISPRONOUNCED_BELOW) {
  const SDK = await loadSdk();
  const t = await getToken();
  const rec = new SDK.SpeechRecognizer(makeConfig(SDK, t, lang), SDK.AudioConfig.fromDefaultMicrophoneInput());
  paConfig(SDK, word).applyTo(rec);
  try {
    const result = await new Promise((resolve, reject) => rec.recognizeOnceAsync(resolve, reject));
    if (result.reason !== SDK.ResultReason.RecognizedSpeech) return { ok: false, heard: '', acc: 0 };
    const w = wordsOf(SDK, result)[0] || { word: '', acc: 0, err: 'None' };
    const ok = sameWord(normWord(word), normWord(w.word), /^[A-Z]/.test(word)) && w.acc >= misBelow;
    log('speech', 'word check', { word, heard: w.word, acc: w.acc, ok });
    return { ok, heard: w.word, acc: w.acc };
  } finally {
    rec.close();
  }
}
