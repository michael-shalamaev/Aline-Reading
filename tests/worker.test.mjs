// The Cloudflare server (worker/src) against the same scenarios as the Apps Script server,
// plus what is new: the bridge to the sheet, background reports, cached settings, locking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadWorker } from './worker-harness.mjs';
import { tokenize as pageTokenize, normWord as pageNorm } from '../js/text.js';
import { answerKey as pageKey } from '../js/answers.js';
import * as util from '../worker/src/util.js';
import worker from '../worker/src/index.js';
import { storyPrompt } from '../worker/src/stories.js';

const tokenize = pageTokenize;

async function readAll(s, story, { skipPerPage = 0, extra = false, answer = 1 } = {}) {
  for (let i = 0; i < story.pages.length; i++) {
    assert.equal((await s.k({ action: 'startPage', page: i, extra })).ok, true);
    s.clock.now += 60000;
    const n = tokenize(story.pages[i].text).length;
    const words = Array.from({ length: n }, (_, j) => (j < skipPerPage ? 'om' : 'ok'));
    const r = await s.k({ action: 'submitPage', page: i, extra, words, insertions: 0 });
    assert.equal(r.ok, true, JSON.stringify(r));
    await s.k({ action: 'answer', kind: 'page', page: i, choice: answer, extra });
  }
  for (const f of [0, 1, 2]) await s.k({ action: 'answer', kind: 'final', index: f, choice: answer, extra });
  return s.k({ action: 'finish', extra });
}

test('worker: word splitting and answer keys are the same on the page, Apps Script and the new server', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../server/Util.gs', import.meta.url), 'utf8'), ctx);
  for (const s of ['Mia said, "Let\'s go!" They didn’t wait.', 'twenty one cats — the dragon\'s eyes']) {
    assert.deepEqual(util.tokenize(s), pageTokenize(s));
    assert.deepEqual(util.tokenize(s), Array.from(ctx.tokenize(s)));
  }
  assert.equal(util.normWord('Didn’t'), pageNorm("didn't"));
  assert.equal(util.answerKey('abc', 'p1', 2), pageKey('abc', 'p1', 2));
  assert.equal(util.answerKey('abc', 'p1', 2), ctx.answerKey('abc', 'p1', 2));
});

test('worker: wrong code is refused', async () => {
  const s = loadWorker();
  const r = await s.api({ action: 'init', k: 'nope' });
  assert.equal(r.error.code, 'unauthorized');
});

test('worker: full day — story, pages, questions, pass; log, pages, hard words and mail reach the sheet', async () => {
  const s = loadWorker();
  const init = await s.k({ action: 'init' });
  assert.equal(init.data.child.name, 'אלין');
  assert.equal(init.data.session, null);
  const st = await s.k({ action: 'newStory', topic: 'dragons' });
  assert.equal(st.ok, true, JSON.stringify(st.error));
  const story = st.data.story;
  assert.equal(story.pages.length, 5);
  assert.equal(story.pages[0].question.answer, undefined, 'answers never reach the phone');
  assert.deepEqual(story.pages[0].hardWords, ['dragon', 'garden']);
  assert.ok(s.fetches.some((u) => u.includes('gemini-3.8-flash-lite:generateContent')));
  const fin = await readAll(s, story, { skipPerPage: 2 });
  assert.equal(fin.ok, true, JSON.stringify(fin));
  assert.equal(fin.data.result.passed, true);
  assert.equal(fin.data.result.errors, 10);
  assert.equal(fin.data.result.quizCorrect, 8);
  assert.equal(fin.data.extraAllowed, true);
  await s.settle();
  assert.equal(s.mails.length, 1);
  assert.match(s.mails[0].subject, /עבר/);
  assert.equal(s.rows('יומן').length, 2);
  assert.equal(s.rows('עמודים').length, 6);
  assert.ok(s.rows('מילים קשות').length > 1);
  assert.equal(await s.pending(), 0, 'nothing left waiting');
  assert.equal((await s.k({ action: 'init' })).data.session.finished, true);
});

test('worker: too many errors fails the day', async () => {
  const s = loadWorker();
  const story = (await s.k({ action: 'newStory', topic: 'cats' })).data.story;
  const fin = await readAll(s, story, { skipPerPage: 30, answer: 0 });
  assert.equal(fin.data.result.passed, false);
  await s.settle();
  assert.match(s.mails[0].subject, /לא עבר/);
});

