// Run: node --test tests/
// Word splitting (page vs server) and the alignment that turns heard words into errors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { tokenize, normWord, wordsHtml } from '../js/text.js';
import { alignPage, summarize, followPosition, pageBelow } from '../js/scoring.js';

const heard = (s, acc = 95) => s.split(' ').map((word) => ({ word, acc, err: 'None' }));

test('page and server split words the same way', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../server/Util.gs', import.meta.url), 'utf8'), ctx);
  const samples = [
    'Mia said, "Let\'s go!" They didn’t wait.\n\nThe end.',
    'It was a well known place, and twenty one cats lived there...',
    '"Wow," she whispered — the dragon\'s eyes were big.'
  ];
  for (const s of samples) {
    assert.deepEqual(Array.from(ctx.tokenize(s)), tokenize(s));
    assert.equal(ctx.normWord("Didn’t"), normWord("didn't"));
  }
});

test('html wraps every word exactly once, in order', () => {
  const text = 'Hello, Mia!\n\nShe smiled.';
  const html = wordsHtml(text);
  const idx = [...html.matchAll(/data-i="(\d+)">([^<]+)</g)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(idx, [[0, 'Hello'], [1, 'Mia'], [2, 'She'], [3, 'smiled']]);
  assert.equal((html.match(/<p>/g) || []).length, 2);
});

test('perfect reading has no errors', () => {
  const ref = tokenize('The little cat sat on the warm red mat.');
  const r = alignPage(ref, heard('the little cat sat on the warm red mat'));
  assert.deepEqual(summarize(r.statuses, r.insertions).errors, 0);
});

test('skipped word is an omission, extra word an insertion', () => {
  const ref = tokenize('The little cat sat on the warm red mat.');
  const r = alignPage(ref, heard('the cat sat on the big warm red mat'));
  assert.equal(r.statuses[1], 'om');
  assert.equal(r.insertions, 1);
  assert.equal(summarize(r.statuses, r.insertions).errors, 2);
});

test('low accuracy or Mispronunciation is a pronunciation error', () => {
  const ref = tokenize('The cat sat');
  const h = heard('the cat sat');
  h[1].acc = 30;
  h[2].err = 'Mispronunciation';
  const r = alignPage(ref, h);
  assert.deepEqual(r.statuses, ['ok', 'mis', 'mis']);
});

test('repeating a word to self-correct and fillers are not insertions', () => {
  const ref = tokenize('The dragon flew over the hill.');
  const r = alignPage(ref, heard('the um the dragon flew flew over the hill'));
  assert.equal(r.insertions, 0);
  assert.equal(summarize(r.statuses, r.insertions).errors, 0);
});

test('hinted words count as errors even if read', () => {
  const ref = tokenize('A beautiful butterfly landed.');
  const r = alignPage(ref, heard('a beautiful butterfly landed'), new Set([1]));
  assert.equal(r.statuses[1], 'hint');
  assert.equal(summarize(r.statuses, r.insertions).errors, 1);
});

test('recognizer spelling of a name differs by one letter: still a match', () => {
  const ref = tokenize('Maddie ran home.');
  const r = alignPage(ref, heard('maddy ran home'));
  assert.equal(r.statuses[0], 'ok');
});

test('contractions match with or without apostrophe', () => {
  const ref = tokenize("She didn’t know.");
  const r = alignPage(ref, heard("she didn't know"));
  assert.equal(summarize(r.statuses, r.insertions).errors, 0);
});

test('saying nothing makes every word an omission', () => {
  const ref = tokenize('One two three.');
  const r = alignPage(ref, []);
  assert.deepEqual(r.statuses, ['om', 'om', 'om']);
});

test('live position follows reading and skips over a missed word', () => {
  const ref = tokenize('The little cat sat on the mat.');
  assert.equal(followPosition(ref, ['the', 'little']), 2);
  assert.equal(followPosition(ref, ['the', 'cat', 'sat']), 4);
  assert.equal(followPosition(ref, 'the little cat sat on the mat'.split(' ')), ref.length);
});

test('live position jumps after a skipped line', () => {
  const ref = tokenize('One two three four five six seven eight nine ten eleven twelve.');
  assert.equal(followPosition(ref, ['one', 'two', 'nine', 'ten', 'eleven']), 11);
});

test('a word said again right away counts by its better try', () => {
  const ref = tokenize('The cats sleep.');
  const h = [{ word: 'the', acc: 95 }, { word: 'cats', acc: 30 }, { word: 'cats', acc: 90 }, { word: 'sleep', acc: 95 }];
  const r = alignPage(ref, h);
  assert.deepEqual(r.statuses, ['ok', 'ok', 'ok']);
  assert.equal(r.insertions, 0);
});

test('a word the text itself repeats is not merged', () => {
  const ref = tokenize('Oliver. Oliver has fur.');
  const h = [{ word: 'oliver', acc: 95 }, { word: 'oliver', acc: 20 }, { word: 'has', acc: 95 }, { word: 'fur', acc: 95 }];
  const r = alignPage(ref, h);
  assert.deepEqual(r.statuses, ['ok', 'mis', 'ok', 'ok']);
});

test('page verdict on the phone matches the server rule', () => {
  const child = { passByErrors: false, passPercent: 85, maxErrors: 40 };
  assert.equal(pageBelow({ acc: 84.9, errors: 12, n: 80 }, child, 400), true);
  assert.equal(pageBelow({ acc: 85, errors: 12, n: 80 }, child, 400), false);
  const byErr = { passByErrors: true, maxErrors: 40 };
  assert.equal(pageBelow({ acc: 0, errors: 8, n: 80 }, byErr, 400), false);
  assert.equal(pageBelow({ acc: 0, errors: 9, n: 80 }, byErr, 400), true);
});
