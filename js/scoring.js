// scoring.js — turns what Microsoft heard into a status per word of the page.
// Microsoft's continuous mode does not report skipped or added words, so we align
// the heard words to the page text ourselves (longest common subsequence).

import { normWord, sameWord, looseFlags } from './text.js';
import { MISPRONOUNCED_BELOW } from './config.js';

// Only the score counts, against the parent's threshold. Microsoft's own "Mispronunciation"
// label uses its fixed cut at 60 and would override the parent's setting.
const scoreOf = (h) => (typeof h.acc === 'number' ? h.acc : 100);

// Microsoft often does not hear a short article in fluent reading ("still as a statue").
// Such a word missing on its own, between words that were read, is not counted.
const SWALLOWED = new Set(['a', 'an', 'the']);

const FILLERS = new Set(['um', 'uh', 'ah', 'eh', 'hmm', 'mm', 'er', 'erm', 'oh']);

/**
 * @param {string[]} ref    page words, as displayed
 * @param {{word:string, acc:number, err:string}[]} heard  words from Microsoft, in order
 * @param {Set<number>} hinted  indexes of words the child asked to hear
 * @param {number} misBelow  Microsoft score under which a word counts as mispronounced
 * @returns {{statuses:string[], insertions:number, said:Object<number,string>}}
 *   status: ok | om (skipped) | sub (another word said instead) | mis (pronunciation) | hint;
 *   said: for each sub, the word that was said
 */
export function alignPage(ref, heard, hinted = new Set(), misBelow = MISPRONOUNCED_BELOW) {
  const R = ref.map(normWord);
  const L = looseFlags(ref);
  const H = heard.map((h) => normWord(h.word));
  const n = R.length, m = H.length;

  // dp[i][j] = longest match of R[i..] and H[j..]
  const dp = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = sameWord(R[i], H[j], L[i]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const statuses = new Array(n).fill('om');
  const unmatchedHeard = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (sameWord(R[i], H[j], L[i]) && dp[i][j] === dp[i + 1][j + 1] + 1) {
      // Said again right away (a self-correction, not a word the text repeats): the better try counts.
      let h = heard[j];
      while (j + 1 < m && sameWord(R[i], H[j + 1], L[i]) && !(i + 1 < n && sameWord(R[i + 1], H[j + 1], L[i + 1]))) {
        j++;
        if (scoreOf(heard[j]) > scoreOf(h)) h = heard[j];
      }
      const bad = scoreOf(h) < misBelow;
      statuses[i] = bad ? 'mis' : 'ok';
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      unmatchedHeard.push({ j, near: i });
      j++;
    }
  }
  while (j < m) unmatchedHeard.push({ j: j++, near: n });

  // Extra words: fillers and a child repeating a neighbouring word while correcting
  // herself ("the... the cat") are ignored.
  const extra = unmatchedHeard.filter((u) => {
    const w = H[u.j];
    if (!w || FILLERS.has(w)) return false;
    const neighbours = [R[u.near - 1], R[u.near], R[u.near + 1]];
    return !neighbours.some((r) => r && sameWord(r, w));
  });

  // Another word said in place of a page word ("Natasha" for "Maya"): in a run of
  // skipped page words, the extra words said at that spot replace them one for one.
  // One error ("another word"), not a skip plus an added word.
  const said = {};
  const used = new Set();
  for (let s = 0; s < n; s++) {
    if (statuses[s] !== 'om') continue;
    let e = s;
    while (e + 1 < n && statuses[e + 1] === 'om') e++;
    const here = extra.filter((u) => !used.has(u) && u.near >= s && u.near <= e + 1);
    for (let t = 0; t < Math.min(here.length, e - s + 1); t++) {
      statuses[s + t] = 'sub';
      said[s + t] = heard[here[t].j].word;
      used.add(here[t]);
    }
    s = e;
  }
  const insertions = extra.length - used.size;

  for (let k = 0; k < n; k++) {
    if (statuses[k] !== 'om' || !SWALLOWED.has(R[k])) continue;
    const before = k === 0 || statuses[k - 1] !== 'om';
    const after = k === n - 1 || statuses[k + 1] !== 'om';
    if (before && after) statuses[k] = 'ok';
  }

  hinted.forEach((k) => { if (k >= 0 && k < n) statuses[k] = 'hint'; });
  return { statuses, insertions, said };
}

/** Below the bar for one page? Same rule as server/Scoring.gs pageBelowBar. */
export function pageBelow(summary, child, storyWords) {
  if (child.passByErrors) return summary.errors > Math.ceil(child.maxErrors * summary.n / Math.max(storyWords, 1));
  return summary.acc < child.passPercent;
}

/** Counts like the server does, to show the child a result instantly. */
export function summarize(statuses, insertions) {
  const c = { ok: 0, om: 0, sub: 0, mis: 0, hint: 0 };
  statuses.forEach((s) => { c[s]++; });
  const errors = c.om + c.sub + c.mis + c.hint + insertions;
  const n = statuses.length;
  return { ...c, ins: insertions, errors, n, acc: Math.round(Math.max(0, (n - errors) / n) * 1000) / 10 };
}

/**
 * Follows the reading live: given every word heard so far (final + in-progress),
 * returns the index of the next word to read. Greedy: looks a few words ahead, so a
 * skipped word does not stop the highlight; and when two heard words in a row match
 * two page words in a row further on (a skipped line), it jumps there.
 */
export function followPosition(ref, heardWords, lookahead = 4, resync = 40) {
  const R = ref.map(normWord);
  const L = looseFlags(ref);
  let p = 0;
  let prev = null;
  for (const raw of heardWords) {
    const w = normWord(raw);
    let found = -1;
    for (let k = p; k < Math.min(R.length, p + lookahead + 1); k++) {
      if (sameWord(R[k], w, L[k])) { found = k; break; }
    }
    if (found < 0 && prev !== null) {
      for (let k = p + lookahead + 1; k < Math.min(R.length, p + resync); k++) {
        if (sameWord(R[k], w, L[k]) && sameWord(R[k - 1], prev, L[k - 1])) { found = k; break; }
      }
    }
    if (found >= 0) p = found + 1;
    prev = w;
  }
  return p;
}
