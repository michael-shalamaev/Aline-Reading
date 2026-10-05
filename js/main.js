// main.js — the flow between screens. Each screen function does one step and
// hands over to the next. All server calls go through api.js, all speech through speech.js.

import { VERSION, AUTO_STOP_AFTER_LAST_WORD_MS, MAX_PAGE_MS } from './config.js';
import { call, hasCode, ApiError, serverNow } from './api.js';
import { state, story, pageCount, nextStep } from './state.js';
import { tokenize } from './text.js';
import { alignPage, followPosition } from './scoring.js';
import { renderPage, setPosition, markHint, showStatuses, onWordTap } from './reader.js';
import { renderPrep, renderPractice } from './practice.js';
import { askQuestion } from './quiz.js';
import { startReading, loadSdk } from './speech.js';
import { speak } from './tts.js';
import { log, isDebug } from './debug.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- screens and messages ---------- */

function show(name) {
  document.querySelectorAll('[data-screen]').forEach((s) => { s.hidden = s.dataset.screen !== name; });
  window.scrollTo(0, 0);
  log('ui', 'screen', name);
}

function loading(text) {
  $('loading-text').textContent = text;
  show('loading');
}

const MESSAGES = {
  unauthorized: 'הקישור לא תקין. כדאי לבקש מההורה את הקישור הנכון.',
  inactive: 'הקריאה כבויה כרגע.',
  not_configured: 'האפליקציה עוד לא מחוברת לשרת.',
  network: 'אין חיבור לאינטרנט. בודקים את החיבור ומנסים שוב.',
  timeout: 'השרת לא ענה בזמן. מנסים שוב.',
  locked: 'הקריאה כבר התחילה, אי אפשר להחליף סיפור.',
  no_regen_left: 'נגמרו ההחלפות להיום. נקרא את הסיפור הזה!',
  gemini_error: 'לא הצלחנו לכתוב סיפור כרגע. מנסים שוב בעוד רגע.',
  bad_story: 'הסיפור יצא לא טוב. מנסים שוב.',
  speech_token_error: 'בדיקת הקריאה לא זמינה כרגע.',
  speech_sdk_unavailable: 'רכיב זיהוי הדיבור לא נטען. בודקים את החיבור ומנסים שוב.',
  mic: 'צריך לאשר גישה למיקרופון. לוחצים על המנעול ליד הכתובת, מאשרים מיקרופון ומנסים שוב.',
  rate_limited: 'יותר מדי בקשות. מחכים דקה ומנסים שוב.'
};

function errorText(e) {
  const code = e instanceof ApiError ? e.code : (e && e.message) || 'unknown';
  if (/permission|notallowed|microphone/i.test(String(e && e.message))) return MESSAGES.mic;
  return MESSAGES[code] || ('משהו השתבש. מנסים שוב. (' + code + ')');
}

function showError(e, retry) {
  log('ui', 'error', String(e && (e.code || e.message)));
  $('error-text').textContent = errorText(e);
  $('error-retry').onclick = retry || (() => location.reload());
  show('error');
}

/* ---------- header: name, progress, time left ---------- */

let timerHandle = null;

