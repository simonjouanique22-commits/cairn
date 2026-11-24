// node test.js — checks reading sessions, files per step, signals and rendering, against a fake ~/.claude
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadRoadmap, loadSessions, filesByStep, traceOf, backupBefore, filesByCommand, readSignal, announcement, bar, render, renderApp, shell, fontFaces } = require('./extension.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-'));
const transcript = (sid) => path.join(home, 'projects', 'p-' + sid, sid + '.jsonl');
const age = (f, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(f, t, t); };
const session = (sid, cwd, statuses, ms) => {
  fs.mkdirSync(path.dirname(transcript(sid)), { recursive: true });
  fs.writeFileSync(transcript(sid), JSON.stringify({ type: 'user', cwd }) + '\n');
  age(transcript(sid), ms);
  const dir = path.join(home, 'tasks', sid);
  fs.mkdirSync(dir, { recursive: true });
  statuses.forEach((status, i) => {
    const f = path.join(dir, `${i + 1}.json`);
    fs.writeFileSync(f, JSON.stringify({ id: String(i + 1), subject: `Step ${i + 1}`, status }));
    age(f, ms);
  });
};

session('aaa', '/work/project-a', ['completed', 'in_progress', 'pending'], 60_000);
session('bbb', '/work/project-b', ['completed', 'completed'], 0); // more recent, other folder
// 10 steps to check the numeric sort (10 after 9)
session('ccc', '/work/project-a/sub-folder', Array(10).fill('pending'), 120_000);

// sessions of the folder, most recent first
const a = loadRoadmap(['/work/project-a'], home);
assert.strictEqual(a.sid, 'aaa');
assert.deepStrictEqual([a.done, a.total], [1, 3]);
assert.deepStrictEqual(loadSessions(['/work/project-a'], home).map((s) => s.sid), ['aaa', 'ccc']);
assert.strictEqual(loadRoadmap(['/work/project-b'], home).sid, 'bbb');
assert.strictEqual(loadRoadmap([], home).sid, 'bbb'); // no folder open: the most recent
assert.strictEqual(loadRoadmap(['/work/other'], home), null);
assert.strictEqual(loadRoadmap(['/work/project-a/sub-folder'], home).tasks.at(-1).id, '10');
assert.strictEqual(loadRoadmap(['/work'], os.tmpdir() + '/missing'), null);

assert.strictEqual(bar(1, 3), '▰▰▰▱▱▱▱▱▱▱');
assert.strictEqual(bar(0, 0), '▱▱▱▱▱▱▱▱▱▱');

// files per step, read incrementally (a line split across two writes, accents included)
const tool = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
fs.appendFileSync(transcript('aaa'), [tool('TaskUpdate', { taskId: '1', status: 'in_progress' }), tool('Edit', { file_path: '/p/a.js' }),
  tool('Write', { file_path: '/p/b.js' }), tool('TaskUpdate', { taskId: '2', status: 'in_progress' })].join('\n') + '\n');
const half = tool('Edit', { file_path: '/p/écran.js' });
fs.appendFileSync(transcript('aaa'), half.slice(0, 40));
let f = filesByStep('aaa', home);
assert.deepStrictEqual([...f['1']], ['/p/a.js', '/p/b.js'].map(path.normalize));
assert.strictEqual(f['2'], undefined);
fs.appendFileSync(transcript('aaa'), half.slice(40) + '\n');
f = filesByStep('aaa', home);
assert.deepStrictEqual([...f['2']], ['/p/écran.js'].map(path.normalize));

// "Claude is waiting for you" signal: shown as long as the transcript has not moved since
const state = path.join(home, 'cairn', 'state');
fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(path.join(state, 'aaa.json'), JSON.stringify({ waiting: true, message: 'Bash permission', t: Date.now() / 1000 }));
age(transcript('aaa'), 60_000);
assert.strictEqual(readSignal(['/work/project-a'], home).kind, 'waiting');
assert.strictEqual(readSignal(['/work/project-b'], home), null); // other folder
fs.utimesSync(transcript('aaa'), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000)); // Claude moved on
assert.strictEqual(readSignal(['/work/project-a'], home), null);

