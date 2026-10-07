// build-worker.mjs — joins worker/src/*.js into one file, worker/dist/worker.js, to paste
// into Cloudflare's online editor (no build tools needed there).
// Each module keeps its own scope; imports become lookups in the other modules.
// Run: node tools/build-worker.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SRC = new URL('../worker/src/', import.meta.url);
const OUT = new URL('../worker/dist/worker.js', import.meta.url);
const ENTRY = 'index.js';

const IMPORT_RE = /^import\s+\{([^}]*)\}\s+from\s+'\.\/([\w-]+)\.js';\s*$/gm;
const EXPORT_RE = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

const modules = new Map();
function load(file) {
  if (modules.has(file)) return;
  const text = readFileSync(new URL(file, SRC), 'utf8');
  const deps = [...text.matchAll(IMPORT_RE)].map((m) => m[2] + '.js');
  modules.set(file, null); // marks "in progress" against cycles
  deps.forEach(load);
  modules.delete(file);
  modules.set(file, { text, deps });
}
load(ENTRY);

const varName = (file) => '__' + file.replace(/\.js$/, '').replace(/\W/g, '_');
let out = '// Built by tools/build-worker.mjs from worker/src — do not edit here; edit the sources.\n';
for (const [file, { text }] of modules) {
  let body = text.replace(IMPORT_RE, (_, names, dep) =>
    `const { ${names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': ')).join(', ')} } = ${varName(dep + '.js')};`);
  if (file === ENTRY) {
    body = body.replace(/^export default /m, 'const __default = ');
    out += `\n// ---- ${file} ----\n${body}\nexport default __default;\n`;
    continue;
  }
  const names = [...body.matchAll(EXPORT_RE)].map((m) => m[1]);
  body = body.replace(/^export\s+/gm, '');
  out += `\n// ---- ${file} ----\nconst ${varName(file)} = (() => {\n${body}\nreturn { ${names.join(', ')} };\n})();\n`;
}
if (process.argv.includes('--check')) {
  // Used by the tests: the file to paste must match the sources.
  let current = '';
  try { current = readFileSync(OUT, 'utf8'); } catch { /* missing */ }
  if (current !== out) { console.error('worker/dist/worker.js is out of date: run node tools/build-worker.mjs'); process.exit(1); }
  console.log('worker/dist/worker.js is up to date');
} else {
  mkdirSync(new URL('../worker/dist/', import.meta.url), { recursive: true });
  writeFileSync(OUT, out);
  console.log(`worker/dist/worker.js: ${modules.size} modules, ${out.length} characters`);
}
