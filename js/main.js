// main.js — the flow between screens. Each screen function does one step and
// hands over to the next. All server calls go through api.js, all speech through speech.js.

import { VERSION, AUTO_STOP_AFTER_LAST_WORD_MS, MAX_PAGE_MS } from './config.js';
import { call, hasCode, ApiError, serverNow } from './api.js';
import { state, story, pageCount, nextStep } from './state.js';
import { tokenize } from './text.js';
import { alignPage, followPosition, summarize, pageBelow } from './scoring.js';
import { renderPage, setPosition, markHint, showStatuses, onWordTap } from './reader.js';
import { renderPrep, renderPractice } from './practice.js';
import { askQuestion } from './quiz.js';
import { checkAnswer } from './answers.js';
import { startReading, loadSdk, setToken, prefetchToken } from './speech.js';
import { speak } from './tts.js';
import { log, isDebug } from './debug.js';
import { reportError, flushReports } from './report.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- screens and messages ---------- */

let currentScreen = '';

function show(name) {
  currentScreen = name;
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
  gemini_busy: 'כותב הסיפורים עמוס כרגע. מחכים דקה ומנסים שוב.',
  bad_story: 'הסיפור יצא לא טוב. מנסים שוב.',
  speech_token_error: 'בדיקת הקריאה לא זמינה כרגע.',
  speech_sdk_unavailable: 'רכיב זיהוי הדיבור לא נטען. בודקים את החיבור ומנסים שוב.',
  mic: 'צריך לאשר גישה למיקרופון. לוחצים על המנעול ליד הכתובת, מאשרים מיקרופון ומנסים שוב.',
  rate_limited: 'יותר מדי בקשות. מחכים דקה ומנסים שוב.',
  server_html: 'השרת של גוגל החזיר שגיאה. מנסים שוב.',
  busy: 'השרת עסוק. מנסים שוב.'
};

function errorText(e) {
  const code = e instanceof ApiError ? e.code : (e && e.message) || 'unknown';
  if (/permission|notallowed|microphone/i.test(String(e && e.message))) return MESSAGES.mic;
  return MESSAGES[code] || ('משהו השתבש. מנסים שוב. (' + code + ')');
}

/** where: what we were doing. Every error screen is logged in full and reported to the sheet. */
function showError(e, retry, where = '') {
  log('ui', `error in ${where || '?'}: ${e && (e.code || e.name)}`, String(e && e.message));
  reportError(where || 'unknown', e, currentScreen);
  $('error-text').textContent = errorText(e);
  $('error-retry').onclick = retry || (() => location.reload());
  show('error');
}

// The server says the phone is out of step (e.g. a reading was saved but its answer got lost):
// not an error for the child, just ask the server where we are and continue from there.
const OUT_OF_STEP = new Set(['page_not_allowed', 'page_not_started', 'too_early', 'no_story']);

function resync(e, where) {
  log('ui', `out of step in ${where} (${e.code}), asking the server where we are`);
  reportError(where + ' (resync)', e, currentScreen);
  return boot();
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
    flushReports();
    route();
  } catch (e) {
    showError(e, boot, 'init');
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
    const sess = await call('newStory', { topic, extra: state.extra });
    state.session = sess && sess.story ? sess : await recoverSession();
    previewScreen();
  } catch (e) {
    if (e.code === 'no_regen_left' || e.code === 'locked') {
      alert(errorText(e));
      return boot();
    }
    showError(e, () => makeStory(topic), 'newStory');
  }
}

/**
 * A story request can come back without a story (a long request cut off on the way).
 * The story may still have been saved, so ask the server where we stand.
 */
async function recoverSession() {
  log('ui', 'story answer without a story, checking the server');
  const data = await call('init');
  const sess = state.extra ? data.extraSession : data.session;
  if (sess && sess.story) return sess;
  throw new ApiError('bad_story');
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
  prefetchToken(); // so the microphone does not wait for the server when she presses "start"

  $('go-read').onclick = () => beginPage(i);
  show('prep');
}

/**
 * "Start reading": the server is told (startPage) and the microphone is started at the
 * same time. The page opens as soon as the microphone listens; the server's answer is
 * awaited only before the reading is saved. Google can take 10+ seconds to answer, and
 * the child should not wait for that.
 */
async function beginPage(i) {
  const t0 = performance.now();
  const started = call('startPage', { page: i, extra: state.extra }).then((r) => {
    log('ui', `server started the page ${Math.round(performance.now() - t0)}ms after the press`);
    if (!r.expired) {
      setToken(r.speech);
      state.session.locked = true;
      state.session.startedAt = r.startedAt;
      updateHeader();
    }
    return r;
  });
  started.catch(() => { /* handled in readingScreen */ });
  await readingScreen(i, t0, started);
}

