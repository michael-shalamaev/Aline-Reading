// Prints what each server action costs in Google round trips (estimate, see COST_MS in gas-mock).
// Run: node tests/perf-report.mjs
import { loadServer } from './gas-mock.mjs';
import { tokenize } from '../js/text.js';

const s = loadServer();
s.ctx.setup();
const code = s.book().getSheetByName('הגדרות').rows().find((r) => r[0] === 'code')[2];
// 60 earlier days in the stories tab, like after two months of use.
const tab = s.book().getSheetByName('סיפורים');
for (let d = 0; d < 60; d++) {
  tab.appendRow(['x' + d, 'אלין', '2026-08-' + String((d % 28) + 1).padStart(2, '0'), 'לא', 'עבר', 't', 'T', new Date(), JSON.stringify({ pad: 'x'.repeat(6000) }), JSON.stringify({ finished: true })]);
}
const rows = [];
const run = (label, req) => {
  s.clock.now += 61000; // past the 60s settings cache, like a real gap between requests
  const m = s.measure({ k: code, ...req });
  if (!m.res.ok) throw new Error(label + ': ' + JSON.stringify(m.res.error));
  rows.push([label, Math.round(m.ms), Math.round(m.lockedMs), JSON.stringify(m.calls)]);
  return m.res.data;
};
run('init', { action: 'init' });
const st = run('newStory', { action: 'newStory', topic: 'dragons' });
const words = tokenize(st.story.pages[0].text).map(() => 'ok');
const sp = run('startPage', { action: 'startPage', page: 0 });
run('submitPage', { action: 'submitPage', page: 0, words, insertions: 0, attemptId: 'a1' });
run('answer', { action: 'answer', kind: 'page', page: 0, choice: 1 });
run('speechToken', { action: 'speechToken' });
console.log('action'.padEnd(12), 'est.ms'.padStart(7), 'inLock'.padStart(7), ' calls');
for (const r of rows) console.log(r[0].padEnd(12), String(r[1]).padStart(7), String(r[2]).padStart(7), ' ' + r[3]);
