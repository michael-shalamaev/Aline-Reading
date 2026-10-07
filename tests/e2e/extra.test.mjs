import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, toFirstPage } from './harness.mjs';
import { tokenize } from '../../js/text.js';

for (const lost of [false, true]) {
test(`extra story read badly on every page, each read twice${lost ? ', summing-up answer lost' : ''}: its own summary shows`, async () => {
  const app = await startApp({ fault: (r, n) => (lost && r.action === 'finish' && n === 1 ? { html: 'after' } : null) });
  try {
    await toFirstPage(app);
    const k = app.code;
    const st = (await app.session()).story;
    for (const [i, pg] of st.pages.entries()) {
      await app.call({ action: 'startPage', page: i, k });
      await app.call({ action: 'submitPage', page: i, k, words: tokenize(pg.text).map(() => 'ok'), insertions: 0, attemptId: 'x' + i });
      await app.call({ action: 'answer', kind: 'page', page: i, choice: 1, k });
    }
    for (const f of [0, 1, 2]) await app.call({ action: 'answer', kind: 'final', index: f, choice: 1, k });
    await app.call({ action: 'finish', k });
    await app.open();
    await app.screen('summary');
    await app.page.click('#extra-btn');
    await app.screen('topic');
    await app.page.fill('#topic', 'cats');
    await app.page.click('#make-story');
    await app.screen('preview');
    await app.page.click('#start-reading');
    for (let i = 0; i < 5; i++) {
      await app.screen('prep');
      await app.page.evaluate(() => { window.__fakeReading = { skip: Array.from({ length: 40 }, (_, k) => k), mis: [] }; });
      await app.page.click('#go-read');
      await app.screen('reading');
      await app.page.waitForTimeout(1500);
      await app.page.click('#done-reading');
      await app.screen('result');
      if (!(await app.page.isHidden('#retry-box'))) {
        await app.page.click('#retry-btn');
        await app.screen('reading');
        await app.page.waitForTimeout(1500);
        await app.page.click('#done-reading');
        await app.screen('result');
      }
      await app.page.click('#after-result');
    }
    await app.page.waitForSelector('[data-screen="summary"]:not([hidden]), [data-screen="error"]:not([hidden])', { timeout: 20000 });
    const screen = await app.visible();
    const err = screen === 'error' ? await app.page.textContent('#error-text') : '';
    assert.equal(screen, 'summary', err);
    assert.match(await app.page.textContent('#summary-title'), /עוד סיפור/, 'the extra story\'s summary, not the main one');
    assert.equal((await app.mails()).length, 2, 'one mail per story, not two for the extra');
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});
}
