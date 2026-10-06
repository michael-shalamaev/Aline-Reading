// debug.js — the diagnostics log. Every module logs through log().
// The last lines are always kept in memory (they go with error reports to the sheet);
// the on-screen panel opens only when the link has &debug=1.

const enabled = new URLSearchParams(location.search).get('debug') === '1';
const lines = [];
const KEEP = 400;
let panel = null;

export function isDebug() {
  return enabled;
}

export function log(area, message, data) {
  const t = new Date().toTimeString().slice(0, 8);
  const text = `${t} [${area}] ${message}` + (data !== undefined ? ' ' + safe(data) : '');
  console.log(text);
  lines.push(text);
  if (lines.length > KEEP) lines.shift();
  if (enabled) render();
}

/** The last n log lines, for an error report. */
export function recentLog(n = 40) {
  return lines.slice(-n).join('\n');
}

function safe(data) {
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    return s.length > 600 ? s.slice(0, 600) + '…' : s;
  } catch {
    return String(data);
  }
}

function render() {
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'debug-panel';
    panel.innerHTML = '<div class="dbg-bar"><b>אבחון</b><button type="button" data-act="copy">העתק</button>' +
      '<button type="button" data-act="toggle">הסתר</button></div><pre></pre>';
    panel.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (act === 'toggle') panel.classList.toggle('min');
      if (act === 'copy') navigator.clipboard?.writeText(lines.join('\n'));
    });
    document.body.appendChild(panel);
  }
  const pre = panel.querySelector('pre');
  pre.textContent = lines.join('\n');
  pre.scrollTop = pre.scrollHeight;
}
