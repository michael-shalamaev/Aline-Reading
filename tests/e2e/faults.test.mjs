// System tests: the real page + real server code, with the failures real phones meet.
// Run: npm run test:e2e
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, toFirstPage, readPage } from './harness.mjs';
import { tokenize } from '../../js/text.js';

const attemptsOf = (app, i) => app.session().pages[i].attempts;
const savedOk = (app) => app.page.waitForFunction(() =>
  !document.querySelector('#after-result').disabled && document.querySelector('#save-state').textContent === '', null, { timeout: 15000 });
/** Waits (up to 15 s) until the server's state satisfies check. */
async function until(check, what) {
  for (let t = 0; t < 150; t++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('timed out waiting for: ' + what);
}
const phoneRows = (app) => app.errorRows().filter((r) => String(r[2]).startsWith('טלפון'));

test('the real incident: reading saved, but Google answered with its HTML page — retried, counted once, reported', async () => {
  const app = await startApp({ fault: (r, n) => (r.action === 'submitPage' && n === 1 ? { html: 'after' } : null) });
  try {
    await toFirstPage(app);
    await readPage(app);
    await until(() => attemptsOf(app, 0) === 1, 'saved');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(attemptsOf(app, 0), 1, 'the retry did not count the page twice');
    const row = phoneRows(app).find((r) => r[2] === 'טלפון: submitPage (retried)');
    assert.ok(row, 'reported to the errors tab');
    assert.match(row[3], /^server_html/);
    assert.match(row[4], /title "Error"/, 'the details say what Google sent');
    assert.match(row[4], /\[api\]/, 'with the last log lines');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('saving keeps trying in the background while she goes on; counted once', async () => {
  const app = await startApp({ fault: (r, n) => (r.action === 'submitPage' && n <= 3 ? { html: 'after' } : null) });
  try {
    await toFirstPage(app);
    await readPage(app);
    assert.equal(await app.page.isDisabled('#after-result'), false, 'no waiting for the server');
    await app.page.click('#after-result');
    await app.screen('question');
    await until(() => app.counts.submitPage >= 4, 'tried until the answer came through');
    assert.equal(attemptsOf(app, 0), 1);
  } finally { await app.close(); }
});

test('going on before the save is done: the next page waits its turn, nothing out of step', async () => {
  const app = await startApp({ timeoutMs: 15000, fault: (r) => (r.action === 'submitPage' ? { delayMs: 2500 } : null) });
  try {
    await toFirstPage(app);
    await readPage(app);
    const t0 = Date.now();
    await app.page.click('#after-result');
    await app.screen('question');
    await app.page.click('.option[data-i="1"]');
    await app.page.waitForSelector('.next:not([hidden])');
    assert.ok(Date.now() - t0 < 1500, 'no waiting between result, question and answer');
    await app.page.click('.next');
    await app.screen('prep');
    await readPage(app);
    await until(() => attemptsOf(app, 1) === 1, 'page 2 saved');
    assert.equal(attemptsOf(app, 0), 1);
    assert.deepEqual(app.session().pages[0].answered, { choice: 1, correct: true });
    assert.equal(phoneRows(app).length, 0, 'no errors at all');
  } finally { await app.close(); }
});

test('a reading that can never be saved: she is brought back to that page, not stuck', async () => {
  const app = await startApp({ fault: (r) => (r.action === 'submitPage' && r.page === 0 ? { html: 'before' } : null) });
  try {
    await toFirstPage(app);
    await readPage(app);
    await app.page.click('#after-result');
    await app.screen('question');
    await app.page.click('.option[data-i="1"]');
    await app.page.waitForSelector('.next:not([hidden])');
    await app.page.click('.next');
    await app.screen('prep');
    await app.page.click('#go-read');
    // page 2 cannot start while page 1 is not saved → back to where the server is: page 1
    await app.page.waitForFunction(() => /עמוד 1 /.test(document.querySelector('#prep-label')?.textContent || '') &&
      !document.querySelector('[data-screen="prep"]').hidden, null, { timeout: 40000 });
    assert.notEqual(await app.visible(), 'error');
  } finally { await app.close(); }
});

test('starting a page fails twice: error screen, "try again" asks the server and the page starts', async () => {
  const app = await startApp({ fault: (r, n) => (r.action === 'startPage' && n <= 2 ? { html: 'after' } : null) });
  try {
    await toFirstPage(app);
    await app.page.click('#go-read');
    await app.screen('error');
    assert.match(await app.page.textContent('#error-text'), /גוגל/);
    await app.shot('f2-error-html');
    const inits = app.counts.init;
    await app.page.click('#error-retry');
    await app.screen('prep');
    assert.equal(app.counts.init, inits + 1, 'went back to the server for the state');
    await readPage(app);
    await until(() => attemptsOf(app, 0) === 1, 'saved');
    const where = phoneRows(app).map((r) => r[2]);
    assert.ok(where.includes('טלפון: startPage'), 'the error screen itself was reported: ' + where);
  } finally { await app.close(); }
});

test('out of step (page already read elsewhere / answer lost): no error screen, continues where the server is', async () => {
  const app = await startApp();
  try {
    await toFirstPage(app);
    // Page 1 is read and saved, but the phone never heard back.
    app.server.api({ action: 'startPage', page: 0, k: app.code });
    const words = tokenize(app.session().story.pages[0].text).map(() => 'ok');
    app.server.api({ action: 'submitPage', page: 0, k: app.code, words, insertions: 0 });
    assert.equal(app.session().pages[0].attempts, 1);
    await app.page.click('#go-read');
    await app.screen('question');
    assert.notEqual(await app.visible(), 'error');
    const row = phoneRows(app).find((r) => /resync/.test(r[2]));
    assert.ok(row && /page_not_allowed/.test(row[3]), 'reported as a resync');
  } finally { await app.close(); }
});

test('slow server: first try times out, second works; the page counts once', async () => {
  const app = await startApp({
    timeoutMs: 1500,
    fault: (r, n) => (r.action === 'startPage' && n === 1 ? { delayMs: 2200 } : null)
  });
  try {
    await toFirstPage(app);
    await readPage(app);
    await until(() => attemptsOf(app, 0) === 1, 'saved');
    assert.equal(app.counts.startPage, 2);
    assert.equal(attemptsOf(app, 0), 1);
  } finally { await app.close(); }
});

test('answer lost every time, the app is closed and opened again: continues at the question, nothing lost', async () => {
  const app = await startApp({ fault: (r) => (r.action === 'submitPage' ? { drop: 'after' } : null) });
  try {
    await toFirstPage(app);
    await readPage(app);
    await until(() => attemptsOf(app, 0) === 1, 'the server has it, though the phone never heard');
    await app.open();
    await app.screen('question');
    assert.equal(attemptsOf(app, 0), 1);
  } finally { await app.close(); }
});

test('microphone: listens at once, without waiting for a slow server; the reading is saved after it answers', async () => {
  const app = await startApp({ timeoutMs: 15000, fault: (r) => (r.action === 'startPage' ? { delayMs: 5000 } : null) });
  try {
    await toFirstPage(app);
    await new Promise((r) => setTimeout(r, 300)); // the token prefetched on this screen
    const t0 = Date.now();
    await app.page.evaluate(() => { window.__fakeReading = { skip: [], mis: [], perWordMs: 20 }; });
    await app.page.click('#go-read');
    await app.page.waitForSelector('#ready-banner:not([hidden])');
    const waited = Date.now() - t0;
    assert.ok(waited < 1500, `mic ready after ${waited}ms with a 5000ms server`);
    await app.screen('result');
    await until(() => attemptsOf(app, 0) === 1, 'saved after the slow start');
    assert.ok(app.session().pages[0].best.durSec >= 1, 'duration measured on the phone');
  } finally { await app.close(); }
});

test('the server cannot start the page while she already reads: listening stops, error screen, nothing saved', async () => {
  const app = await startApp({ fault: (r) => (r.action === 'startPage' ? { delayMs: 400, html: 'before' } : null) });
  try {
    await toFirstPage(app);
    await app.page.evaluate(() => { window.__fakeReading = { skip: [], mis: [], perWordMs: 300 }; });
    await app.page.click('#go-read');
    await app.screen('error');
    assert.equal(attemptsOf(app, 0), 0);
  } finally { await app.close(); }
});

test('Microsoft drops the connection mid-page: the child is told, and it is reported', async () => {
  const app = await startApp();
  try {
    await toFirstPage(app);
    await app.page.evaluate(() => { window.__fakeReading = { skip: [], mis: [], cancelAt: 5 }; });
    await app.page.click('#go-read');
    await app.page.waitForFunction(() => /נקטעה/.test(document.querySelector('#mic-state').textContent));
    await app.shot('f3-speech-dropped');
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(phoneRows(app).some((r) => r[2] === 'טלפון: reading: speech stopped'));
  } finally { await app.close(); }
});

test('an error report that could not be sent waits on the phone and goes later', async () => {
  const app = await startApp({
    fault: (r, n) => {
      if (r.action === 'startPage' && n <= 2) return { html: 'before' };
      if (r.action === 'clientError' && n <= 2) return { drop: 'before' };
      return null;
    }
  });
  try {
    await toFirstPage(app);
    await app.page.click('#go-read');
    await app.screen('error');
    assert.equal(phoneRows(app).length, 0, 'not sent yet');
    await app.page.click('#error-retry');
    await app.screen('preview'); // the page never started on the server, so back to the story preview
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(phoneRows(app).length >= 1, 'sent after the next successful start');
  } finally { await app.close(); }
});

/** From a page's result to its question, answered with option `choice`; returns ms until feedback. */
async function answer(app, choice) {
  await app.page.click('#after-result');
  await app.screen('question');
  const t0 = Date.now();
  await app.page.click(`.option[data-i="${choice}"]`);
  await app.page.waitForSelector('.next:not([hidden])');
  return Date.now() - t0;
}

test('questions: right/wrong shows at once even when the server takes 6 seconds; saved in the background', async () => {
  const app = await startApp({ timeoutMs: 15000, fault: (r) => (r.action === 'answer' ? { delayMs: 6000 } : null) });
  try {
    await toFirstPage(app);
    await readPage(app);
    const ms = await answer(app, 1);
    assert.ok(ms < 1000, `feedback after ${ms}ms`);
    assert.match(await app.page.textContent('.feedback'), /נכון/);
    await app.page.click('.next');
    await app.screen('prep');
    await new Promise((r) => setTimeout(r, 6500));
    assert.deepEqual(app.session().pages[0].answered, { choice: 1, correct: true }, 'the server has it');
  } finally { await app.close(); }
});

test('an answer whose every save fails goes along with summing up: not asked again, summary shown', async () => {
  // Page 1's answer fails every time on its own; the rest work.
  const app = await startApp({ fault: (r) => (r.action === 'answer' && r.kind === 'page' && r.page === 0 ? { html: 'before' } : null) });
  try {
    await toFirstPage(app);
    for (let i = 0; i < 5; i++) {
      await app.screen('prep');
      await readPage(app);
      await answer(app, 1);
      await app.page.click('.next');
    }
    for (let f = 0; f < 3; f++) {
      await app.screen('question');
      await app.page.click('.option[data-i="1"]');
      await app.page.waitForSelector('.next:not([hidden])');
      await app.page.click('.next');
    }
    await app.screen('summary', 40000);
    assert.deepEqual(app.session().pages[0].answered, { choice: 1, correct: true });
  } finally { await app.close(); }
});

test('reading "Natasha" instead of "Mia": marked as another word, one error, kinds listed', async () => {
  const app = await startApp();
  try {
    await toFirstPage(app);
    await readPage(app, { skip: [3], mis: [], replace: { 0: 'Natasha' } });
    await until(() => attemptsOf(app, 0) === 1, 'saved');
    const cls = await app.page.$eval('#result-text .w[data-i="0"]', (e) => e.className);
    assert.match(cls, /st-sub/);
    assert.match(await app.page.$eval('#result-text .w[data-i="3"]', (e) => e.className), /st-om/);
    assert.equal(await app.page.textContent('#result-kinds'), '1 דילוג · 1 מילה אחרת');
    await app.shot('f4-another-word');
    const a = app.session().pages[0].best;
    assert.equal(a.sub, 1);
    assert.equal(a.errors, 2);
  } finally { await app.close(); }
});

test('summing up: Google returns its error page though the story was finished — the summary still shows', async () => {
  const app = await startApp({ fault: (r, n) => (r.action === 'finish' && n === 1 ? { html: 'after' } : null) });
  try {
    await toFirstPage(app);
    // Everything but the last question is done (as if read on this phone earlier).
    const k = app.code;
    const st = app.session().story;
    st.pages.forEach((pg, i) => {
      app.server.api({ action: 'startPage', page: i, k });
      app.server.api({ action: 'submitPage', page: i, k, words: tokenize(pg.text).map(() => 'ok'), insertions: 0, attemptId: 'x' + i });
      app.server.api({ action: 'answer', kind: 'page', page: i, choice: 1, k });
    });
    [0, 1].forEach((f) => app.server.api({ action: 'answer', kind: 'final', index: f, choice: 1, k }));
    await app.open();
    await app.screen('question');
    await app.page.click('.option[data-i="1"]');
    await app.page.waitForSelector('.next:not([hidden])');
    await app.page.click('.next');
    await app.screen('summary', 20000);
    assert.equal(app.server.mails.length, 1, 'one mail, not two');
  } finally { await app.close(); }
});

test('the countdown clock: a slow answer from Google does not move it', async () => {
  const skew = 5 * 60000; // the phone's clock is 5 minutes behind the server's
  const app = await startApp({
    timeoutMs: 15000,
    realClockSkewMs: skew,
    fault: (r) => (r.action === 'startPage' ? { delayAfterMs: 4000 } : null)
  });
  try {
    await toFirstPage(app);
    const offset = () => app.page.evaluate(async () => (await import('/js/api.js')).serverNow() - Date.now());
    const before = await offset();
    assert.ok(Math.abs(before - skew) < 1000, `offset ${before}`);
    // A slow reading; the page's start answer comes back 4 seconds after the server's time.
    await app.page.evaluate(() => { window.__fakeReading = { skip: [], mis: [], perWordMs: 150 }; });
    await app.page.click('#go-read');
    await new Promise((r) => setTimeout(r, 5000));
    const after = await offset();
    assert.ok(Math.abs(after - skew) < 1000, `offset moved to ${after} (error ${after - skew}ms)`);
  } finally { await app.close(); }
});

test('final answers that failed to save are sent again before summing up; the questions are not asked twice', async () => {
  let finalTries = 0;
  const app = await startApp({
    fault: (r) => (r.action === 'answer' && r.kind === 'final' && ++finalTries <= 18 ? { html: 'before' } : null)
  });
  try {
    await toFirstPage(app);
    const k = app.code;
    const st = app.session().story;
    st.pages.forEach((pg, i) => {
      app.server.api({ action: 'startPage', page: i, k });
      app.server.api({ action: 'submitPage', page: i, k, words: tokenize(pg.text).map(() => 'ok'), insertions: 0, attemptId: 'x' + i });
      app.server.api({ action: 'answer', kind: 'page', page: i, choice: 1, k });
    });
    await app.open();
    const asked = [];
    for (let f = 0; f < 3; f++) {
      await app.screen('question');
      asked.push(await app.page.textContent('#q-label'));
      await app.page.click('.option[data-i="1"]');
      await app.page.waitForSelector('.next:not([hidden])');
      await app.page.click('.next');
    }
    await app.screen('summary', 40000);
    assert.equal(asked.length, 3);
    assert.ok(app.session().finalAnswers.every((a) => a && a.choice === 1));
  } finally { await app.close(); }
});

test('a topic Gemini refuses: back to choosing a topic with a clear message, then another topic works', async () => {
  const app = await startApp({ serverOpts: { blockTopic: 'אח ואחות' } });
  try {
    await app.open();
    await app.screen('topic');
    await app.page.fill('#topic', 'על יחסים של אח ואחות');
    await app.page.click('#make-story');
    await app.page.waitForFunction(() => /לא הסכים/.test(document.querySelector('#regen-info').textContent));
    assert.equal(await app.visible(), 'topic');
    await app.shot('f5-topic-blocked');
    await app.page.fill('#topic', 'a brother and a sister build a treehouse');
    await app.page.click('#make-story');
    await app.screen('preview');
  } finally { await app.close(); }
});

test('Google hands back the answer to an empty request (a ping) instead of summing up: retried, summary shows', async () => {
  const app = await startApp({
    fault: (r, n) => (r.action === 'finish' && n === 1 ? { replace: () => app.server.api({ action: 'ping' }) } : null)
  });
  try {
    await toFirstPage(app);
    const k = app.code;
    const st = app.session().story;
    st.pages.forEach((pg, i) => {
      app.server.api({ action: 'startPage', page: i, k });
      app.server.api({ action: 'submitPage', page: i, k, words: tokenize(pg.text).map(() => 'ok'), insertions: 0, attemptId: 'x' + i });
      app.server.api({ action: 'answer', kind: 'page', page: i, choice: 1, k });
    });
    [0, 1].forEach((f) => app.server.api({ action: 'answer', kind: 'final', index: f, choice: 1, k }));
    await app.open();
    await app.screen('question');
    await app.page.click('.option[data-i="1"]');
    await app.page.waitForSelector('.next:not([hidden])');
    await app.page.click('.next');
    await app.screen('summary', 20000);
    assert.match(await app.page.textContent('#summary-body'), /דיוק/);
    assert.ok(phoneRows(app).some((r) => /wrong_answer/.test(r[3])), 'reported');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('reading a phrase again is no error; words not in the text are listed under the result', async () => {
  const app = await startApp();
  try {
    await toFirstPage(app);
    // After word 7 she goes back and reads words 4-7 again, and later says two words that are not in the text.
    const ref = tokenize(app.session().story.pages[0].text).map((w) => w.toLowerCase());
    await readPage(app, { skip: [], mis: [], insert: { 7: ref.slice(4, 8), 20: ['banana', 'robot'] } });
    assert.equal(await app.page.textContent('#result-kinds'), '2 מילים נוספות');
    assert.match(await app.page.textContent('#result-extra'), /banana, robot/);
    await app.shot('f6-extra-words');
  } finally { await app.close(); }
});
