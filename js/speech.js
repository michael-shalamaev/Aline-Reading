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

/** A valid token, fetched again when less than 90 seconds are left. */
async function getToken() {
  if (token && token.expiresAt - Date.now() > 90000) return token;
  const t = await call('speechToken');
  token = { token: t.token, region: t.region, expiresAt: Date.now() + t.ttlSec * 1000 };
  log('speech', 'token ok, seconds left', t.ttlSec);
  return token;
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
 * for the live highlight. Returns {stop()} which resolves to all heard words.
 */
export async function startReading({ referenceText, lang, onProgress, onProblem }) {
  const SDK = await loadSdk();
  const t = await getToken();
  const audio = SDK.AudioConfig.fromDefaultMicrophoneInput();
  const rec = new SDK.SpeechRecognizer(makeConfig(SDK, t, lang), audio);
  paConfig(SDK, referenceText).applyTo(rec);

  const finals = [];
  let interim = [];
  const report = () => onProgress?.([...finals.map((f) => f.word), ...interim]);

  rec.recognizing = (_, e) => {
    interim = tokenize(e.result.text);
    report();
  };
  rec.recognized = (_, e) => {
    if (e.result.reason === SDK.ResultReason.RecognizedSpeech) {
      const words = wordsOf(SDK, e.result);
      finals.push(...words);
      log('speech', 'segment', words.map((w) => `${w.word}:${Math.round(w.acc)}`).join(' '));
    }
    interim = [];
    report();
  };
  rec.canceled = (_, e) => {
    log('speech', 'canceled', { reason: e.reason, code: e.errorCode, details: e.errorDetails });
    if (e.reason === SDK.CancellationReason.Error) onProblem?.(e.errorDetails || 'speech_error');
  };
  rec.sessionStarted = () => log('speech', 'session started');
  rec.sessionStopped = () => log('speech', 'session stopped');

  // Keep the token fresh for long pages.
  const refresher = setInterval(async () => {
    try {
      const fresh = await getToken();
      if (rec.authorizationToken !== fresh.token) {
        rec.authorizationToken = fresh.token;
        log('speech', 'token refreshed');
      }
    } catch (e) {
      log('speech', 'token refresh failed', String(e));
    }
  }, 60000);

  await new Promise((resolve, reject) => rec.startContinuousRecognitionAsync(resolve, (err) => {
    clearInterval(refresher);
    reject(new Error(String(err)));
  }));

  let stopped = null;
  return {
    stop() {
      if (!stopped) {
        stopped = new Promise((resolve) => {
          const done = () => { clearInterval(refresher); try { rec.close(); } catch { /* closed */ } resolve(finals); };
          rec.stopContinuousRecognitionAsync(done, (err) => { log('speech', 'stop error', String(err)); done(); });
        });
      }
      return stopped;
    }
  };
}

/** One word, said once: {ok, heard, acc}. Used in the practice after each page. */
export async function checkWord(word, lang) {
  const SDK = await loadSdk();
  const t = await getToken();
  const rec = new SDK.SpeechRecognizer(makeConfig(SDK, t, lang), SDK.AudioConfig.fromDefaultMicrophoneInput());
  paConfig(SDK, word).applyTo(rec);
  try {
    const result = await new Promise((resolve, reject) => rec.recognizeOnceAsync(resolve, reject));
    if (result.reason !== SDK.ResultReason.RecognizedSpeech) return { ok: false, heard: '', acc: 0 };
    const w = wordsOf(SDK, result)[0] || { word: '', acc: 0, err: 'None' };
    const ok = sameWord(normWord(word), normWord(w.word), /^[A-Z]/.test(word)) && w.err !== 'Mispronunciation' && w.acc >= MISPRONOUNCED_BELOW;
    log('speech', 'word check', { word, heard: w.word, acc: w.acc, ok });
    return { ok, heard: w.word, acc: w.acc };
  } finally {
    rec.close();
  }
}