test('worker: regenerate up to the limit, then locked once reading starts', async () => {
  const s = loadWorker();
  await s.k({ action: 'newStory', topic: 'a' });
  for (let i = 0; i < 3; i++) assert.equal((await s.k({ action: 'newStory', topic: 'b' + i })).ok, true);
  assert.equal((await s.k({ action: 'newStory', topic: 'c' })).error.code, 'no_regen_left');
  const s2 = loadWorker();
  await s2.k({ action: 'newStory', topic: 'a' });
  await s2.k({ action: 'startPage', page: 0 });
  assert.equal((await s2.k({ action: 'newStory', topic: 'b' })).error.code, 'locked');
});

test('worker: only the next page; one retry of a weak page; best attempt counts', async () => {
  const s = loadWorker();
  const story = (await s.k({ action: 'newStory', topic: 'x' })).data.story;
  assert.equal((await s.k({ action: 'startPage', page: 2 })).error.code, 'page_not_allowed');
  const n = tokenize(story.pages[0].text).length;
  await s.k({ action: 'startPage', page: 0 });
  s.clock.now += 60000;
  const weak = (await s.k({ action: 'submitPage', page: 0, words: Array(n).fill('om'), insertions: 0 })).data;
  assert.equal(weak.canRetry, true);
  assert.equal((await s.k({ action: 'startPage', page: 0 })).ok, true);
  s.clock.now += 60000;
  const good = (await s.k({ action: 'submitPage', page: 0, words: Array(n).fill('ok'), insertions: 0 })).data;
  assert.equal(good.best.acc, 100);
  assert.equal((await s.k({ action: 'startPage', page: 0 })).error.code, 'page_not_allowed');
});

test('worker: wrong word count is refused; a reading sent twice counts once', async () => {
  const s = loadWorker();
  const story = (await s.k({ action: 'newStory', topic: 'x' })).data.story;
  const st = (await s.k({ action: 'startPage', page: 0 })).data;
  assert.equal(st.speech.region, 'westeurope');
  assert.equal((await s.k({ action: 'submitPage', page: 0, words: ['ok'], insertions: 0 })).error.code, 'bad_payload');
  const words = Array(tokenize(story.pages[0].text).length).fill('om');
  const a = (await s.k({ action: 'submitPage', page: 0, words, insertions: 0, attemptId: 'r1' })).data;
  const b = (await s.k({ action: 'submitPage', page: 0, words, insertions: 0, attemptId: 'r1' })).data;
  assert.deepEqual(a, b);
  await s.settle();
  assert.equal(s.rows('עמודים').length, 2, 'logged once');
});

test('worker: time window runs out — progress resets, the parent gets a mail', async () => {
  const s = loadWorker();
  const story = (await s.k({ action: 'newStory', topic: 'x' })).data.story;
  const n = tokenize(story.pages[0].text).length;
  await s.k({ action: 'startPage', page: 0 });
  s.clock.now += 60000;
  await s.k({ action: 'submitPage', page: 0, words: Array(n).fill('ok'), insertions: 0 });
  s.clock.now += 61 * 60000;
  const r = await s.k({ action: 'startPage', page: 1 });
  assert.equal(r.data.expired, true);
  assert.equal(r.data.session.pages[0].best, null);
  await s.settle();
  assert.match(s.mails[0].subject, /חלון הזמן/);
  assert.match(s.rows('יומן').at(-1)[21], /חלון הזמן פג/);
  assert.equal((await s.k({ action: 'startPage', page: 0 })).ok, true);
});

test('worker: next day starts a new story (Israel time)', async () => {
  const s = loadWorker();
  await s.k({ action: 'newStory', topic: 'x' });
  s.clock.now = Date.parse('2026-10-06T23:30:00+03:00');
  assert.notEqual((await s.k({ action: 'init' })).data.session, null, 'still the same day in Israel');
  s.clock.now = Date.parse('2026-10-07T00:10:00+03:00');
  assert.equal((await s.k({ action: 'init' })).data.session, null, 'after midnight in Israel');
});

