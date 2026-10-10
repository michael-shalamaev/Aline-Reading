// stories.js — asks Gemini for a story split into pages, with hard words and questions,
// and checks the answer before it is used. Mirrors server/Stories.gs.

import { fail, AppError, tokenize, normWord, answerKey } from './util.js';
import { kvGet, kvPut, kvDelete } from './store.js';
import { report } from './reports.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const LEVEL_GUIDE = {
  'מתחילים': 'CEFR A1: very short sentences (5-8 words), present simple and past simple only, the 500 most common English words.',
  'בינוני': 'CEFR A2: short sentences (6-12 words), simple tenses, everyday vocabulary, a few new words that the story makes clear.',
  'מתקדם': 'CEFR B1: sentences up to 16 words, varied tenses, richer vocabulary.'
};

const versionOf = (name) => { const m = name.match(/gemini-([\d.]+)-/); return m ? parseFloat(m[1]) : 0; };

/** Newest two Flash models, then one Flash-Lite; GEMINI_MODEL first if set. Cached 6 hours. */
export async function geminiModels(env) {
  let list = await kvGet(env.DB, 'gemini_models');
  if (!list) {
    const res = await fetch(GEMINI_BASE + '/models?pageSize=200', { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
    if (res.status !== 200) fail('gemini_error', 'List models failed: ' + (await res.text()).slice(0, 300));
    const names = ((await res.json()).models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace('models/', ''));
    const byVersion = (a, b) => versionOf(b) - versionOf(a);
    const flash = names.filter((n) => /^gemini-[\d.]+-flash$/.test(n)).sort(byVersion);
    const lite = names.filter((n) => /^gemini-[\d.]+-flash-lite$/.test(n)).sort(byVersion);
    list = flash.slice(0, 2).concat(lite.slice(0, 1));
    if (!list.length) fail('gemini_error', 'No Flash model available. Set GEMINI_MODEL.');
    await kvPut(env.DB, 'gemini_models', list, 21600);
  }
  const fixed = env.GEMINI_MODEL;
  if (fixed) list = [fixed].concat(list.filter((n) => n !== fixed));
  return list;
}

function storySchema() {
  const question = {
    type: 'OBJECT',
    properties: { q: { type: 'STRING' }, options: { type: 'ARRAY', items: { type: 'STRING' } }, answer: { type: 'INTEGER' } },
    required: ['q', 'options', 'answer']
  };
  return {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      topicUsed: { type: 'STRING' },
      topicAdjusted: { type: 'BOOLEAN' },
      pages: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { text: { type: 'STRING' }, hardWords: { type: 'ARRAY', items: { type: 'STRING' } }, question },
          required: ['text', 'hardWords', 'question']
        }
      },
      finalQuestions: { type: 'ARRAY', items: question }
    },
    required: ['title', 'topicUsed', 'topicAdjusted', 'pages', 'finalQuestions']
  };
}

export function storyPrompt(child, topic, withQuestions) {
  const perPage = Math.round(child.words / child.pages);
  return [
    'Write an original, gentle and friendly children\'s story in English for a young learner of English as a second language.',
    'The reader will read it aloud, and speech recognition will check every word.',
    '',
    'Topic chosen by the reader (it may be written in Hebrew): "' + String(topic).slice(0, 120) + '".',
    'If the topic does not fit a gentle children\'s story, or names real brands or famous people, ',
    'write about a close, friendly version of it and set topicAdjusted to true.',
    'Otherwise set topicAdjusted to false: translating the topic, making it a character or adding details is not a change.',
    '',
    'The story should suit readers about ' + child.age + ' years old: interests, characters and humor for that age.',
    'English level: ' + (LEVEL_GUIDE[child.level] || LEVEL_GUIDE['בינוני']),
    'Length: exactly ' + child.pages + ' pages, about ' + perPage + ' words each, and never fewer than ' + perPage +
      ' words on any page (total at least ' + child.words + ' words). Count the words; a longer page is fine, a shorter one is not.',
    'Split pages at natural points. Each page is one to three paragraphs separated by a blank line.',
    '',
    'Reading-aloud rules, very important:',
    '- Write numbers as words ("three", not "3").',
    '- No abbreviations, no symbols, no hyphenated words, no words in other languages.',
    '- Use common, easy-to-say English names for characters.',
    '- Dialogue is allowed, with plain double quotes.',
    '',
    'For each page: hardWords = 4 or 5 words from that page that may be hard to read, copied exactly as they appear.',
    withQuestions
      ? 'For each page: one simple multiple-choice question about that page, 4 options, answer = index 0-3 of the correct option. Vary the position of the correct answer.'
      : 'For each page: a question is still required by the format; make it simple.',
    'finalQuestions: exactly 3 multiple-choice questions about the whole story, 4 options each, answer = index 0-3.',
    'Questions and options are in simple English.',
    'The story should be warm, fun and have a clear ending.'
  ].join('\n');
}