// rendering: escaped text, percentage, step in progress, files, signal, sessions, log
const r = { sid: 'aaa', done: 1, total: 2, cwd: '/work/<b>project</b>', mtime: Date.now(), tasks: [
  { id: '1', subject: 'A', status: 'completed', mtime: Date.now() },
  { id: '2', subject: '<img src=x onerror=alert(1)>', activeForm: 'Coding', status: 'in_progress', mtime: Date.now() - 5 * 60000 },
] };
const html = render(r, { files: { 2: new Set(['/p/<script>.js']) }, signal: { kind: 'waiting', message: '<b>Bash</b>' },
  pills: [r, { sid: 'zzz', done: 0, total: 3, mtime: Date.now() }], log: [{ sid: 'old', done: 2, total: 2, mtime: 0, tasks: [{ subject: 'Older' }] }] });
assert(!html.includes('<img') && !html.includes('<b>project') && !html.includes('<script>') && !html.includes('<b>Bash'), 'text must be escaped');
assert(html.includes('<b>1</b><span>/2</span>') && html.includes('class="cur"') && html.includes('Coding') && html.includes('since ') && html.includes('· 5 min'));
assert(html.includes('data-open="/p/&lt;script&gt;.js"') && html.includes('Claude is waiting for you') && html.includes('data-sid="zzz"') && html.includes('Log · 1'));
const summit = { done: 1, total: 1, tasks: [{ id: '1', subject: 'A', status: 'completed', mtime: 1 }], mtime: 1 };
assert(render(summit).includes('Summit reached') && render(summit).includes('old roadmap'));
assert(render(null).includes('Nothing to mark yet') && render(null, { lang: 'fr' }).includes('Rien à baliser'));
assert(renderApp(r, { lang: 'fr' }).includes('EN COURS') && renderApp(r, { lang: 'fr', signal: { kind: 'waiting' } }).includes('t&#39;attend'));
// every direct child of a container updated piece by piece carries a data-k key
for (const m of renderApp(r, { pills: [r, r], log: [] }).matchAll(/<(main|ol|header|nav|li|div class="(?:card|row|cardtop)")[^>]*>/g)) {
  assert(m[0].includes('data-k='), `missing key: ${m[0]}`);
}