test('worker: extra story only after today\'s story, without questions, summed up with its last page', async () => {
  const s = loadWorker();
  assert.equal((await s.k({ action: 'newStory', topic: 'x', extra: true })).error.code, 'extra_not_allowed');
  const story = (await s.k({ action: 'newStory', topic: 'x' })).data.story;
  await readAll(s, story);
  const ex = await s.k({ action: 'newStory', topic: 'more', extra: true });
  assert.equal(ex.data.questions, false);
  for (let i = 0; i < story.pages.length; i++) {
    await s.k({ action: 'startPage', page: i, extra: true });
    s.clock.now += 60000;
    await s.k({ action: 'submitPage', page: i, extra: true, words: Array(tokenize(ex.data.story.pages[i].text).length).fill('ok'), insertions: 0 });
  }
  const fin = await s.k({ action: 'finish', extra: true });
  assert.equal(fin.data.again, true, 'already summed up by the last page');
  const init = await s.k({ action: 'init' });
  assert.equal(init.data.extraSession, null);
  await s.settle();
  assert.equal(s.mails.length, 2);
  assert.equal(s.rows('יומן').at(-1)[2], 'כן', 'marked as extra in the log');
});

test('worker: another story after a failed day too, again and again; the day\'s result stays', async () => {
  const s = loadWorker();
  const init0 = await s.k({ action: 'init' });
  assert.equal(init0.data.extraAfterAny, true);
  const story = (await s.k({ action: 'newStory', topic: 'cats' })).data.story;
  const fin = await readAll(s, story, { skipPerPage: 30, answer: 0 });
  assert.equal(fin.data.result.passed, false);
  assert.equal(fin.data.extraAllowed, true, 'offered although the day did not pass');
  for (const topic of ['more', 'and more']) {
    const ex = await s.k({ action: 'newStory', topic, extra: true });
    assert.equal(ex.ok, true, JSON.stringify(ex.error));
    const exFin = await readAll(s, ex.data.story, { extra: true });
    assert.equal(exFin.ok, true, JSON.stringify(exFin));
    assert.equal(exFin.data.extraAllowed, true, 'one more after an extra story as well');
  }
  const init = await s.k({ action: 'init' });
  assert.equal(init.data.session.result.passed, false, 'extra stories add, they do not replace the day\'s result');
  await s.settle();
  assert.deepEqual(s.rows('יומן').slice(1).map((r) => r[2]), ['לא', 'כן', 'כן']);
});

test('worker: every story written reaches the sheet as readable text; a changed topic says from what to what', async () => {
  const s = loadWorker({ adjust: true });
  const st = await s.k({ action: 'newStory', topic: 'מכוניות מרוץ' });
  assert.equal(st.ok, true, JSON.stringify(st.error));
  await s.k({ action: 'newStory', topic: 'dragons' }); // written again: a row of its own
  await s.settle();
  const rows = s.rows('טקסט סיפורים');
  assert.equal(rows[0][0], 'נוצר', 'the tab is made with its headers');
  assert.equal(rows.length, 3);
  const [, child, , extra, topic, used, changed, title, words, text, questions, id] = rows[1];
  assert.equal(child, 'אלין');
  assert.equal(extra, 'לא');
  assert.equal(topic, 'מכוניות מרוץ');
  assert.equal(used, 'dragon');
  assert.equal(changed, 'כן');
  assert.equal(title, 'Mia and the Tiny Dragon');
  assert.ok(words > 100);
  assert.match(text, /^עמוד 1\nMia found/);
  assert.match(text, /\n\nעמוד 5\n/);
  assert.match(questions, /עמוד 1: What did Mia find\?\n {3}1\. A cat\n {3}2\. A dragon ✓/);
  assert.match(questions, /סיכום 3: /);
  assert.equal(id, rows[2][11], 'same story, same id');
  const fin = await readAll(s, (await s.k({ action: 'init' })).data.session.story);
  assert.ok(fin.data.result.flags.includes('הנושא שונה מ"dragons" ל"dragon", כי לא התאים לסיפור ילדים'), fin.data.result.flags.join('|'));
  const kid = { age: 10, level: 'בינוני', pages: 5, words: 450, lang: 'en-US' };
  assert.match(storyPrompt(kid, 'תפוז', true), /translating the topic, making it a character or adding details is not a change/);
});