// Time limits. The phone gives up on a story after 90 seconds, and Cloudflare stops the work
// when the phone goes, so everything here ends well before that.
const STORY_BUDGET_MS = 75000;   // the whole story, retries and fallbacks included
const GEMINI_TIMEOUT_MS = 30000; // one request to one model (a story normally takes 5-15 seconds)
const SLOW_MS = 20000;           // a request slower than this is noted in the errors tab
const MIN_LENGTH = 0.85;         // shorter than this share of the length: written again, if time allows
const MIN_LENGTH_LAST = 0.6;     // ...and still taken when there is no time left

/** Calls Gemini and returns a checked story: retried once if bad or too short, within the time budget. */
export async function generateStory(env, child, topic, withQuestions) {
  const deadline = Date.now() + (Number(env.STORY_BUDGET_MS) || STORY_BUDGET_MS);
  let lastErr = null;
  let shortStory = null; // usable, but shorter than asked: kept in case there is no time to write it again
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await callGemini(env, storyPrompt(child, topic, withQuestions), deadline);
      const story = validateStory(raw, child, MIN_LENGTH_LAST);
      if (story.wordCount >= child.words * MIN_LENGTH) return story;
      shortStory = story;
      lastErr = new AppError('bad_story', 'Length ' + story.wordCount + ' below ' + Math.round(child.words * MIN_LENGTH));
    } catch (e) {
      lastErr = e;
    }
    await report(env, { kind: 'error', childId: child.id, action: 'generateStory#' + attempt, message: `${lastErr.code || ''}: ${lastErr.message}` });
    if (['gemini_busy', 'topic_blocked', 'gemini_timeout'].includes(lastErr.code)) break;
    if (deadline - Date.now() < 15000) break; // no time for another try
  }
  if (shortStory) return shortStory;
  throw lastErr;
}

const GEMINI_TRY_NEXT = new Set([404, 429, 500, 503]);

async function geminiRequest(env, model, prompt, lowThinking, timeoutMs) {
  const config = { responseMimeType: 'application/json', responseSchema: storySchema(), temperature: 1 };
  if (lowThinking) config.thinkingConfig = { thinkingLevel: 'low' };
  return fetch(GEMINI_BASE + '/models/' + model + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: config }),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

const isTimeout = (e) => e && (e.name === 'TimeoutError' || e.name === 'AbortError');

