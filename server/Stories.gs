/**
 * Stories.gs — asks Gemini for a story split into pages, with hard words
 * and comprehension questions, and checks the answer before it is used.
 */

var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

var LEVEL_GUIDE = {
  'מתחילים': 'CEFR A1: very short sentences (5-8 words), present simple and past simple only, the 500 most common English words.',
  'מתחילים מתקדמים': 'CEFR A2: short sentences (6-12 words), simple tenses, everyday vocabulary, a few new words that the story makes clear.',
  'בינוני': 'CEFR B1: sentences up to 16 words, varied tenses, richer vocabulary suitable for a strong 10-12 year old reader.'
};

/**
 * Models to try, best first: the GEMINI_MODEL property if set, then the newest
 * Flash models, then the Flash-Lite ones as a last resort. When one is busy
 * (Google answers 503/429), the next one is tried.
 */
function geminiModels() {
  var cached = CacheService.getScriptCache().get('gemini_models');
  var list = cached ? JSON.parse(cached) : null;
  if (!list) {
    var res = UrlFetchApp.fetch(GEMINI_BASE + '/models?pageSize=200', {
      headers: { 'x-goog-api-key': prop('GEMINI_API_KEY', true) },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) fail('gemini_error', 'List models failed: ' + res.getContentText().slice(0, 300));
    var names = (JSON.parse(res.getContentText()).models || [])
      .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0; })
      .map(function (m) { return String(m.name || '').replace('models/', ''); });
    var byVersion = function (a, b) { return versionOf(b) - versionOf(a); };
    var flash = names.filter(function (n) { return /^gemini-[\d.]+-flash$/.test(n); }).sort(byVersion);
    var lite = names.filter(function (n) { return /^gemini-[\d.]+-flash-lite$/.test(n); }).sort(byVersion);
    list = flash.slice(0, 2).concat(lite.slice(0, 1));
    if (!list.length) fail('gemini_error', 'No Flash model available. Set GEMINI_MODEL.');
    CacheService.getScriptCache().put('gemini_models', JSON.stringify(list), 21600);
  }
  var fixed = prop('GEMINI_MODEL');
  if (fixed) list = [fixed].concat(list.filter(function (n) { return n !== fixed; }));
  return list;
}

/** The first-choice model (shown by selfTest). */
function geminiModel() {
  return geminiModels()[0];
}

function versionOf(name) {
  var m = name.match(/gemini-([\d.]+)-/);
  return m ? parseFloat(m[1]) : 0;
}

function storySchema() {
  var question = {
    type: 'OBJECT',
    properties: {
      q: { type: 'STRING' },
      options: { type: 'ARRAY', items: { type: 'STRING' } },
      answer: { type: 'INTEGER' }
    },
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
          properties: {
            text: { type: 'STRING' },
            hardWords: { type: 'ARRAY', items: { type: 'STRING' } },
            question: question
          },
          required: ['text', 'hardWords', 'question']
        }
      },
      finalQuestions: { type: 'ARRAY', items: question }
    },
    required: ['title', 'topicUsed', 'topicAdjusted', 'pages', 'finalQuestions']
  };
}

function storyPrompt(child, topic, withQuestions) {
  var perPage = Math.round(child.words / child.pages);
  return [
    'Write an original story in English for a 10-year-old girl in Israel who is learning English as a second language.',
    'She will read it aloud, and speech recognition will check every word.',
    '',
    'Topic chosen by the child: "' + String(topic).slice(0, 120) + '".',
    'If the topic is not suitable for a 10-year-old (violence, fear, romance, adult themes, real brands or celebrities), ',
    'write about a close, kind and safe version of it, and set topicAdjusted to true.',
    '',
    'Level: ' + (LEVEL_GUIDE[child.level] || LEVEL_GUIDE['מתחילים מתקדמים']),
    'Length: exactly ' + child.pages + ' pages, about ' + perPage + ' words each (total about ' + child.words + ' words).',
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

/** Calls Gemini and returns a checked story object. A bad story is retried once. */
function generateStory(child, topic, withQuestions) {
  var lastErr = null;
  for (var attempt = 1; attempt <= 2; attempt++) {
    try {
      var story = callGemini(storyPrompt(child, topic, withQuestions));
      return validateStory(story, child);
    } catch (e) {
      lastErr = e;
      logError(child.id, 'generateStory#' + attempt, e);
      if (e.code === 'gemini_busy') break; // every model already tried; another round would only add waiting
    }
  }
  throw lastErr;
}

var GEMINI_TRY_NEXT = { 404: 1, 429: 1, 500: 1, 503: 1 };

/**
 * One request. A story needs no deep reasoning, so ask for minimal "thinking":
 * it is most of the waiting time on newer models.
 */
function geminiRequest(model, prompt, lowThinking) {
  var config = { responseMimeType: 'application/json', responseSchema: storySchema(), temperature: 1 };
  if (lowThinking) config.thinkingConfig = { thinkingLevel: 'low' };
  return UrlFetchApp.fetch(GEMINI_BASE + '/models/' + model + ':generateContent', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': prop('GEMINI_API_KEY', true) },
    muteHttpExceptions: true,
    payload: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: config })
  });
}