test('worker: a model that does not answer in time is left for the next one; the slow one is noted', async () => {
  const s = loadWorker({ slowModels: ['gemini-3.8-flash-lite'], geminiTimeoutMs: 200 });
  const t0 = Date.now();
  const st = await s.k({ action: 'newStory', topic: 'x' });
  assert.equal(st.ok, true, JSON.stringify(st.error));
  assert.ok(Date.now() - t0 < 3000, 'did not wait for the stuck model');
  assert.deepEqual(s.fetches.filter((f) => f.startsWith('model:')), ['model:gemini-3.8-flash-lite', 'model:gemini-3.8-flash']);
  await s.settle();
  assert.ok(s.rows('שגיאות').some((r) => r[2] === 'gemini gemini-3.8-flash-lite' && /gemini_slow: no answer/.test(r[3])));
  // A second try (the first story was short) starts at the model that answered, not at the stuck one.
  const again = loadWorker({ slowModels: ['gemini-3.8-flash-lite'], geminiTimeoutMs: 200, shortStories: 1 });
  assert.equal((await again.k({ action: 'newStory', topic: 'x' })).ok, true);
  assert.deepEqual(again.fetches.filter((f) => f.startsWith('model:')), ['model:gemini-3.8-flash-lite', 'model:gemini-3.8-flash', 'model:gemini-3.8-flash']);
  await again.settle();
  const all = loadWorker({ slowModels: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.8-flash-lite'], geminiTimeoutMs: 100 });
  assert.equal((await all.k({ action: 'newStory', topic: 'x' })).error.code, 'gemini_timeout');
  await all.settle();
});

test('worker: a story shorter than asked is written again once; with no time left the short one is taken', async () => {
  let s = loadWorker({ shortStories: 1 });
  let st = await s.k({ action: 'newStory', topic: 'x' });
  assert.equal(st.ok, true, JSON.stringify(st.error));
  assert.equal(s.fetches.filter((f) => f.startsWith('model:')).length, 2, 'written again');
  const target = (await s.k({ action: 'init' })).data.child.words;
  assert.ok(st.data.story.wordCount >= target * 0.85, st.data.story.wordCount + ' of ' + target);
  await s.settle();
  assert.ok(s.rows('שגיאות').some((r) => /generateStory#1/.test(r[2]) && new RegExp('below ' + Math.round(target * 0.85)).test(r[3])));
  s = loadWorker({ shortStories: 1, storyBudgetMs: 10000 }); // time for one try, not for a second
  st = await s.k({ action: 'newStory', topic: 'x' });
  assert.equal(st.ok, true, 'no time for another: the short story is still a story ' + JSON.stringify(st.error));
  assert.equal(s.fetches.filter((f) => f.startsWith('model:')).length, 1);
  assert.ok(st.data.story.wordCount < target * 0.85);
});

test('worker: busy model skipped; all busy → clear error, logged; topic refused → topic_blocked', async () => {
  let s = loadWorker({ busyModels: ['gemini-3.8-flash-lite'] });
  assert.equal((await s.k({ action: 'newStory', topic: 'x' })).ok, true);
  assert.deepEqual(s.fetches.filter((f) => f.startsWith('model:')), ['model:gemini-3.8-flash-lite', 'model:gemini-3.8-flash']);
  await s.settle(); // its rows go to its own sheet before the next test server takes over the network
  s = loadWorker({ busyModels: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.8-flash-lite'] });
  assert.equal((await s.k({ action: 'newStory', topic: 'x' })).error.code, 'gemini_busy');
  await s.settle();
  assert.ok(s.rows('שגיאות').some((r) => /gemini_busy/.test(r[3])));
  s = loadWorker({ blockTopic: 'אח ואחות' });
  assert.equal((await s.k({ action: 'newStory', topic: 'על יחסים של אח ואחות' })).error.code, 'topic_blocked');
  assert.equal(s.fetches.filter((f) => f.startsWith('model:')).length, 1);
  s = loadWorker({ wrongPages: true });
  assert.equal((await s.k({ action: 'newStory', topic: 'x' })).error.code, 'bad_story');
});

test('worker: speech token reused for 5 minutes', async () => {
  const s = loadWorker();
  const a = (await s.k({ action: 'speechToken' })).data;
  s.clock.now += 120000;
  const b = (await s.k({ action: 'speechToken' })).data;
  assert.equal(a.token, b.token);
  assert.equal(b.ttlSec, 480);
});

test('worker: finish fills in lost answers, never changes a saved one; twice gives the same result, one mail', async () => {
  const s = loadWorker();
  const story = (await s.k({ action: 'newStory', topic: 'dragons' })).data.story;
  for (let i = 0; i < story.pages.length; i++) {
    await s.k({ action: 'startPage', page: i });
    await s.k({ action: 'submitPage', page: i, words: tokenize(story.pages[i].text).map(() => 'ok'), insertions: 0, attemptId: 'a' + i });
  }
  await s.k({ action: 'answer', kind: 'page', page: 0, choice: 1 });
  assert.equal((await s.k({ action: 'finish', answers: { pages: [1, 1, 1, 1, null], final: [1, 1, 1] } })).error.code, 'too_early');
  const r = await s.k({ action: 'finish', answers: { pages: [3, 1, 1, 1, 1], final: [1, 0, 1] } });
  assert.equal(r.data.result.quizCorrect, 7);
  const again = await s.k({ action: 'finish' });
  assert.equal(again.data.again, true);
  await s.settle();
  assert.equal(s.mails.length, 1);
});

test('worker: the last answer sums the story up without the phone asking', async () => {
  const s = loadWorker();
  const story = (await s.k({ action: 'newStory', topic: 'dragons' })).data.story;
  for (let i = 0; i < story.pages.length; i++) {
    await s.k({ action: 'startPage', page: i });
    await s.k({ action: 'submitPage', page: i, words: tokenize(story.pages[i].text).map(() => 'ok'), insertions: 0, attemptId: 'a' + i });
    await s.k({ action: 'answer', kind: 'page', page: i, choice: 1 });
  }
  for (const f of [0, 1, 2]) await s.k({ action: 'answer', kind: 'final', index: f, choice: 1 });
  assert.equal((await s.k({ action: 'init' })).data.session.finished, true);
  await s.settle();
  assert.equal(s.mails.length, 1);
});

test('worker: another word, extra words and phone errors reach the sheet', async () => {
  const s = loadWorker();
  const story = (await s.k({ action: 'newStory', topic: 'dragons' })).data.story;
  await s.k({ action: 'startPage', page: 0 });
  const words = tokenize(story.pages[0].text).map(() => 'ok');
  words[0] = 'sub';
  await s.k({ action: 'submitPage', page: 0, words, insertions: 2, said: { 0: 'natasha' }, extraWords: ['banana', 'robot'], attemptId: 'e1' });
  await s.k({ action: 'clientError', where: 'startPage', code: 'server_html', message: 'HTTP 200', details: 'x'.repeat(9000) });
  await s.settle();
  const row = s.rows('עמודים').at(-1);
  assert.match(row[15], /מילה אחרת: natasha/);
  assert.match(row[15], /נוספו: banana, robot/);
  const err = s.rows('שגיאות').at(-1);
  assert.equal(err[2], 'טלפון: startPage');
  assert.equal(err[4].length, 4000);
});

test('worker: every answer names its action and carries the server time', async () => {
  const s = loadWorker();
  const r = await s.k({ action: 'init' });
  assert.equal(r.a, 'init');
  assert.equal(typeof r.t, 'number');
  assert.equal((await s.api({ action: 'ping' })).a, 'ping');
});

/* ---------- new with this server ---------- */

test('bridge down: the child is not affected; rows and mail wait and arrive later, in order', async () => {
  const s = loadWorker();
  await s.k({ action: 'init' }); // settings cached while the bridge is up
  s.bridge.down = true;
  const story = (await s.k({ action: 'newStory', topic: 'dragons' })).data.story;
  const fin = await readAll(s, story);
  assert.equal(fin.data.result.passed, true, 'the child gets her result');
  await s.settle();
  assert.equal(s.mails.length, 0);
  assert.ok(await s.pending() >= 6, 'rows waiting');
  s.bridge.down = false;
  assert.equal((await s.flush()).sent, 0, 'not before its retry time');
  s.clock.now += 31 * 60000;
  while ((await s.flush()).sent) { /* until empty */ }
  assert.equal(await s.pending(), 0);
  assert.equal(s.mails.length, 1);
  assert.equal(s.rows('עמודים').length, 6);
  assert.equal(s.rows('יומן').length, 2);
});

test('settings: read from the sheet; after 10 minutes refreshed in the background (nobody waits); sheet down → last known', async () => {
  const s = loadWorker();
  await s.k({ action: 'init' });
  s.rows('הגדרות').find((r) => r[0] === 'pages')[2] = 3;
  s.clock.now += 5 * 60000;
  assert.equal((await s.k({ action: 'init' })).data.child.pages, 5, 'still the kept settings');
  s.clock.now += 6 * 60000;
  const calls = s.bridge.calls.length;
  assert.equal((await s.k({ action: 'init' })).data.child.pages, 5, 'answered at once with the kept ones');
  await s.settle();
  assert.equal(s.bridge.calls.length, calls + 1, 'refreshed in the background');
  assert.equal((await s.k({ action: 'init' })).data.child.pages, 3, 'the change applies from the next request');
  s.bridge.down = true;
  s.clock.now += 11 * 60000;
  const r = await s.k({ action: 'init' });
  assert.equal(r.ok, true, 'works with the last known settings');
  assert.equal(r.data.child.pages, 3);
  await s.settle();
  s.bridge.down = false;
  s.clock.now += 31 * 60000;
  while ((await s.flush()).sent) { /* */ }
  assert.ok(s.rows('שגיאות').some((row) => /settings refresh/.test(row[2])), 'the failed refresh is reported');
});

test('two new-story requests at the same moment: one story for the day, not two', async () => {
  const s = loadWorker();
  const [a, b] = await Promise.all([s.k({ action: 'newStory', topic: 'a' }), s.k({ action: 'newStory', topic: 'b' })]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.data.id, b.data.id, 'the same session');
  const n = await s.env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first();
  assert.equal(n.n, 1);
});

test('two summing-up requests at the same moment: both get the result, one mail', async () => {
  const s = loadWorker();
  const story = (await s.k({ action: 'newStory', topic: 'dragons' })).data.story;
  for (let i = 0; i < story.pages.length; i++) {
    await s.k({ action: 'startPage', page: i });
    await s.k({ action: 'submitPage', page: i, words: tokenize(story.pages[i].text).map(() => 'ok'), insertions: 0, attemptId: 'a' + i });
  }
  const answers = { pages: [1, 1, 1, 1, 1], final: [1, 1, 1] };
  const [x, y] = await Promise.all([s.k({ action: 'finish', answers }), s.k({ action: 'finish', answers })]);
  assert.equal(x.ok, true, JSON.stringify(x.error));
  assert.equal(y.ok, true, JSON.stringify(y.error));
  assert.equal(x.data.result.acc, y.data.result.acc);
  await s.settle();
  assert.equal(s.mails.length, 1);
});

test('the bridge does an item once even if it is sent twice (its answer got lost)', () => {
  const s = loadWorker();
  const secret = s.gas.props.get('BRIDGE_SECRET');
  const item = { id: 77, kind: 'error', childId: 'אלין', action: 'x', message: 'once' };
  s.gas.api({ action: 'bridgeReport', secret, items: [item] });
  const again = s.gas.api({ action: 'bridgeReport', secret, items: [item] });
  assert.equal(again.data.results[0].again, true);
  assert.equal(s.rows('שגיאות').filter((r) => r[3] === 'once').length, 1);
});

test('settings: never reached and the sheet is down → a clear error; wrong bridge secret → config_missing', async () => {
  let s = loadWorker();
  s.bridge.down = true;
  assert.equal((await s.k({ action: 'init' })).error.code, 'settings_unavailable');
  s = loadWorker({ wrongSecret: true });
  assert.equal((await s.k({ action: 'init' })).error.code, 'config_missing');
});

test('the Apps Script bridge refuses requests without the secret', () => {
  const s = loadWorker();
  assert.equal(s.gas.api({ action: 'bridgeSettings' }).error.code, 'unauthorized');
  assert.equal(s.gas.api({ action: 'bridgeReport', secret: 'x', items: [] }).error.code, 'unauthorized');
});

test('two requests at the same moment on one story: both are kept (no lost update)', async () => {
  const s = loadWorker();
  const story = (await s.k({ action: 'newStory', topic: 'dragons' })).data.story;
  await s.k({ action: 'startPage', page: 0 });
  await s.k({ action: 'submitPage', page: 0, words: tokenize(story.pages[0].text).map(() => 'ok'), insertions: 0, attemptId: 'c0' });
  // The answer to page 1 and the start of page 2 arrive together.
  const [a, b] = await Promise.all([
    s.k({ action: 'answer', kind: 'page', page: 0, choice: 1 }),
    s.k({ action: 'startPage', page: 1 })
  ]);
  assert.equal(a.ok, true, JSON.stringify(a.error));
  assert.equal(b.ok, true, JSON.stringify(b.error));
  const sess = (await s.k({ action: 'init' })).data.session;
  assert.deepEqual(sess.pages[0].answered, { choice: 1, correct: true });
  const raw = await s.env.DB.prepare('SELECT state FROM sessions').first();
  assert.ok(JSON.parse(raw.state).pageStartedAt['1'], 'page 2 start kept too');
});

test('the entry point: CORS for the page, POST with a text body, GET ping without codes, the scheduled job', async () => {
  const s = loadWorker();
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const pre = await worker.fetch(new Request('https://w.test/', { method: 'OPTIONS' }), s.env, ctx);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const post = await worker.fetch(new Request('https://w.test/', {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'init', k: s.code })
  }), s.env, ctx);
  assert.equal(post.headers.get('access-control-allow-origin'), '*');
  assert.equal((await post.json()).data.child.name, 'אלין');
  const get = await (await worker.fetch(new Request('https://w.test/?action=init&k=' + s.code), s.env, ctx)).json();
  assert.equal(get.error.code, 'unauthorized', 'codes are not accepted in addresses');
  const ping = await (await worker.fetch(new Request('https://w.test/'), s.env, ctx)).json();
  assert.equal(ping.data.version, util.SERVER_VERSION);
  await Promise.all(waits);
  s.bridge.down = true;
  await s.k({ action: 'clientError', where: 'x', code: 'y', message: 'z' });
  await s.settle();
  s.bridge.down = false;
  s.clock.now += 31 * 60000;
  const jobWaits = [];
  await worker.scheduled({}, s.env, { waitUntil: (p) => jobWaits.push(p) });
  await Promise.all(jobWaits);
  assert.equal(await s.pending(), 0, 'the scheduled job sent what was waiting');
});

test('an unexpected failure inside the server is a clean answer and reaches the errors tab', async () => {
  const s = loadWorker();
  await s.k({ action: 'newStory', topic: 'x' });
  await s.env.DB.prepare("UPDATE sessions SET state = '{broken'").run();
  const r = await s.k({ action: 'init' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'server_error');
  await s.settle();
  assert.ok(s.rows('שגיאות').some((row) => row[2] === 'init'));
});

test('the single file to paste into Cloudflare is up to date and works on its own', async () => {
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [new URL('../tools/build-worker.mjs', import.meta.url).pathname, '--check']);
  const bundle = (await import('../worker/dist/worker.js')).default;
  const s = loadWorker(); // the same world (bridge, Gemini, Microsoft); the bundle keeps real time
  const env = { ...s.env, DB: (await import('./d1-shim.mjs')).makeD1() };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (req) => (await bundle.fetch(new Request('https://w.test/', {
    method: 'POST', body: JSON.stringify({ k: s.code, ...req })
  }), env, ctx)).json();
  assert.equal((await call({ action: 'init' })).data.child.name, 'אלין');
  const story = (await call({ action: 'newStory', topic: 'dragons' })).data.story;
  assert.equal(story.pages.length, 5);
  assert.equal((await call({ action: 'startPage', page: 0 })).ok, true);
  const r = await call({ action: 'submitPage', page: 0, words: tokenize(story.pages[0].text).map(() => 'ok'), insertions: 0, attemptId: 'b1', durSec: 30 });
  assert.equal(r.data.attempt.acc, 100);
  await Promise.all(waits);
  assert.equal(s.rows('עמודים').length, 2, 'the row reached the sheet through the bridge');
});

test('makeBridgeSecret keeps a long random secret in the script and the bridge accepts only it', () => {
  const s = loadWorker();
  const secret = s.gas.ctx.makeBridgeSecret();
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(s.gas.props.get('BRIDGE_SECRET'), secret);
  assert.equal(s.gas.api({ action: 'bridgeSettings', secret }).ok, true);
  assert.equal(s.gas.api({ action: 'bridgeSettings', secret: 'old' }).error.code, 'unauthorized');
});
