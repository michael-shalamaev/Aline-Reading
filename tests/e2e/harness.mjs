// harness.mjs — runs the real page in Chromium against the real server code (in the
// in-memory mock), with Microsoft replaced by fake-speech-sdk.js. Faults can be injected
// per request to copy what real phones see: slow answers, Google's HTML error page,
// answers lost after the server already saved.

import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadServer } from '../gas-mock.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const root = new URL('../../', import.meta.url);
const shots = new URL('./shots/', import.meta.url);
mkdirSync(shots, { recursive: true });
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', webmanifest: 'application/json' };

// What Google sends when the script did not answer properly (shortened real page).
export const GOOGLE_ERROR_PAGE = '<!DOCTYPE html><html><head><title>Error</title><style>body{}</style></head>' +
  '<body><div>Sorry, unable to open the file at this time.</div><div>Please check the address and try again.</div></body></html>';

/**
 * fault(req, n) is asked before each script request (n counts requests per action, from 1)
 * and may return: { delayMs, delayAfterMs, html: 'before'|'after', drop: 'before'|'after' }.
 * realClockSkewMs: the server's clock follows real time, this far ahead of the phone's.
 * 'after' means the server did the work and saved, but the phone does not get the answer.
 */
export async function startApp({ fault = () => null, timeoutMs = 4000, serverOpts = {}, timePerCallMs = 40000, realClockSkewMs = null } = {}) {
  const server = loadServer(serverOpts);
  server.ctx.setup();
  const code = server.book().getSheetByName('הגדרות').rows().find((r) => r[0] === 'code')[2];
  const calls = [];
  const counts = {};

  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'he-IL' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
    if (process.env.VERBOSE) console.log('  [page]', m.text().slice(0, 240));
  });

  // A request still waiting when the page is closed/reloaded never reaches the server (like a real phone).
  let navigations = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.host === 'script.test') {
      const req = JSON.parse(route.request().postData());
      counts[req.action] = (counts[req.action] || 0) + 1;
      const f = fault(req, counts[req.action]) || {};
      calls.push({ action: req.action, fault: f });
      const nav = navigations;
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      if (nav !== navigations) return route.abort().catch(() => {});
      if (f.html === 'before') return route.fulfill({ status: 200, contentType: 'text/html', body: GOOGLE_ERROR_PAGE });
      if (f.drop === 'before') return route.abort('connectionreset').catch(() => {});
      if (realClockSkewMs !== null) server.clock.now = Date.now() + realClockSkewMs;
      else server.clock.now += timePerCallMs;
      const res = server.api(req);
      if (f.delayAfterMs) await new Promise((r) => setTimeout(r, f.delayAfterMs));
      if (f.html === 'after') return route.fulfill({ status: 200, contentType: 'text/html', body: GOOGLE_ERROR_PAGE });
      if (f.drop === 'after') return route.abort('connectionreset').catch(() => {});
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(f.replace ? f.replace(res) : res) }).catch(() => {});
    }
    if (url.host === 'app.test') {
      const path = url.pathname.replace(/^\//, '') || 'index.html';
      let body = readFileSync(new URL(path, root), 'utf8');
      if (path === 'js/config.js') {
        body = body.replace(/SCRIPT_URL = '[^']*'/, "SCRIPT_URL = 'https://script.test/exec'")
          .replace(/API_TIMEOUT_MS = \d+/, 'API_TIMEOUT_MS = ' + timeoutMs);
      }
      if (path === 'js/api.js') body = body.replace('RETRY_DELAY_MS = 1500', 'RETRY_DELAY_MS = 100');
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

  const app = {
    server, page, browser, code, calls, counts, errors,
    shot: (name) => page.screenshot({ path: new URL(name + '.png', shots).pathname, fullPage: true }),
    screen: (name, timeout = 15000) => page.waitForSelector(`[data-screen="${name}"]:not([hidden])`, { timeout }),
    visible: () => page.evaluate(() => document.querySelector('[data-screen]:not([hidden])')?.dataset.screen),
    open: (extra = '') => page.goto(`http://app.test/?k=${code}${extra}`),
    errorRows: () => server.book().getSheetByName('שגיאות').rows().slice(1),
    session: () => server.api({ action: 'init', k: code }).data.session,
    close: () => browser.close()
  };
  return app;
}

/** Topic → story → preview → first prep screen. */
export async function toFirstPage(app) {
  await app.open();
  await app.screen('topic');
  await app.page.fill('#topic', 'a dragon who loves pizza');
  await app.page.click('#make-story');
  await app.screen('preview');
  await app.page.click('#start-reading');
  await app.screen('prep');
}

/** Reads the current page well (the fake reader says every word) and waits for its result. */
export async function readPage(app, plan = { skip: [], mis: [] }) {
  await app.page.evaluate((p) => { window.__fakeReading = p; }, plan);
  await app.page.click('#go-read');
  await app.screen('reading');
  await app.screen('result');
}
