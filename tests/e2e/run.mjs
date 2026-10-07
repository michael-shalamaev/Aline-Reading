// Browser walk-through of a whole day, with the real page and the real server code.
// The server runs in the in-memory mock; Microsoft is replaced by fake-speech-sdk.js.
// Run: node tests/e2e/run.mjs   (needs Playwright; screenshots go to tests/e2e/shots/)

import { startApp, BACKEND } from './harness.mjs';

// Like the real phone saw once: the story is saved, but the answer that comes back is the ping.
const app = await startApp({
  timeoutMs: 60000,
  fault: (r, n) => (r.action === 'newStory' && n === 1
    ? { replace: () => ({ ok: true, a: 'ping', v: 'x', t: Date.now(), data: { version: 'x', time: new Date().toISOString() } }) }
    : null)
});
const { page, errors } = app;
const shot = app.shot;
const screen = app.screen;
console.log('server:', BACKEND);

await app.open();
await screen('topic');
await shot('01-topic');

await page.fill('#topic', 'a dragon who loves pizza');
await page.click('#make-story');
await screen('preview');
await shot('02-preview');

await page.click('#start-reading');
const pages = await page.evaluate(() => document.querySelector('#prep-label').textContent);
console.log('prep:', pages);

for (let i = 0; i < 5; i++) {
  await screen('prep');
  if (i === 0) await shot('03-prep');
  // Page 2 is read badly, then retried well.
  await page.evaluate((bad) => { window.__fakeReading = bad ? { skip: Array.from({ length: 40 }, (_, k) => k) } : { skip: [3, 9], mis: [5] }; }, i === 1);
  await page.click('#go-read');
  await screen('reading');
  if (i === 0) {
    await page.waitForTimeout(700);
    await shot('04-reading');
  }
  if (i === 1) {
    // A badly read page may not reach the last word: the child presses "done".
    await page.waitForTimeout(2500);
    await page.click('#done-reading');
  }
  await screen('result');
  if (i === 0) await shot('05-result');
  if (i === 1) {
    await shot('06-result-weak');
    await page.evaluate(() => { window.__fakeReading = { skip: [], mis: [] }; });
    await page.click('#retry-btn');
    await screen('result');
    console.log('retry result:', await page.textContent('#result-score'));
  }
  await page.click('#after-result');
  await screen('question');
  if (i === 0) await shot('07-question');
  await page.click('.option[data-i="1"]');
  await page.waitForSelector('.next:not([hidden])');
  if (i === 0) await shot('08-answered');
  await page.click('.next');
}

for (let f = 0; f < 3; f++) {
  await screen('question');
  await page.click('.option[data-i="2"]');
  await page.waitForSelector('.next:not([hidden])');
  await page.click('.next');
}
await screen('summary');
await shot('09-summary');

const result = await page.textContent('#summary-body');
console.log('summary:', result.replace(/\s+/g, ' '));
console.log('mail:', (await app.mails()).map((m) => m.subject));
console.log('page errors:', errors.length ? errors : 'none');

// Reload mid-day: the finished day shows its summary again.
await page.reload();
await screen('summary');
console.log('after reload: summary shown');

await app.close();
if (errors.length) process.exit(1);
