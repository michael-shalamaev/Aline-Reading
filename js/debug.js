// debug.js — diagnostics panel. Opens only when the link has &debug=1.
// Every module logs through log(); without the flag it only goes to the console.

const enabled = new URLSearchParams(location.search).get('debug') === '1';
const lines = [];
let panel = null;

export function isDebug() {
  return enabled;
}

export function log(area, message, data) {
  const t = new Date().toTimeString().slice(0, 8);
  const text = `${t} [${area}] ${message}` + (data !== undefined ? ' ' + safe(data) : '');
  console.log(text);
  if (!enabled) return;
  lines.push(text);
  if (lines.length > 400) lines.shift();
  render();
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

if (enabled) {
  window.addEventListener('error', (e) => log('error', e.message, `${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => log('error', 'promise', String(e.reason?.stack || e.reason)));
}
