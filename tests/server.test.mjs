// Runs the real server code (server/*.gs) against the in-memory mock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadServer } from './gas-mock.mjs';
import { tokenize } from '../js/text.js';

function ready(opts) {
  const s = loadServer(opts);
  s.ctx.setup();
  const settings = s.book().getSheetByName('הגדרות').rows();
  const code = settings.find((r) => r[0] === 'code')[2];
  const link = settings.find((r) => r[0] === 'link')[2];
  return { ...s, code, link, k: (req) => s.api({ k: code, ...req }) };
}

/** Reads every page with the given number of skipped words, answers everything. */
function readAll(s, story, { skipPerPage = 0, extra = false, answer = 1 } = {}) {
  story.pages.forEach((p, i) => {
    assert.equal(s.k({ action: 'startPage', page: i, extra }).ok, true);
    s.clock.now += 60000;
    const n = tokenize(p.text).length;
    const words = Array.from({ length: n }, (_, j) => (j < skipPerPage ? 'om' : 'ok'));
    const r = s.k({ action: 'submitPage', page: i, extra, words, insertions: 0 });
    assert.equal(r.ok, true, JSON.stringify(r));
    s.k({ action: 'answer', kind: 'page', page: i, choice: answer, extra });
  });
  [0, 1, 2].forEach((f) => s.k({ action: 'answer', kind: 'final', index: f, choice: answer, extra }));
  return s.k({ action: 'finish', extra });
}

test('setup builds the sheet, a child, a code and a link', () => {
  const s = ready();
  const names = s.book().getSheets().map((x) => x.name);
  assert.deepEqual(names, ['הגדרות', 'יומן', 'עמודים', 'מילים קשות', 'סיפורים', 'שגיאות']);
  assert.match(s.code, /^[0-9a-f]{12}$/);
  assert.equal(s.link, 'https://michael-shalamaev.github.io/Aline-Reading/?k=' + s.code);
  assert.equal(s.book().getSheetByName('סיפורים').hidden, true);
});

