// state.js — what the page knows right now. Only main.js changes it.

export const state = {
  child: null,       // public settings from the server
  session: null,     // the active session (main or extra) as the server describes it
  mainResult: null,  // today's result once the main story is finished
  extra: false,      // reading an extra story?
  page: 0,           // current page index
  hinted: new Set(), // word indexes the child asked to hear on this page
  lastTopic: ''
};

export function story() {
  return state.session && state.session.story;
}

export function pageCount() {
  return story() ? story().pages.length : 0;
}

/** Where to continue: the first page not read, or a page whose question is still open. */
export function nextStep() {
  const s = state.session;
  if (!s || !s.story) return { kind: 'topic' };
  if (s.finished) return { kind: 'summary' };
  if (!s.locked) return { kind: 'preview' };
  for (let i = 0; i < s.pages.length; i++) {
    const p = s.pages[i];
    if (!p.best) return { kind: 'prep', page: i };
    if (s.questions && !p.answered) return { kind: 'question', page: i };
  }
  if (s.questions) {
    const f = s.finalAnswers.findIndex((a) => !a);
    if (f >= 0) return { kind: 'final', index: f };
  }
  return { kind: 'finish' };
}