async function readingScreen(i, t0, started) {
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
  $('mic-state').textContent = 'רגע… מכינים את המיקרופון';
  $('mic-state').className = 'mic';
  $('done-reading').disabled = true;
  $('page-text').classList.add('waiting');
  $('ready-banner').hidden = true;
  show('reading');

  let position = 0;
  let autoStop = null;
  let finished = false;
  let safety = null;

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

  let session = null;
  let listenedAt = 0;
  // The server refused or could not start the page: stop listening and deal with it.
  let aborted = false;
  const abort = async (e, r) => {
    if (finished || aborted) return;
    aborted = true;
    finished = true;
    clearTimeout(safety);
    clearTimeout(autoStop);
    if (session) await session.stop();
    if (r && r.expired) return expiredScreen(r.session);
    if (OUT_OF_STEP.has(e.code)) return resync(e, 'startPage');
    return showError(e, boot, 'startPage');
  };
  started.then((r) => { if (r.expired) abort(null, r); }, (e) => abort(e));

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
      onProblem: (details) => {
        // Microsoft stopped listening in the middle (connection, token): say so, do not let her read into nothing.
        reportError('reading: speech stopped', new Error(String(details)), 'reading');
        $('mic-state').textContent = 'הבדיקה נקטעה. לוחצים "סיימתי" וקוראים שוב';
        $('mic-state').className = 'mic';
      }
    });
  } catch (e) {
    clearTimeout(safety);
    if (aborted) return;
    finished = true;
    return showError(e, () => beginPage(i), 'reading: microphone');
  }
  if (aborted) { session.stop(); return; }
  listenedAt = performance.now();
  log('speech', `listening ${Math.round(listenedAt - t0)}ms after "start reading" was pressed`);
  // Only now is anything heard: tell the child clearly that she can start.
  safety = setTimeout(() => finishPage(), MAX_PAGE_MS);
  $('page-text').classList.remove('waiting');
  $('ready-banner').hidden = false;
  setTimeout(() => { $('ready-banner').hidden = true; }, 2500);
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
    const durSec = Math.round((performance.now() - listenedAt) / 100) / 10;
    const { statuses, insertions, said } = alignPage(ref, heard, state.hinted, state.child.pronThreshold ?? undefined);
    log('score', 'aligned', { heard: heard.length, insertions, said, statuses: statuses.join(',') });
    // The phone counts exactly like the server, so the result shows at once.
    // The server still decides: buttons wait until it has saved and confirmed.
    const attemptsBefore = state.session.pages[i].attempts;
    const local = summarize(statuses, insertions);
    const localBelow = pageBelow(local, state.child, story().wordCount);
    const errWords = statuses.map((t, k) => ({ w: ref[k], t })).filter((e) => e.t !== 'ok');
    resultScreen(i, {
      attempt: local, errWords, below: localBelow,
      canRetry: localBelow && attemptsBefore + 1 < 2
    }, statuses, said);

    // One id per reading: if the answer is lost on the way, sending again does not count twice.
    const attemptId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const submit = async () => {
      resultSaving('saving');
      try {
        // The page must be started on the server before its reading can be saved.
        // If that first start never reached it, start it again now (the reading itself is done).
        const s0 = await started.catch(() => call('startPage', { page: i, extra: state.extra }));
        if (s0.expired) return expiredScreen(s0.session);
        const res = await call('submitPage', { page: i, extra: state.extra, words: statuses, insertions, said, attemptId, durSec });
        if (res.expired) return expiredScreen(res.session);
        const p = state.session.pages[i];
        p.attempts = attemptsBefore + 1;
        p.best = res.best;
        if (res.attempt.acc !== local.acc) log('score', 'server and phone differ', { server: res.attempt, phone: local });
        resultActions(i, res);
        resultSaving('saved');
      } catch (e) {
        log('score', 'save failed', String(e && (e.code || e.message)));
        if (OUT_OF_STEP.has(e.code)) return resync(e, 'submitPage');
        reportError('submitPage', e, 'result');
        resultSaving('failed', submit); // resends this same reading, it does not start the page over
      }
    };
    submit();
  }
}

/** The page result, shown before the server has answered. */
function resultScreen(i, res, statuses, said = {}) {
  const st = story();
  const a = res.attempt;
  $('result-score').textContent = `${a.acc}%`;
  $('result-score').className = 'score ' + (res.below ? 'low' : 'high');
  $('result-line').textContent = (res.below ? 'העמוד הזה היה קשה.' : 'כל הכבוד!') +
    ` ${a.errors} טעויות מתוך ${a.n} מילים.` + (res.canRetry ? ' אפשר לקרוא אותו שוב פעם אחת.' : '');
  $('result-kinds').textContent = errorKinds(a);
  const spans = renderPage($('result-text'), st.pages[i].text);
  showStatuses(spans, statuses, said);
  $('result-text').onclick = (e) => {
    const w = e.target.closest('.w');
    if (w) speak(w.textContent, state.child.lang);
  };
  currentPractice = renderPractice($('practice'), res.errWords, state.child.lang, state.child.pronThreshold ?? undefined);
  $('retry-box').hidden = !res.canRetry;
  $('retry-btn').disabled = true;
  $('after-result').disabled = true;
  show('result');
}

let currentPractice = null;

