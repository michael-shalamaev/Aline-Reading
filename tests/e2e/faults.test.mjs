// System tests: the real page + real server code, with the failures real phones meet.
// Run: npm run test:e2e
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, toFirstPage, readPage } from './harness.mjs';
import { tokenize } from '../../js/text.js';

const attemptsOf = (app, i) => app.session().pages[i].attempts;
const savedOk = (app) => app.page.waitForFunction(() =>
  !document.querySelector('#after-result').disabled && document.querySelector('#save-state').textContent === '', null, { timeout: 15000 });
const phoneRows = (app) => app.errorRows().filter((r) => String(r[2]).startsWith('טלפון'));

test('the real incident: reading saved, but Google answered with its HTML page — retried, counted once, reported', async () => {
  const app = await startApp({ fault: (r, n) => (r.action === 'submitPage' && n === 1 ? { html: 'after' } : null) });
  try {
    await toFirstPage(app);
    await readPage(app);
    await savedOk(app);
    assert.equal(attemptsOf(app, 0), 1, 'the retry did not count the page twice');
    await new Promise((r) => setTimeout(r, 500));
    const row = phoneRows(app).find((r) => r[2] === 'טלפון: submitPage (retried)');
    assert.ok(row, 'reported to the errors tab');
    assert.match(row[3], /^server_html/);
    assert.match(row[4], /title "Error"/, 'the details say what Google sent');
    assert.match(row[4], /\[api\]/, 'with the last log lines');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});

test('both tries of saving fail: the result stays, "try again" saves it, still counted once', async () => {
  const app = await startApp({ fault: (r, n) => (r.action === 'submitPage' && n <= 2 ? { html: 'after' } : null) });
  try {
    await toFirstPage(app);
    await readPage(app);
    await app.page.waitForSelector('#save-state.failed .linkish');
    assert.equal(await app.page.isDisabled('#after-result'), true, 'cannot go on before the server confirmed');
    await app.shot('f1-save-failed');
    await app.page.click('#save-state .linkish');
    await savedOk(app);
    assert.equal(attemptsOf(app, 0), 1);
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
    await savedOk(app);
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
    await savedOk(app);
    assert.equal(app.counts.startPage, 2);
    assert.equal(attemptsOf(app, 0), 1);
  } finally { await app.close(); }
});

test('answer lost twice, the app is closed and opened again: continues at the question, nothing lost', async () => {
  const app = await startApp({ fault: (r, n) => (r.action === 'submitPage' && n <= 2 ? { drop: 'after' } : null) });
  try {
    await toFirstPage(app);
    await readPage(app);
    await app.page.waitForSelector('#save-state.failed');
    await app.open();
    await app.screen('question');
    assert.equal(attemptsOf(app, 0), 1);
  } finally { await app.close(); }
});

test('microphone: one server request between "start reading" and listening', async () => {
  const app = await startApp({ fault: (r) => (r.action === 'startPage' ? { delayMs: 1200 } : null) });
  try {
    await toFirstPage(app);
    const before = app.calls.length;
    const t0 = Date.now();
    await app.page.evaluate(() => { window.__fakeReading = { skip: [], mis: [], perWordMs: 200 }; });
    await app.page.click('#go-read');
    await app.page.waitForSelector('#ready-banner:not([hidden])');
    const waited = Date.now() - t0;
    const between = app.calls.slice(before).map((c) => c.action).filter((a) => a !== 'clientError');
    assert.deepEqual(between, ['startPage'], 'no separate token request');
    assert.ok(waited < 2500, `mic ready after ${waited}ms with a 1200ms server`);
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
    await savedOk(app);
    const ms = await answer(app, 1);
    assert.ok(ms < 1000, `feedback after ${ms}ms`);
    assert.match(await app.page.textContent('.feedback'), /נכון/);
    await app.page.click('.next');
    await app.screen('prep');
    await new Promise((r) => setTimeout(r, 6500));
    assert.deepEqual(app.session().pages[0].answered, { choice: 1, correct: true }, 'the server has it');
  } finally { await app.close(); }
});

test('an answer that never reaches the server is asked again before the summary, nothing breaks', async () => {
  // Page 1's answer fails every time; the rest work.
  const app = await startApp({ fault: (r) => (r.action === 'answer' && r.kind === 'page' && r.page === 0 ? { html: 'before' } : null) });
  try {
    await toFirstPage(app);
    for (let i = 0; i < 5; i++) {
      await app.screen('prep');
      await readPage(app);
      await savedOk(app);
      await answer(app, 1);
      await app.page.click('.next');
    }
    for (let f = 0; f < 3; f++) {
      await app.screen('question');
      await app.page.click('.option[data-i="1"]');
      await app.page.waitForSelector('.next:not([hidden])');
      await app.page.click('.next');
    }
    // finish → too_early → the server's view → page 1's question again
    await app.screen('question', 30000);
    assert.match(await app.page.textContent('#q-label'), /עמוד 1/);
    assert.ok(phoneRows(app).some((r) => /resync/.test(r[2])));
  } finally { await app.close(); }
});

test('reading "Natasha" instead of "Mia": marked as another word, one error, kinds listed', async () => {
  const app = await startApp();
  try {
    await toFirstPage(app);
    await readPage(app, { skip: [3], mis: [], replace: { 0: 'Natasha' } });
    await savedOk(app);
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