// start and end of steps, Claude Code's "before the step" backups, files changed by commands
const t0 = Date.now() - 600_000;
const iso = (ms) => new Date(ms).toISOString();
const line = (ts, name, input) => JSON.stringify({ type: 'assistant', timestamp: iso(ts), message: { content: [{ type: 'tool_use', name, input }] } });
const snapshot = (files) => JSON.stringify({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: files } });
session('ddd', '/work/project-d', ['completed', 'in_progress'], 0);
fs.appendFileSync(transcript('ddd'), [
  line(t0, 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
  snapshot({ 'src/a.js': { backupFileName: 'aaaa1111@v1', version: 1, backupTime: iso(t0 + 1000), realParentDir: '/work/project-d/src' } }),
  line(t0 + 2000, 'Edit', { file_path: '/work/project-d/src/a.js' }),
  line(t0 + 60_000, 'TaskUpdate', { taskId: '1', status: 'completed' }),
  line(t0 + 61_000, 'TaskUpdate', { taskId: '2', status: 'in_progress' }),
  snapshot({ 'src/a.js': { backupFileName: 'bbbb2222@v2', version: 2, backupTime: iso(t0 + 62_000), realParentDir: '/work/project-d/src' },
    'new.js': { backupFileName: null, version: 1, backupTime: iso(t0 + 63_000), realParentDir: '/work/project-d' } }),
].join('\n') + '\n');
const tr = traceOf('ddd', home);
assert.deepStrictEqual([tr.start['1'], tr.end['1'], tr.start['2']], [t0, t0 + 60_000, t0 + 61_000]);
assert.strictEqual(backupBefore(tr, '/work/project-d/src/a.js', tr.start['1']).name, 'aaaa1111@v1');
assert.strictEqual(backupBefore(tr, '/work/project-d/src/a.js', tr.start['2']).name, 'bbbb2222@v2');
assert.strictEqual(backupBefore(tr, '/work/project-d/new.js', tr.start['2']).name, null); // created during the step
assert.strictEqual(backupBefore(tr, '/work/project-d/other.js', tr.start['2']), undefined);
const viaCmd = path.join(home, 'generated.txt'), before = path.join(home, 'old.txt');
fs.writeFileSync(viaCmd, 'x');
fs.utimesSync(viaCmd, new Date(t0 + 120_000), new Date(t0 + 120_000)); // during step 2 (in progress)
fs.writeFileSync(before, 'x');
fs.utimesSync(before, new Date(t0 - 60_000), new Date(t0 - 60_000)); // before any step
const byCmd = filesByCommand([{ id: '1', status: 'completed' }, { id: '2', status: 'in_progress' }], tr, [viaCmd, before, '/work/project-d/src/a.js']);
assert.deepStrictEqual(Object.keys(byCmd), ['2']);
assert.deepStrictEqual([...byCmd['2']], [viaCmd]);
assert(renderApp({ ...r, tasks: [r.tasks[0], { ...r.tasks[1], id: '2' }] }, { cmdFiles: { 2: new Set([viaCmd]) } }).includes('class="cmd" data-open='));

// announcement for screen readers
assert.strictEqual(announcement(r, null), 'In progress: Coding — 1/2 steps done');
assert.strictEqual(announcement(r, null, 'fr'), 'En cours : Coding — 1/2 étapes faites');
assert.strictEqual(announcement(r, { kind: 'waiting', message: 'm' }), 'Claude is waiting for you: m');
assert.strictEqual(announcement(null, null), '');

// theme color contrasts (WCAG: 4.5 for body text, 3 for large text)
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
for (const [text, bg, min, what] of [
  ['#121212', '#FFFDF8', 4.5, 'light text'], ['#5E5A52', '#FFFDF8', 4.5, 'light muted text'], ['#8A857B', '#FFFDF8', 3, 'light big number'],
  ['#F4F0E8', '#222226', 4.5, 'dark text'], ['#C9C4BA', '#222226', 4.5, 'dark muted text'], ['#85807A', '#222226', 3, 'dark big number'],
  ['#FFFFFF', '#2B3BFF', 4.5, 'card in progress'], ['#121212', '#FF7AD9', 4.5, 'stickers'],
  ['#121212', '#F3F3F3', 4.5, 'pills on light background'], ['#F4F0E8', '#181818', 4.5, 'pills on dark background'],
]) assert(contrast(text, bg) >= min, `${what}: ${contrast(text, bg).toFixed(2)} < ${min}`);

// the view only allows its own script and the extension's fonts, which do exist
const page = shell('N0NCE', 'https://ext.vscode-resource', fontFaces((f) => `https://ext.vscode-resource/fonts/${f}`));
assert(page.includes("script-src 'nonce-N0NCE'; font-src https://ext.vscode-resource;") && page.includes("default-src 'none'"));
assert(page.includes("font-family:'Bricolage Grotesque'") && page.includes('/fonts/JetBrainsMono.woff2'));
assert(page.includes('aria-live="polite"') && page.includes('acquireVsCodeApi') && !page.includes('EventSource'));
const web = shell('N', "'self'", '', true);
assert(web.includes("connect-src 'self'") && web.includes('new EventSource') && !web.includes('acquireVsCodeApi'));
for (const f of ['BricolageGrotesque.woff2', 'JetBrainsMono.woff2']) {
  assert.strictEqual(fs.readFileSync(path.join(__dirname, 'media', 'fonts', f)).subarray(0, 4).toString(), 'wOF2', f);
}

// the manifest's %placeholders% all exist in English and in French
const manifest = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8');
for (const nls of ['package.nls.json', 'package.nls.fr.json']) {
  const keys = JSON.parse(fs.readFileSync(path.join(__dirname, nls), 'utf8'));
  for (const [, k] of manifest.matchAll(/"%([\w.]+)%"/g)) assert(keys[k], `${nls}: ${k} missing`);
}

fs.rmSync(home, { recursive: true });
console.log('ok');