test('wrong code is refused', () => {
  const s = ready();
  const r = s.api({ action: 'init', k: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unauthorized');
});

test('full day: story, pages, questions, pass, mail, log', () => {
  const s = ready();
  const init = s.k({ action: 'init' });
  assert.equal(init.data.child.name, 'אלין');
  assert.equal(init.data.session, null);

  const st = s.k({ action: 'newStory', topic: 'dragons' });
  assert.equal(st.ok, true);
  const story = st.data.story;
  assert.equal(story.pages.length, 5);
  assert.equal(story.pages[0].question.answer, undefined, 'answers never reach the phone');
  assert.deepEqual(story.pages[0].hardWords, ['dragon', 'garden'], 'hard words not in text are dropped');
  assert.ok(s.fetches.some((u) => u.includes('gemini-3.8-flash:generateContent')), 'newest Flash model chosen');

  const fin = readAll(s, story, { skipPerPage: 2 });
  assert.equal(fin.ok, true, JSON.stringify(fin));
  assert.equal(fin.data.result.passed, true);
  assert.equal(fin.data.result.errors, 10);
  assert.equal(fin.data.result.quizCorrect, 8);
  assert.equal(fin.data.extraAllowed, true);

  assert.equal(s.mails.length, 1);
  assert.match(s.mails[0].subject, /עבר/);
  assert.equal(s.mails[0].to, 'dad@example.com');
  const log = s.book().getSheetByName('יומן').rows();
  assert.equal(log.length, 2);
  assert.equal(s.book().getSheetByName('עמודים').rows().length, 6);
  const words = s.book().getSheetByName('מילים קשות').rows();
  assert.ok(words.length > 1);

  const again = s.k({ action: 'init' });
  assert.equal(again.data.session.finished, true);
});

test('too many errors fails the day; questions alone do not block by default', () => {
  const s = ready();
  const story = s.k({ action: 'newStory', topic: 'cats' }).data.story;
  const fin = readAll(s, story, { skipPerPage: 30, answer: 0 });
  assert.equal(fin.data.result.passed, false);
  assert.equal(fin.data.extraAllowed, false);
  assert.match(s.mails[0].subject, /לא עבר/);
});

test('regenerate up to the limit, then locked once reading starts', () => {
  const s = ready();
  s.k({ action: 'newStory', topic: 'a' });
  for (let i = 0; i < 3; i++) assert.equal(s.k({ action: 'newStory', topic: 'b' + i }).ok, true);
  const no = s.k({ action: 'newStory', topic: 'c' });
  assert.equal(no.error.code, 'no_regen_left');

  const s2 = ready();
  s2.k({ action: 'newStory', topic: 'a' });
  s2.k({ action: 'startPage', page: 0 });
  assert.equal(s2.k({ action: 'newStory', topic: 'b' }).error.code, 'locked');
});

test('only the next page can be read; one retry of a weak page; best attempt counts', () => {
  const s = ready();
  const story = s.k({ action: 'newStory', topic: 'x' }).data.story;
  assert.equal(s.k({ action: 'startPage', page: 2 }).error.code, 'page_not_allowed');

  const n = tokenize(story.pages[0].text).length;
  s.k({ action: 'startPage', page: 0 });
  s.clock.now += 60000;
  const weak = s.k({ action: 'submitPage', page: 0, words: Array(n).fill('om'), insertions: 0 }).data;
  assert.equal(weak.below, true);
  assert.equal(weak.canRetry, true);

  assert.equal(s.k({ action: 'startPage', page: 0 }).ok, true);
  s.clock.now += 60000;
  const good = s.k({ action: 'submitPage', page: 0, words: Array(n).fill('ok'), insertions: 0 }).data;
  assert.equal(good.canRetry, false);
  assert.equal(good.best.acc, 100);
  assert.equal(s.k({ action: 'startPage', page: 0 }).error.code, 'page_not_allowed', 'no third attempt');
});

test('wrong word count from the phone is refused', () => {
  const s = ready();
  s.k({ action: 'newStory', topic: 'x' });
  s.k({ action: 'startPage', page: 0 });
  const r = s.k({ action: 'submitPage', page: 0, words: ['ok'], insertions: 0 });
  assert.equal(r.error.code, 'bad_payload');
});

test('time window runs out: progress resets, parent gets a mail', () => {
  const s = ready();
  const story = s.k({ action: 'newStory', topic: 'x' }).data.story;
  const n = tokenize(story.pages[0].text).length;
  s.k({ action: 'startPage', page: 0 });
  s.clock.now += 60000;
  s.k({ action: 'submitPage', page: 0, words: Array(n).fill('ok'), insertions: 0 });
  s.clock.now += 61 * 60000;
  const r = s.k({ action: 'startPage', page: 1 });
  assert.equal(r.data.expired, true);
  assert.equal(r.data.session.pages[0].best, null);
  assert.equal(r.data.session.story.title, story.title, 'same story');
  assert.match(s.mails[0].subject, /חלון הזמן/);
  assert.equal(s.k({ action: 'startPage', page: 0 }).ok, true);
});

test('pace check flags very fast reading', () => {
  const s = ready();
  const story = s.k({ action: 'newStory', topic: 'x' }).data.story;
  story.pages.forEach((p, i) => {
    s.k({ action: 'startPage', page: i });
    s.clock.now += 5000;
    s.k({ action: 'submitPage', page: i, words: Array(tokenize(p.text).length).fill('ok'), insertions: 0 });
    s.k({ action: 'answer', kind: 'page', page: i, choice: 1 });
  });
  [0, 1, 2].forEach((f) => s.k({ action: 'answer', kind: 'final', index: f, choice: 1 }));
  const r = s.k({ action: 'finish' }).data.result;
  assert.ok(r.flags.some((f) => f.includes('קצב')));
});

test('next day starts a new story', () => {
  const s = ready();
  s.k({ action: 'newStory', topic: 'x' });
  s.setNow('2026-10-07T08:00:00+03:00');
  assert.equal(s.k({ action: 'init' }).data.session, null);
});

test('extra story only after passing, without questions by default', () => {
  const s = ready();
  assert.equal(s.k({ action: 'newStory', topic: 'x', extra: true }).error.code, 'extra_not_allowed');
  const story = s.k({ action: 'newStory', topic: 'x' }).data.story;
  readAll(s, story);
  const ex = s.k({ action: 'newStory', topic: 'more', extra: true });
  assert.equal(ex.ok, true);
  assert.equal(ex.data.questions, false);
  story.pages.forEach((p, i) => {
    s.k({ action: 'startPage', page: i, extra: true });
    s.clock.now += 60000;
    s.k({ action: 'submitPage', page: i, extra: true, words: Array(tokenize(p.text).length).fill('ok'), insertions: 0 });
  });
  const fin = s.k({ action: 'finish', extra: true });
  assert.equal(fin.ok, true, JSON.stringify(fin));
  const init = s.k({ action: 'init' });
  assert.equal(init.data.session.finished, true);
  assert.equal(init.data.extraSession, null, 'finished extra is not resumed');
});

test('a busy model is skipped: the next model writes the story', () => {
  const s = ready({ busyModels: ['gemini-3.8-flash'] });
  const r = s.k({ action: 'newStory', topic: 'x' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const tried = s.fetches.filter((f) => f.startsWith('model:'));
  assert.deepEqual(tried, ['model:gemini-3.8-flash', 'model:gemini-3.7-flash']);
});

test('all models busy: a clear error, one round only, logged', () => {
  const s = ready({ busyModels: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.8-flash-lite'] });
  const r = s.k({ action: 'newStory', topic: 'x' });
  assert.equal(r.error.code, 'gemini_busy');
  assert.equal(s.fetches.filter((f) => f.startsWith('model:')).length, 3);
  assert.equal(s.book().getSheetByName('שגיאות').rows().length, 2);
});

test('a one-off server error moves on to the next model', () => {
  const s = ready({ geminiFailures: 1 });
  assert.equal(s.k({ action: 'newStory', topic: 'x' }).ok, true);
});

test('a story with the wrong page count is rejected', () => {
  const s = ready({ wrongPages: true });
  const r = s.k({ action: 'newStory', topic: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'bad_story');
});

test('speech token is reused for 5 minutes and reports time left', () => {
  const s = ready();
  const a = s.k({ action: 'speechToken' }).data;
  s.clock.now += 120000;
  const b = s.k({ action: 'speechToken' }).data;
  assert.equal(a.token, b.token);
  assert.equal(b.ttlSec, 480);
  assert.equal(b.region, 'westeurope');
});

test('settings changes in the sheet apply (e.g. pages and error mode)', () => {
  const s = ready();
  const sh = s.book().getSheetByName('הגדרות');
  const rows = sh.rows();
  rows.find((r) => r[0] === 'pages')[2] = 3;
  rows.find((r) => r[0] === 'passMode')[2] = 'שגיאות';
  rows.find((r) => r[0] === 'maxErrors')[2] = 5;
  s.ctx.clearSettingsCache();
  const story = s.k({ action: 'newStory', topic: 'x' }).data.story;
  assert.equal(story.pages.length, 3);
  const fin = readAll(s, story, { skipPerPage: 2 });
  assert.equal(fin.data.result.errors, 6);
  assert.equal(fin.data.result.passed, false);
});

test('selfTest reports every check', () => {
  const s = ready();
  const report = s.ctx.selfTest();
  assert.equal(report.filter((l) => l.startsWith('❌')).length, 0, report.join('\n'));
});

test('a reading sent twice (lost answer, phone retries) counts once', () => {
  const s = ready();
  const story = s.k({ action: 'newStory', topic: 'x' }).data.story;
  const st = s.k({ action: 'startPage', page: 0 }).data;
  assert.equal(st.speech.region, 'westeurope', 'the speech token comes with startPage');
  s.clock.now += 60000;
  const words = Array(tokenize(story.pages[0].text).length).fill('om');
  const a = s.k({ action: 'submitPage', page: 0, words, insertions: 0, attemptId: 'r1' }).data;
  const b = s.k({ action: 'submitPage', page: 0, words, insertions: 0, attemptId: 'r1' }).data;
  assert.deepEqual(a, b);
  assert.equal(b.canRetry, true, 'the retry is still available');
  assert.equal(s.book().getSheetByName('עמודים').rows().length, 2, 'logged once');
});

test('pronunciation sensitivity: in the settings, sent to the page, added to older sheets', () => {
  const s = ready();
  assert.equal(s.k({ action: 'init' }).data.child.pronThreshold, 55);
  const sh = s.book().getSheetByName('הגדרות');
  sh.data = sh.data.filter((r) => r[0] !== 'pronThreshold');
  s.ctx.setup();
  assert.ok(sh.rows().some((r) => r[0] === 'pronThreshold' && r[2] === 55));
});

/* ---------- speed: how much Google work each request does (see COST_MS in gas-mock) ---------- */

function dayWithOldRows(opts) {
  const s = ready(opts);
  const tab = s.book().getSheetByName('סיפורים');
  // Two months of earlier stories, each with a big story text.
  for (let d = 0; d < 60; d++) {
    tab.appendRow(['old' + d, 'אלין', '2026-08-01', 'לא', 'עבר', 't', 'T', new Date(), JSON.stringify({ pad: 'x'.repeat(6000) }), '{"finished":true}']);
  }
  const story = s.k({ action: 'newStory', topic: 'dragons' }).data.story;
  return { s, story };
}

test('speed: reading a page opens the sheet once, writes once, never reads old stories', () => {
  const { s, story } = dayWithOldRows();
  const words = tokenize(story.pages[0].text).map(() => 'ok');
  for (const req of [
    { action: 'startPage', page: 0 },
    { action: 'submitPage', page: 0, words, insertions: 0, attemptId: 'a1' },
    { action: 'answer', kind: 'page', page: 0, choice: 1 }
  ]) {
    s.clock.now += 30000;
    const m = s.measure({ k: s.code, ...req });
    assert.equal(m.res.ok, true, req.action + ' ' + JSON.stringify(m.res.error));
    assert.equal(m.calls.open, 1, req.action + ': sheet opened once');
    assert.equal(m.calls.write || 0, 1, req.action + ': one write for the session');
    assert.ok(m.ms < 1800, `${req.action}: estimated ${m.ms}ms`);
    assert.ok(m.lockedMs < 1000, `${req.action}: ${m.lockedMs}ms while holding the lock`);
  }
});

test('speed: the Microsoft token is fetched outside the lock', () => {
  const { s } = dayWithOldRows();
  s.cache.delete('speech_token');
  const m = s.measure({ k: s.code, action: 'startPage', page: 0 });
  assert.equal(m.calls.fetch, 1);
  assert.ok(m.res.data.speech.token);
  assert.ok(m.lockedMs < 1000, `${m.lockedMs}ms in lock`);
});

test('speed: settings are read from the sheet at most once in 10 minutes', () => {
  const s = ready();
  s.k({ action: 'init' });
  s.clock.now += 9 * 60000;
  const m = s.measure({ k: s.code, action: 'init' });
  assert.equal(m.calls.open, 1, 'only for the session, not for settings');
});

test('a stale remembered row (parent deleted a row) still finds the right session', () => {
  const { s, story } = dayWithOldRows();
  const tab = s.book().getSheetByName('סיפורים');
  tab.data.splice(5, 1); // a row above today's disappears; today's row moves up
  const r = s.k({ action: 'startPage', page: 0 });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const init = s.k({ action: 'init' });
  assert.equal(init.data.session.story.title, story.title);
  assert.equal(init.data.session.locked, true);
});

test('every answer says how long the server worked and waited for the lock', () => {
  const s = ready();
  s.clock.now += 1;
  const r = s.k({ action: 'init' });
  assert.equal(typeof r.ms, 'number');
  assert.equal(typeof r.lockMs, 'number');
  const bad = s.k({ action: 'startPage', page: 3 });
  assert.equal(typeof bad.ms, 'number');
});

test('lock not free: a clear JSON "busy" answer, logged', () => {
  const s = ready({ lockBusy: true });
  const r = s.k({ action: 'init' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'busy');
  assert.match(s.book().getSheetByName('שגיאות').rows().at(-1)[3], /busy/);
});

test('if writing the log row fails, the attempt is still saved and answered', () => {
  const { s, story } = dayWithOldRows();
  s.k({ action: 'startPage', page: 0 });
  s.ctx.logPageAttempt = () => { throw new Error('sheet hiccup'); };
  const words = tokenize(story.pages[0].text).map(() => 'ok');
  const r = s.k({ action: 'submitPage', page: 0, words, insertions: 0, attemptId: 'z' });
  assert.equal(r.ok, true);
  assert.equal(s.k({ action: 'init' }).data.session.pages[0].attempts, 1);
});

test('an error on the phone becomes a row in the errors tab, cut to size', () => {
  const s = ready();
  const r = s.k({ action: 'clientError', where: 'startPage', code: 'server_html', message: 'HTTP 200', details: 'x'.repeat(9000) });
  assert.equal(r.ok, true);
  const row = s.book().getSheetByName('שגיאות').rows().at(-1);
  assert.equal(row[2], 'טלפון: startPage');
  assert.equal(row[3], 'server_html: HTTP 200');
  assert.equal(row[4].length, 4000);
  assert.equal(s.api({ action: 'clientError', k: 'bad' }).error.code, 'unauthorized');
});

test('"another word" is counted once, kept with what was said, and shown in the logs', () => {
  const s = ready();
  const story = s.k({ action: 'newStory', topic: 'dragons' }).data.story;
  s.k({ action: 'startPage', page: 0 });
  const words = tokenize(story.pages[0].text).map(() => 'ok');
  words[0] = 'sub';
  words[1] = 'om';
  const r = s.k({ action: 'submitPage', page: 0, words, insertions: 0, said: { 0: 'natasha' }, attemptId: 'q' });
  assert.equal(r.data.attempt.errors, 2);
  assert.equal(r.data.attempt.sub, 1);
  assert.deepEqual(r.data.errWords[0], { w: tokenize(story.pages[0].text)[0], t: 'sub', said: 'natasha' });
  const row = s.book().getSheetByName('עמודים').rows().at(-1);
  assert.match(row[15], /מילה אחרת: natasha/);
  assert.equal(row[16], 1);
});

test('questions reach the phone with a key that checks the answer, never the answer itself', () => {
  const s = ready();
  const sess = s.k({ action: 'newStory', topic: 'dragons' }).data;
  const q = sess.story.pages[0].question;
  assert.equal(q.answer, undefined);
  assert.equal(q.key, s.ctx.answerKey(sess.id, 'p0', 1)); // the mock story's answer is option 1
  assert.equal(sess.story.finalQuestions[2].key, s.ctx.answerKey(sess.id, 'f2', 1));
});
