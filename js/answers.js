// answers.js — checks a question's answer on the phone, instantly, from the answer key
// that comes with the story. KEEP IN SYNC with answerKey() in server/Util.gs.
// The server still records the answer (in the background) and decides the result.

export function answerKey(sessId, qref, answer) {
  const str = `${sessId}|${qref}|${answer}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** {correct, choice, correctIndex}, or null when the story has no key (older server). */
export function checkAnswer(sessId, qref, q, choice) {
  if (!q.key) return null;
  const correctIndex = q.options.findIndex((_, i) => answerKey(sessId, qref, i) === q.key);
  if (correctIndex < 0) return null;
  return { correct: choice === correctIndex, choice, correctIndex };
}
