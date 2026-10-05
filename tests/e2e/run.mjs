// Browser walk-through of a whole day, with the real page and the real server code.
// The server runs in the in-memory mock; Microsoft is replaced by fake-speech-sdk.js.
// Run: node tests/e2e/run.mjs   (needs Playwright; screenshots go to tests/e2e/shots/)

import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadServer } from '../gas-mock.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const root = new URL('../../', import.meta.url);
const shots = new URL('./shots/', import.meta.url);
mkdirSync(shots, { recursive: true });

const server = loadServer();
server.ctx.setup();
const code = server.book().getSheetByName('הגדרות').rows().find((r) => r[0] === 'code')[2];

const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json' };

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'he-IL' });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); if (process.env.VERBOSE) console.log('  [page]', m.text().slice(0, 200)); });

await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.host === 'script.test') {
    server.clock.now += 40000;
    const res = server.api(JSON.parse(route.request().postData()));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(res) });
  }
  if (url.host === 'app.test') {
    let path = url.pathname.replace(/^\//, '') || 'index.html';
    let body = readFileSync(new URL(path, root), 'utf8');
    if (path === 'js/config.js') body = body.replace(/SCRIPT_URL = '[^']*'/, "SCRIPT_URL = 'https://script.test/exec'");
    return route.fulfill({ contentType: TYPES[path.split('.').pop()] || 'text/plain', body });
  }
  if (url.pathname.endsWith('speech.sdk.bundle-min.js')) {
    return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL('./fake-speech-sdk.js', import.meta.url), 'utf8') });
  }
  return route.abort();
});

await page.addInitScript(() => {
  window.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [], onvoiceschanged: null };
  window.SpeechSynthesisUtterance = function () {};
});

const shot = (name) => page.screenshot({ path: new URL(name + '.png', shots).pathname, fullPage: true });
const screen = (name) => page.waitForSelector(`[data-screen="${name}"]:not([hidden])`, { timeout: 15000 });

await page.goto(`http://app.test/?k=${code}`);
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
console.log('mail:', server.mails.map((m) => m.subject));
console.log('page errors:', errors.length ? errors : 'none');

// Reload mid-day: the finished day shows its summary again.
await page.reload();
await screen('summary');
console.log('after reload: summary shown');

await browser.close();
if (errors.length) process.exit(1);
