// text.js — splitting a story into words and comparing words.
// The tokenizer MUST match server/Util.gs (tests/text.test.mjs checks that).

export const WORD_RE = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g;

export function tokenize(text) {
  return String(text || '').match(WORD_RE) || [];
}

/** Lower case, apostrophes removed: the form used to compare words. */
export function normWord(w) {
  return String(w || '').toLowerCase().replace(/['’]/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Same word? Exact after normalizing. When loose (the page word is capitalized,
 * usually a name), allow up to two letters of difference: the recognizer often
 * spells names its own way (Maddie / Maddy).
 */
export function sameWord(a, b, loose = false) {
  if (a === b) return true;
  if (loose && a.length >= 4 && b.length >= 3) return levenshtein(a, b) <= 2;
  return false;
}

/** Page words that may be matched loosely (capitalized: names, mostly). */
export function looseFlags(ref) {
  return ref.map((w) => /^[A-Z]/.test(w));
}

/**
 * Splits text into HTML: each word becomes <span class="w" data-i="n">, everything
 * else (spaces, punctuation, paragraph breaks) stays as plain text.
 */
export function wordsHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = String(text || '').split(/\n\s*\n/);
  let i = 0;
  return paragraphs.map((para) => {
    let out = '';
    let last = 0;
    para.replace(WORD_RE, (m, offset) => {
      out += esc(para.slice(last, offset)) + `<span class="w" data-i="${i++}">${esc(m)}</span>`;
      last = offset + m.length;
      return m;
    });
    out += esc(para.slice(last));
    return `<p>${out}</p>`;
  }).join('');
}
