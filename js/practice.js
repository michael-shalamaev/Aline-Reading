// practice.js — hard words before a page, and practising missed words after it.

import { speak } from './tts.js';
import { checkWord } from './speech.js';
import { call } from './api.js';
import { log } from './debug.js';
import { reportError } from './report.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Hard words of the coming page: tap to hear, as many times as wanted. */
export function renderPrep(el, words, lang) {
  if (!words.length) {
    el.innerHTML = '<p class="muted">אין מילים קשות בעמוד הזה. אפשר להתחיל!</p>';
    return;
  }
  el.innerHTML = words.map((w) =>
    `<button type="button" class="chip word-chip" lang="en" data-w="${esc(w)}"><span class="ico">🔊</span>${esc(w)}</button>`
  ).join('');
  el.onclick = (e) => {
    const b = e.target.closest('[data-w]');
    if (b) speak(b.dataset.w, lang);
  };
}

/**
 * Missed words after a page: hear it, try it. Does not change the score.
 * Results are sent to the server when the child moves on.
 */
export function renderPractice(el, errWords, lang, misBelow) {
  const seen = new Set();
  const words = errWords.map((e) => e.w).filter((w) => {
    const k = w.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const results = new Map();
  if (!words.length) {
    el.innerHTML = '';
    return { flush: () => {} };
  }
  el.innerHTML = '<h3>בואו נתרגל את המילים האלה</h3><ul class="practice">' + words.map((w, i) =>
    `<li data-i="${i}"><span class="pw" lang="en">${esc(w)}</span>
      <button type="button" class="icon-btn" data-act="hear" aria-label="שמיעה">🔊</button>
      <button type="button" class="icon-btn" data-act="try" aria-label="ניסיון">🎤</button>
      <span class="verdict" aria-live="polite"></span></li>`).join('') + '</ul>';

  el.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const li = btn.closest('li');
    const word = words[Number(li.dataset.i)];
    const verdict = li.querySelector('.verdict');
    if (btn.dataset.act === 'hear') return speak(word, lang);
    btn.disabled = true;
    verdict.textContent = 'מקשיבים…';
    try {
      const r = await checkWord(word, lang, misBelow);
      results.set(word, r.ok || results.get(word) === true);
      verdict.textContent = r.ok ? '✓ מצוין!' : (r.heard ? `✗ שמעתי "${r.heard}". עוד פעם?` : '✗ לא שמעתי. עוד פעם?');
      verdict.className = 'verdict ' + (r.ok ? 'good' : 'bad');
    } catch (err) {
      log('practice', 'check failed', String(err));
      verdict.textContent = 'משהו לא עבד, נסו שוב';
    } finally {
      btn.disabled = false;
    }
  };

  return {
    flush() {
      if (!results.size) return;
      const list = Array.from(results, ([word, ok]) => ({ word, ok }));
      call('practice', { results: list }).catch((e) => { log('practice', 'save failed', String(e)); reportError('practice', e, 'result'); });
    }
  };
}