/** Sends the prompt to the first model that answers; busy or missing models are skipped. */
function callGemini(prompt) {
  var models = geminiModels();
  var notes = [];
  for (var i = 0; i < models.length; i++) {
    var started = Date.now();
    var res = geminiRequest(models[i], prompt, true);
    if (res.getResponseCode() === 400) res = geminiRequest(models[i], prompt, false); // model rejects the thinking field
    var code = res.getResponseCode();
    var body = res.getContentText();
    console.log('gemini', models[i], code, (Date.now() - started) + 'ms');
    if (code === 200) {
      var data = JSON.parse(body);
      var text = data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
      if (!text) fail('gemini_error', models[i] + ' gave an empty answer: ' + body.slice(0, 300));
      var story = JSON.parse(text);
      story._model = models[i];
      story._ms = Date.now() - started;
      return story;
    }
    notes.push(models[i] + ' ' + code);
    if (code === 404) CacheService.getScriptCache().remove('gemini_models');
    if (!GEMINI_TRY_NEXT[code]) fail('gemini_error', 'Gemini ' + code + ': ' + body.slice(0, 300));
  }
  fail('gemini_busy', 'All models busy: ' + notes.join(', '));
}

function validateQuestion(q, where) {
  if (!q || !q.q || !q.options || q.options.length !== 4) fail('bad_story', 'Bad question at ' + where);
  var a = parseInt(q.answer, 10);
  if (!(a >= 0 && a <= 3)) fail('bad_story', 'Bad answer index at ' + where);
  return { q: String(q.q), options: q.options.map(String), answer: a };
}

function validateStory(s, child) {
  if (!s || !s.pages || s.pages.length !== child.pages) {
    fail('bad_story', 'Expected ' + child.pages + ' pages, got ' + (s && s.pages ? s.pages.length : 0));
  }
  var total = 0;
  var pages = s.pages.map(function (p, i) {
    var text = String(p.text || '').trim();
    var words = tokenize(text);
    if (words.length < 10) fail('bad_story', 'Page ' + (i + 1) + ' too short');
    total += words.length;
    var present = {};
    words.forEach(function (w) { present[normWord(w)] = w; });
    var hard = (p.hardWords || [])
      .map(function (w) { return present[normWord(w)]; })
      .filter(function (w, idx, arr) { return w && arr.indexOf(w) === idx; })
      .slice(0, 5);
    return { text: text, hardWords: hard, question: validateQuestion(p.question, 'page ' + (i + 1)) };
  });
  if (total < child.words * 0.6 || total > child.words * 1.5) {
    fail('bad_story', 'Length ' + total + ' far from ' + child.words);
  }
  if (!s.finalQuestions || s.finalQuestions.length < 3) fail('bad_story', 'Missing final questions');
  return {
    model: s._model || '',
    genMs: s._ms || 0,
    title: String(s.title || 'A Story'),
    topicUsed: String(s.topicUsed || ''),
    topicAdjusted: !!s.topicAdjusted,
    wordCount: total,
    pages: pages,
    finalQuestions: s.finalQuestions.slice(0, 3).map(function (q, i) {
      return validateQuestion(q, 'final ' + (i + 1));
    })
  };
}

/** The story as the page may see it: no correct answers. */
/** The story as the phone sees it: questions carry an answer key, never the answer. */
function publicStory(story, sessId) {
  if (!story) return null;
  return {
    title: story.title,
    wordCount: story.wordCount,
    pages: story.pages.map(function (p, i) {
      return {
        text: p.text,
        hardWords: p.hardWords,
        question: { q: p.question.q, options: p.question.options, key: answerKey(sessId, 'p' + i, p.question.answer) }
      };
    }),
    finalQuestions: story.finalQuestions.map(function (q, f) {
      return { q: q.q, options: q.options, key: answerKey(sessId, 'f' + f, q.answer) };
    })
  };
}