function updateHeader() {
  const s = state.session;
  $('hello').textContent = state.child ? `שלום ${state.child.name}!` : '';
  $('progress').textContent = s && s.locked && !s.finished ? `עמוד ${state.page + 1} מתוך ${pageCount()}` : '';
  clearInterval(timerHandle);
  $('timer').textContent = '';
  if (s && s.startedAt && !s.finished) {
    const tick = () => {
      const left = Math.max(0, s.startedAt + s.windowMinutes * 60000 - serverNow());
      $('timer').textContent = `⏱ ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
      $('timer').classList.toggle('low', left < 5 * 60000);
    };
    tick();
    timerHandle = setInterval(tick, 1000);
  }
}

/* ---------- start ---------- */

async function boot() {
  $('version').textContent = 'v' + VERSION;
  if (!hasCode()) return showError(new ApiError('unauthorized'));
  loading('טוענים…');
  try {
    const data = await call('init');
    state.child = data.child;
    $('version').textContent = `v${VERSION} · שרת ${data.version}`;
    if (data.session && data.session.finished) {
      state.mainResult = data.session.result;
      if (data.extraSession && data.extraSession.story) {
        state.extra = true;
        state.session = data.extraSession;
      } else {
        state.session = data.session;
      }
    } else {
      state.session = data.session;
    }
    loadSdk().catch(() => { /* reported when reading starts */ });
    route();
  } catch (e) {
    showError(e, boot);
  }
}

/** Goes to wherever the session says we are. */
function route() {
  updateHeader();
  const step = nextStep();
  log('ui', 'route', step);
  switch (step.kind) {
    case 'topic': return topicScreen();
    case 'preview': return previewScreen();
    case 'prep': return prepScreen(step.page);
    case 'question': return questionScreen(step.page);
    case 'final': return finalScreen(step.index);
    case 'finish': return finish();
    case 'summary': return summaryScreen(state.session.result, false);
  }
}

/* ---------- topic and preview ---------- */

function topicScreen() {
  const c = state.child;
  $('topic-title').textContent = state.extra ? 'על מה הסיפור הנוסף?' : 'על מה הסיפור היום?';
  const input = $('topic');
  input.value = state.lastTopic || '';
  $('suggestions').innerHTML = c.suggestions.map((s) =>
    `<button type="button" class="chip" lang="en">${esc(s)}</button>`).join('');
  $('suggestions').onclick = (e) => {
    const b = e.target.closest('.chip');
    if (b) { input.value = b.textContent; input.focus(); }
  };
  const left = state.session && state.session.story ? state.session.regenLeft : null;
  $('regen-info').textContent = left === null ? '' : `אפשר להחליף סיפור עוד ${left} פעמים.`;
  $('make-story').onclick = () => makeStory(input.value.trim());
  input.onkeydown = (e) => { if (e.key === 'Enter') makeStory(input.value.trim()); };
  show('topic');
}

async function makeStory(topic) {
  if (!topic) { $('topic').focus(); return; }
  state.lastTopic = topic;
  loading('כותבים בשבילך סיפור חדש… זה לוקח בערך חצי דקה');
  try {
    state.session = await call('newStory', { topic, extra: state.extra });
    previewScreen();
  } catch (e) {
    if (e.code === 'no_regen_left' || e.code === 'locked') {
      alert(errorText(e));
      return boot();
    }
    showError(e, () => makeStory(topic));
  }
}

function previewScreen() {
  updateHeader();
  const st = story();
  $('story-title').textContent = st.title;
  const first = st.pages[0].text.split(/\s+/).slice(0, 45).join(' ');
  $('excerpt').textContent = first + '…';
  $('preview-info').textContent = `${st.pages.length} עמודים, ${st.wordCount} מילים.` +
    (state.session.regenLeft > 0 ? ` אפשר להחליף סיפור עוד ${state.session.regenLeft} פעמים.` : '');
  $('other-story').hidden = state.session.regenLeft <= 0;
  $('other-story').onclick = topicScreen;
  $('start-reading').onclick = () => prepScreen(0);
  show('preview');
}

/* ---------- one page: prepare, read, result ---------- */

function prepScreen(i) {
  state.page = i;
  updateHeader();
  const st = story();
  $('prep-label').textContent = `עמוד ${i + 1} מתוך ${st.pages.length}`;
  renderPrep($('prep-words'), st.pages[i].hardWords, state.child.lang);
  $('go-read').onclick = () => beginPage(i);
  show('prep');
}

async function beginPage(i) {
  loading('מכינים את המיקרופון…');
  try {
    const r = await call('startPage', { page: i, extra: state.extra });
    if (r.expired) return expiredScreen(r.session);
    state.session.locked = true;
    state.session.startedAt = r.startedAt;
    await readingScreen(i);
  } catch (e) {
    showError(e, () => prepScreen(i));
  }
}

async function readingScreen(i) {
  updateHeader();
  const st = story();
  const text = st.pages[i].text;
  const ref = tokenize(text);
  const spans = renderPage($('page-text'), text);
  const hintsMax = state.child.hintsPerPage;
  state.hinted = new Set();
  const updateHints = () => {
    $('hint-info').textContent = hintsMax > 0
      ? `נתקעים על מילה? לוחצים עליה כדי לשמוע אותה (נשארו ${hintsMax - state.hinted.size}, כל אחת נספרת כטעות)`
      : '';
  };
  updateHints();
  $('mic-state').textContent = 'מתחברים…';
  $('mic-state').className = 'mic';
  $('done-reading').disabled = true;
  show('reading');

  let position = 0;
  let autoStop = null;
  let finished = false;
  const safety = setTimeout(() => finishPage(), MAX_PAGE_MS);

  onWordTap($('page-text'), (idx, word) => {
    if (hintsMax <= 0 || finished) return;
    if (!state.hinted.has(idx) && state.hinted.size >= hintsMax) return;
    if (!state.hinted.has(idx)) {
      state.hinted.add(idx);
      markHint(spans, idx);
      updateHints();
    }
    speak(word, state.child.lang);
  });

  let session;
  try {
    session = await startReading({
      referenceText: ref.join(' '),
      lang: state.child.lang,
      onProgress: (heard) => {
        position = followPosition(ref, heard);
        setPosition(spans, position);
        if (position >= ref.length) {
          clearTimeout(autoStop);
          autoStop = setTimeout(() => finishPage(), AUTO_STOP_AFTER_LAST_WORD_MS);
        }
      },
      onProblem: (details) => log('speech', 'problem', details)
    });
  } catch (e) {
    clearTimeout(safety);
    return showError(e, () => beginPage(i));
  }
  setPosition(spans, 0);
  $('mic-state').textContent = 'מקשיבים… קוראים בקול';
  $('mic-state').className = 'mic on';
  $('done-reading').disabled = false;
  $('done-reading').onclick = () => finishPage();

  async function finishPage() {
    if (finished) return;
    finished = true;
    clearTimeout(safety);
    clearTimeout(autoStop);
    $('mic-state').textContent = 'בודקים…';
    $('mic-state').className = 'mic';
    $('done-reading').disabled = true;
    const heard = await session.stop();
    const { statuses, insertions } = alignPage(ref, heard, state.hinted);
    log('score', 'aligned', { heard: heard.length, insertions, statuses: statuses.join(',') });
    loading('בודקים את הקריאה…');
    try {
      const res = await call('submitPage', { page: i, extra: state.extra, words: statuses, insertions });
      if (res.expired) return expiredScreen(res.session);
      const p = state.session.pages[i];
      p.attempts += 1;
      p.best = res.best;
      resultScreen(i, res, statuses);
    } catch (e) {
      showError(e, () => prepScreen(i));
    }
  }
}

function resultScreen(i, res, statuses) {
  const st = story();
  const a = res.attempt;
  $('result-score').textContent = `${a.acc}%`;
  $('result-score').className = 'score ' + (res.below ? 'low' : 'high');
  $('result-line').textContent = (res.below ? 'העמוד הזה היה קשה.' : 'כל הכבוד!') +
    ` ${a.errors} טעויות מתוך ${a.n} מילים.` + (res.canRetry ? ' אפשר לקרוא אותו שוב פעם אחת.' : '');
  const spans = renderPage($('result-text'), st.pages[i].text);
  showStatuses(spans, statuses);
  $('result-text').onclick = (e) => {
    const w = e.target.closest('.w');
    if (w) speak(w.textContent, state.child.lang);
  };
  const practice = renderPractice($('practice'), res.errWords, state.child.lang);

  $('retry-box').hidden = !res.canRetry;
  $('retry-btn').onclick = () => { practice.flush(); beginPage(i); };
  $('after-result').onclick = () => {
    practice.flush();
    if (state.session.questions) questionScreen(i);
    else nextAfterPage(i);
  };
  show('result');
}

function nextAfterPage(i) {
  if (i + 1 < pageCount()) prepScreen(i + 1);
  else if (state.session.questions) finalScreen(0);
  else finish();
}

/* ---------- questions ---------- */

async function questionScreen(i) {
  state.page = i;
  updateHeader();
  $('q-label').textContent = `שאלה על עמוד ${i + 1}`;
  show('question');
  await askQuestion($('q-box'), story().pages[i].question, async (choice) => {
    const r = await call('answer', { kind: 'page', page: i, choice, extra: state.extra });
    state.session.pages[i].answered = { choice: r.choice, correct: r.correct };
    return r;
  });
  nextAfterPage(i);
}

async function finalScreen(f) {
  updateHeader();
  $('q-label').textContent = `שאלה ${f + 1} מתוך 3 על כל הסיפור`;
  show('question');
  await askQuestion($('q-box'), story().finalQuestions[f], async (choice) => {
    const r = await call('answer', { kind: 'final', index: f, choice, extra: state.extra });
    state.session.finalAnswers[f] = { choice: r.choice, correct: r.correct };
    return r;
  });
  if (f + 1 < 3) finalScreen(f + 1);
  else finish();
}

/* ---------- end of story ---------- */

async function finish() {
  loading('מסכמים…');
  try {
    const r = await call('finish', { extra: state.extra });
    state.session.finished = true;
    state.session.result = r.result;
    if (!state.extra) state.mainResult = r.result;
    clearInterval(timerHandle);
    summaryScreen(r.result, r.extraAllowed);
  } catch (e) {
    showError(e, finish);
  }
}

function summaryScreen(r, extraAllowed) {
  updateHeader();
  const extraDone = state.extra;
  $('summary-title').textContent = extraDone
    ? 'סיימת עוד סיפור! 🌟'
    : (r.passed ? 'עברת! כל הכבוד 🎉' : 'הפעם זה לא הספיק');
  const lines = [
    `דיוק: ${r.acc}% (${r.errors} טעויות מתוך ${r.words} מילים)`,
    r.quizTotal ? `שאלות: ${r.quizCorrect} מתוך ${r.quizTotal} נכונות` : '',
    `זמן קריאה: ${r.readMinutes} דקות`,
    !extraDone && !r.passed ? 'מחר יש סיפור חדש ועוד הזדמנות.' : '',
    !extraDone && r.passed ? 'ההורה קיבל הודעה.' : ''
  ].filter(Boolean);
  $('summary-body').innerHTML = lines.map((l) => `<p>${esc(l)}</p>`).join('');
  const canExtra = state.child.extraAllowed && state.mainResult && state.mainResult.passed;
  $('extra-btn').hidden = !(extraAllowed || canExtra);
  $('extra-btn').onclick = () => {
    state.extra = true;
    state.session = null;
    state.lastTopic = '';
    topicScreen();
  };
  show('summary');
}

function expiredScreen(sess) {
  state.session = sess;
  clearInterval(timerHandle);
  $('expired-btn').onclick = route;
  show('expired');
}

/* ---------- go ---------- */

if (isDebug()) document.body.classList.add('debug');
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => log('app', 'service worker failed', String(e)));
}
boot();
