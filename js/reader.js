// reader.js — shows a page of the story and colours its words.

import { wordsHtml } from './text.js';

export function renderPage(el, text) {
  el.innerHTML = wordsHtml(text);
  return Array.from(el.querySelectorAll('.w'));
}

/** Words before p are read, word p is the one to read now. */
export function setPosition(spans, p) {
  spans.forEach((s, i) => {
    s.classList.toggle('read', i < p);
    s.classList.toggle('current', i === p);
  });
  const cur = spans[p];
  if (cur) {
    const r = cur.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 140 || r.top < 80) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

export function markHint(spans, i) {
  spans[i]?.classList.add('hint');
}

/** After the page: green for read, red for skipped or mispronounced, amber for hints. */
const STATUS_HE = { om: 'דילגת על המילה', mis: 'הגייה', hint: 'רמז' };

/** Colours each word by its result; a word said instead shows what was said. */
export function showStatuses(spans, statuses, said = {}) {
  spans.forEach((s, i) => {
    const st = statuses[i] || 'ok';
    s.classList.remove('read', 'current');
    s.classList.add('st-' + st);
    if (st === 'sub') s.title = 'נאמר: ' + said[i];
    else if (STATUS_HE[st]) s.title = STATUS_HE[st];
  });
}

export function onWordTap(el, cb) {
  el.onclick = (e) => {
    const w = e.target.closest('.w');
    if (w) cb(Number(w.dataset.i), w.textContent);
  };
}
