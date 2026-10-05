// quiz.js — one multiple-choice question. The server knows the answer, the page does not.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Shows the question, sends the choice through onAnswer(choice) →
 * {correct, correctIndex}, marks the options, and resolves when the child continues.
 */
export function askQuestion(el, q, onAnswer, previous = null) {
  return new Promise((resolve) => {
    el.innerHTML = `<p class="q" lang="en" dir="ltr">${esc(q.q)}</p>
      <div class="options" dir="ltr">${q.options.map((o, i) =>
        `<button type="button" class="option" lang="en" data-i="${i}">${esc(o)}</button>`).join('')}</div>
      <p class="feedback" aria-live="polite"></p>
      <button type="button" class="primary next" hidden>ממשיכים</button>`;
    const buttons = Array.from(el.querySelectorAll('.option'));
    const feedback = el.querySelector('.feedback');
    const next = el.querySelector('.next');

    const show = (res) => {
      buttons.forEach((b, i) => {
        b.disabled = true;
        if (i === res.correctIndex) b.classList.add('right');
        if (i === res.choice && !res.correct) b.classList.add('wrong');
      });
      feedback.textContent = res.correct ? 'נכון! 🎉' : 'לא נורא, התשובה הנכונה מסומנת בירוק.';
      next.hidden = false;
      next.focus();
    };

    if (previous) show(previous);

    el.querySelector('.options').onclick = async (e) => {
      const b = e.target.closest('.option');
      if (!b || b.disabled) return;
      buttons.forEach((x) => { x.disabled = true; });
      b.classList.add('chosen');
      try {
        const res = await onAnswer(Number(b.dataset.i));
        show({ ...res, choice: res.choice ?? Number(b.dataset.i) });
      } catch (err) {
        feedback.textContent = 'לא הצלחנו לשמור את התשובה. נסו שוב.';
        buttons.forEach((x) => { x.disabled = false; });
        b.classList.remove('chosen');
      }
    };
    next.onclick = () => resolve();
  });
}
