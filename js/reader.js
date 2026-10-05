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
export function showStatuses(spans, statuses) {
  spans.forEach((s, i) => {
    s.classList.remove('read', 'current');
    s.classList.add('st-' + (statuses[i] || 'ok'));
  });
}

export function onWordTap(el, cb) {
  el.onclick = (e) => {
    const w = e.target.closest('.w');
    if (w) cb(Number(w.dataset.i), w.textContent);
  };
}