/** "2 דילוגים · 1 מילה אחרת · 3 הגייה": which kinds of errors, so a skip is never a mystery. */
function errorKinds(a) {
  return [
    [a.om, 'דילוג', 'דילוגים'],
    [a.sub, 'מילה אחרת', 'מילים אחרות'],
    [a.mis, 'הגייה', 'הגייה'],
    [a.ins, 'מילה נוספת', 'מילים נוספות'],
    [a.hint, 'רמז', 'רמזים']
  ].filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`).join(' · ');
}

/** Once the server confirmed: the buttons follow its decision. */
function resultActions(i, res) {
  $('retry-box').hidden = !res.canRetry;
  $('retry-btn').disabled = false;
  $('after-result').disabled = false;
  $('retry-btn').onclick = () => { currentPractice.flush(); beginPage(i); };
  $('after-result').onclick = () => {
    currentPractice.flush();
    if (state.session.questions) questionScreen(i);
    else nextAfterPage(i);
  };
}

function resultSaving(stateName, retry) {
  const el = $('save-state');
  el.className = 'save-state ' + stateName;
  el.textContent = { saving: 'שומרים את התוצאה…', saved: '', failed: 'השמירה לא הצליחה. ' }[stateName];
  if (stateName === 'failed') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'linkish';
    b.textContent = 'לנסות שוב';
    b.onclick = retry;
    el.appendChild(b);
  }
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
  const q = story().pages[i].question;
  await askQuestion($('q-box'), q, async (choice) => {
    const r = await answerNow({ kind: 'page', page: i, choice, extra: state.extra }, 'p' + i, q);
    state.session.pages[i].answered = { choice: r.choice, correct: r.correct };
    return r;
  });
  nextAfterPage(i);
}

/**
 * The answer is checked on the phone at once (answer key in the story) and saved on the
 * server in the background, with retries. Without a key (older server) it waits as before.
 */
const pendingAnswers = new Set();

function answerNow(payload, qref, q) {
  const local = checkAnswer(state.session.id, qref, q, payload.choice);
  const saving = saveAnswer(payload);
  if (!local) return saving;
  log('quiz', 'checked on the phone', { qref, ...local });
  saving.then((r) => {
    if (r.correct !== local.correct) log('quiz', 'server and phone differ', { server: r, phone: local });
  }).catch(() => { /* reported in saveAnswer; finish() checks again */ });
  return Promise.resolve(local);
}

function saveAnswer(payload) {
  const p = (async () => {
    for (let k = 1; ; k++) {
      try {
        return await call('answer', payload);
      } catch (e) {
        reportError('answer', e, currentScreen);
        if (OUT_OF_STEP.has(e.code) || k >= 3) throw e;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();
  pendingAnswers.add(p);
  p.catch(() => {}).finally(() => pendingAnswers.delete(p));
  return p;
}

async function finalScreen(f) {
  updateHeader();
  $('q-label').textContent = `שאלה ${f + 1} מתוך 3 על כל הסיפור`;
  show('question');
  const q = story().finalQuestions[f];
  await askQuestion($('q-box'), q, async (choice) => {
    const r = await answerNow({ kind: 'final', index: f, choice, extra: state.extra }, 'f' + f, q);
    state.session.finalAnswers[f] = { choice: r.choice, correct: r.correct };
    return r;
  });
  if (f + 1 < 3) finalScreen(f + 1);
  else finish();
}

/* ---------- end of story ---------- */

async function finish() {
  loading('מסכמים…');
  // Answers still on their way to the server go first.
  if (pendingAnswers.size) await Promise.allSettled([...pendingAnswers]);
  try {
    const r = await call('finish', { extra: state.extra });
    state.session.finished = true;
    state.session.result = r.result;
    if (!state.extra) state.mainResult = r.result;
    clearInterval(timerHandle);
    summaryScreen(r.result, r.extraAllowed);
  } catch (e) {
    if (e.code === 'finished') {
      // An earlier try did finish (its answer was lost on the way): show what the server has.
      const data = await call('init').catch(() => null);
      const sess = data && (state.extra ? data.extraSession : data.session);
      if (sess && sess.result) { state.session = sess; return summaryScreen(sess.result, !state.extra && sess.result.passed && state.child.extraAllowed); }
    }
    // An answer that never reached the server: back to where the server is (it asks again).
    if (OUT_OF_STEP.has(e.code)) return resync(e, 'finish');
    showError(e, finish, 'finish');
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
// Nothing that goes wrong is silent: script errors are logged and reported too.
window.addEventListener('error', (e) => {
  log('error', e.message, `${e.filename}:${e.lineno}`);
  reportError('script error', new Error(`${e.message} at ${e.filename}:${e.lineno}`), currentScreen);
});
window.addEventListener('unhandledrejection', (e) => {
  log('error', 'promise', String(e.reason?.stack || e.reason));
  reportError('unhandled promise', e.reason instanceof Error ? e.reason : new Error(String(e.reason)), currentScreen);
});
// A phone that locks its screen or loses signal explains many "network" errors.
document.addEventListener('visibilitychange', () => log('app', 'page ' + document.visibilityState));
window.addEventListener('online', () => log('app', 'online'));
window.addEventListener('offline', () => log('app', 'offline'));
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => log('app', 'service worker failed', String(e)));
}
boot();
