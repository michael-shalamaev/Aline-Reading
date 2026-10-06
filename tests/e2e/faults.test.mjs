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
