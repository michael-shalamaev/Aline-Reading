// tts.js — says a word out loud with the phone's built-in voice.

import { log } from './debug.js';

let voice = null;

function pickVoice(lang) {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang === lang && /google/i.test(v.name)) ||
    voices.find((v) => v.lang === lang) ||
    voices.find((v) => v.lang.startsWith('en')) || null;
}

export function ttsAvailable() {
  return 'speechSynthesis' in window;
}

export function speak(text, lang = 'en-US', rate = 0.8) {
  if (!ttsAvailable()) return Promise.resolve();
  if (!voice || voice.lang !== lang) voice = pickVoice(lang);
  speechSynthesis.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = rate;
    if (voice) u.voice = voice;
    u.onend = resolve;
    u.onerror = (e) => { log('tts', 'error', e.error); resolve(); };
    speechSynthesis.speak(u);
  });
}

if (ttsAvailable()) speechSynthesis.onvoiceschanged = () => { voice = null; };
