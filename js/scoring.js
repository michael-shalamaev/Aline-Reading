// scoring.js — turns what Microsoft heard into a status per word of the page.
// Microsoft's continuous mode does not report skipped or added words, so we align
// the heard words to the page text ourselves (longest common subsequence).

import { normWord, sameWord, looseFlags } from './text.js';
import { MISPRONOUNCED_BELOW } from './config.js';

const scoreOf = (h) => (h.err === 'Mispronunciation' ? -1 : (typeof h.acc === 'number' ? h.acc : 100));

const FILLERS = new Set(['um', 'uh', 'ah', 'eh', 'hmm', 'mm', 'er', 'erm', 'oh']);

/**
 * @param {string[]} ref    page words, as displayed
 * @param {{word:string, acc:number, err:string}[]} heard  words from Microsoft, in order
 * @param {Set<number>} hinted  indexes of words the child asked to hear
 * @param {number} misBelow  Microsoft score under which a word counts as mispronounced
 * @returns {{statuses:string[], insertions:number}}  status: ok | om | mis | hint
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
      const bad = h.err === 'Mispronunciation' || (typeof h.acc === 'number' && h.acc < misBelow);
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

  // Extra words count as insertions, except fillers and a child repeating
  // a neighbouring word while correcting herself ("the... the cat").
  let insertions = 0;
  for (const u of unmatchedHeard) {
    const w = H[u.j];
    if (!w || FILLERS.has(w)) continue;
    const neighbours = [R[u.near - 1], R[u.near], R[u.near + 1]];
    if (neighbours.some((r) => r && sameWord(r, w))) continue;
    insertions++;
  }

  hinted.forEach((k) => { if (k >= 0 && k < n) statuses[k] = 'hint'; });
  return { statuses, insertions };
}

/** Below the bar for one page? Same rule as server/Scoring.gs pageBelowBar. */
export function pageBelow(summary, child, storyWords) {
  if (child.passByErrors) return summary.errors > Math.ceil(child.maxErrors * summary.n / Math.max(storyWords, 1));
  return summary.acc < child.passPercent;
}

/** Counts like the server does, to show the child a result instantly. */
export function summarize(statuses, insertions) {
  const c = { ok: 0, om: 0, mis: 0, hint: 0 };
  statuses.forEach((s) => { c[s]++; });
  const errors = c.om + c.mis + c.hint + insertions;
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
