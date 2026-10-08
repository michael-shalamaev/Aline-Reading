// config.js — the only place with addresses and tuning numbers.

export const VERSION = '1.1.1';

// The Google Apps Script web app address (ends with /exec). Filled in during setup.
export const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxyzKHmLY0kweEtL40FlUtBQxuHbUz0KkN08DhkoM6_o35-WIkE-hhev2rcR9W1Cbmp/exec';

// The new server (Cloudflare).
export const NEW_SERVER_URL = 'https://aline-reading.m-shalamaev.workers.dev';

// Which server phones use unless told otherwise: 'old' (Apps Script) or 'new' (Cloudflare).
// A single phone can switch with ?server=new or ?server=old in its link (it is remembered).
export const DEFAULT_SERVER = 'new';

// Microsoft Speech SDK for browsers.
export const SPEECH_SDK_URLS = [
  'https://cdn.jsdelivr.net/npm/microsoft-cognitiveservices-speech-sdk@1.52.0/distrib/browser/microsoft.cognitiveservices.speech.sdk.bundle-min.js',
  'https://aka.ms/csspeech/jsbrowserpackageraw'
];

// A word Microsoft scored below this (0-100) counts as mispronounced, unless the
// parent set another value in the sheet (pronThreshold).
export const MISPRONOUNCED_BELOW = 55;

// Reading stops by itself this long after the last word was heard (ms).
export const AUTO_STOP_AFTER_LAST_WORD_MS = 1800;

// Safety stop for one page (ms).
export const MAX_PAGE_MS = 8 * 60 * 1000;

// Requests to the script give up after this long (ms). Story creation is slow.
export const API_TIMEOUT_MS = 60000;
export const API_TIMEOUT_STORY_MS = 90000;