async function callGemini(env, prompt, deadline) {
  if (!env.GEMINI_API_KEY) fail('config_missing', 'GEMINI_API_KEY not set');
  const models = await geminiModels(env);
  const notes = [];
  for (const model of models) {
    const left = deadline - Date.now();
    if (left < 5000) break;
    const limit = Math.min(Number(env.GEMINI_TIMEOUT_MS) || GEMINI_TIMEOUT_MS, left);
    const started = Date.now();
    let res, body;
    try {
      res = await geminiRequest(env, model, prompt, true, limit);
      // A model that rejects the thinking field: once more without it, in what is left of the same limit.
      if (res.status === 400) res = await geminiRequest(env, model, prompt, false, Math.max(1000, limit - (Date.now() - started)));
      body = await res.text();
    } catch (e) {
      if (!isTimeout(e)) throw e;
      notes.push(model + ' no answer in ' + Math.round(limit / 1000) + 's');
      await report(env, { kind: 'error', childId: '', action: 'gemini ' + model, message: 'gemini_slow: no answer in ' + Math.round(limit / 1000) + 's, trying the next model' });
      continue;
    }
    const ms = Date.now() - started;
    if (ms > SLOW_MS) await report(env, { kind: 'error', childId: '', action: 'gemini ' + model, message: 'gemini_slow: answered in ' + Math.round(ms / 1000) + 's (status ' + res.status + ')' });
    if (res.status === 200) {
      const data = JSON.parse(body);
      const c0 = data.candidates && data.candidates[0];
      const blocked = (data.promptFeedback && data.promptFeedback.blockReason) ||
        (c0 && /SAFETY|PROHIBITED|BLOCKLIST/.test(c0.finishReason || '') && c0.finishReason);
      if (blocked) fail('topic_blocked', 'Gemini refused the topic: ' + blocked);
      const text = c0 && c0.content && c0.content.parts.map((p) => p.text || '').join('');
      if (!text) fail('gemini_error', model + ' gave an empty answer: ' + body.slice(0, 300));
      const story = JSON.parse(text);
      story._model = model;
      story._ms = ms;
      return story;
    }
    notes.push(model + ' ' + res.status);
    if (res.status === 404) await kvDelete(env.DB, 'gemini_models');
    if (!GEMINI_TRY_NEXT.has(res.status)) fail('gemini_error', 'Gemini ' + res.status + ': ' + body.slice(0, 300));
  }
  if (notes.length && notes.every((n) => n.includes('no answer'))) fail('gemini_timeout', 'No model answered in time: ' + notes.join(', '));
  fail('gemini_busy', 'All models busy or slow: ' + (notes.join(', ') || 'no time left'));
}

function validateQuestion(q, where) {
  if (!q || !q.q || !q.options || q.options.length !== 4) fail('bad_story', 'Bad question at ' + where);
  const a = parseInt(q.answer, 10);
  if (!(a >= 0 && a <= 3)) fail('bad_story', 'Bad answer index at ' + where);
  return { q: String(q.q), options: q.options.map(String), answer: a };
}

export function validateStory(s, child, minRatio = MIN_LENGTH_LAST) {
  if (!s || !s.pages || s.pages.length !== child.pages) {
    fail('bad_story', 'Expected ' + child.pages + ' pages, got ' + (s && s.pages ? s.pages.length : 0));
  }
  let total = 0;
  const pages = s.pages.map((p, i) => {
    const text = String(p.text || '').trim();
    const words = tokenize(text);
    if (words.length < 10) fail('bad_story', 'Page ' + (i + 1) + ' too short');
    total += words.length;
    const present = {};
    words.forEach((w) => { present[normWord(w)] = w; });
    const hard = (p.hardWords || [])
      .map((w) => present[normWord(w)])
      .filter((w, idx, arr) => w && arr.indexOf(w) === idx)
      .slice(0, 5);
    return { text, hardWords: hard, question: validateQuestion(p.question, 'page ' + (i + 1)) };
  });
  if (total < child.words * minRatio || total > child.words * 1.5) fail('bad_story', 'Length ' + total + ' far from ' + child.words);
  if (!s.finalQuestions || s.finalQuestions.length < 3) fail('bad_story', 'Missing final questions');
  return {
    model: s._model || '',
    genMs: s._ms || 0,
    title: String(s.title || 'A Story'),
    topicUsed: String(s.topicUsed || ''),
    topicAdjusted: !!s.topicAdjusted,
    wordCount: total,
    pages,
    finalQuestions: s.finalQuestions.slice(0, 3).map((q, i) => validateQuestion(q, 'final ' + (i + 1)))
  };
}

/** The story as the phone sees it: questions carry an answer key, never the answer. */
export function publicStory(story, sessId) {
  if (!story) return null;
  return {
    title: story.title,
    wordCount: story.wordCount,
    pages: story.pages.map((p, i) => ({
      text: p.text,
      hardWords: p.hardWords,
      question: { q: p.question.q, options: p.question.options, key: answerKey(sessId, 'p' + i, p.question.answer) }
    })),
    finalQuestions: story.finalQuestions.map((q, f) => ({ q: q.q, options: q.options, key: answerKey(sessId, 'f' + f, q.answer) }))
  };
}
