// node test.js — checks reading sessions, files per step, signals and rendering, against a fake ~/.claude
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadRoadmap, loadSessions, loadHistory, filesByStep, traceOf, backupBefore, filesByCommand, readSignal, readSteer, steer, stepStats, WRITES, timeLeft, trail, announcement, toMarkdown, bar, render, renderApp, shell, fontFaces } = require('./extension.js');

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
session('ord', '/work/project-o', ['completed', 'in_progress', 'pending', 'completed'], 0); // step 4 added later, already done
assert.deepStrictEqual(loadRoadmap(['/work/project-o'], home).tasks.map((x) => x.id), ['1', '4', '2', '3']);
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
  pills: [r, { sid: 'zzz', done: 0, total: 3, mtime: Date.now() }] });
assert(!html.includes('<img') && !html.includes('<b>project') && !html.includes('<script>') && !html.includes('<b>Bash'), 'text must be escaped');
assert(html.includes('<b>Step 2 of 2</b>') && html.includes('class="cur"') && html.includes('Coding') && html.includes('since ') && html.includes('· 5 min'));
assert(html.includes('data-open="/p/&lt;script&gt;.js"') && html.includes('Claude is waiting for you') && html.includes('data-sid="zzz"'));
// finished steps stay readable: highlighted, never struck through; the tabs say how far along the roadmap is
assert(html.includes('<span class="t" data-k="t" title="A">A</span>') && html.includes('aria-pressed="true">Now · 1/2</button>'));
// the trail: one stone per step, the current one ringed; the summit flag won once everything is done
assert(html.includes('class="trail-map"') && html.includes('aria-label="Step 2 of 2 on the way to the summit"') && html.includes('class="ring"'));
for (const n of [1, 2, 7, 15]) {
  const svg = trail(Array.from({ length: n }, (_, i) => ({ id: String(i + 1), status: i < n / 2 ? 'completed' : 'pending' })), { here: 'h', summit: 's', onTrail: () => 'o', atStart: () => 'a' });
  assert(!svg.includes('NaN') && (svg.match(/<circle/g) || []).length === n, `trail of ${n}`);
}
assert(trail([{ id: '1', status: 'completed' }], { summit: 'S' }).includes('class="peak won"'));
const summit = { done: 1, total: 1, tasks: [{ id: '1', subject: 'A', status: 'completed', mtime: 1 }], mtime: 1 };
assert(render(summit).includes('Summit reached') && render(summit).includes('old roadmap'));
assert(render(null).includes('Nothing to mark yet') && render(null, { lang: 'fr' }).includes('Rien à baliser'));
assert(renderApp(r, { lang: 'fr' }).includes('EN COURS') && renderApp(r, { lang: 'fr', signal: { kind: 'waiting' } }).includes('t&#39;attend'));
// every direct child of a container updated piece by piece carries a data-k key
for (const m of renderApp(r, { pills: [r, r] }).matchAll(/<(main|ol|header|nav|li|div class="(?:card|row|cardtop|cardfoot|hero|now[^"]*)")(?=[\s>])[^>]*>/g)) {
  assert(m[0].includes('data-k='), `missing key: ${m[0]}`);
}

// start and end of steps, Claude Code's "before the step" backups, files changed by commands
const t0 = Date.now() - 600_000;
const iso = (ms) => new Date(ms).toISOString();
const line = (ts, name, input) => JSON.stringify({ type: 'assistant', timestamp: iso(ts), message: { content: [{ type: 'tool_use', name, input }] } });
const result = (ts, toolUseResult) => JSON.stringify({ type: 'user', timestamp: iso(ts), toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const snapshot = (files) => JSON.stringify({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: files } });
session('ddd', '/work/project-d', ['completed', 'in_progress'], 0);
fs.appendFileSync(transcript('ddd'), [
  line(t0, 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
  snapshot({ 'src/a.js': { backupFileName: 'aaaa1111@v1', version: 1, backupTime: iso(t0 + 1000), realParentDir: '/work/project-d/src' } }),
  line(t0 + 2000, 'Edit', { file_path: '/work/project-d/src/a.js', new_string: '"file-history-snapshot" "structuredPatch"' }),
  result(t0 + 2100, { filePath: '/work/project-d/src/a.js', structuredPatch: [{ lines: [' ctx', '-old', '+new', '+more'] }] }),
  result(t0 + 3000, { type: 'create', filePath: '/work/project-d/src/b.js', content: 'a\nb\n', structuredPatch: [] }),
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

// history kept by the hook: read, filtered by folder, listed by day, opened, copied as Markdown, shown wide in a tab
const hdir = path.join(home, 'cairn', 'history');
fs.mkdirSync(hdir, { recursive: true });
const s0 = Date.now() / 1000 - 3600;
fs.writeFileSync(path.join(hdir, 'hh.json'), JSON.stringify({ cwd: '/work/project-a', roadmaps: [
  { title: 'ok go on', start: s0, end: s0 + 600, steps: [
    { id: '1', subject: 'Read the <dark> code', status: 'completed', created: s0, started: s0, ended: s0 + 240 },
    { id: '2', subject: 'Write the screen', status: 'completed', created: s0, started: s0 + 240, ended: s0 + 600, files: ['/work/project-a/Settings.tsx'] },
    { id: '3', subject: 'Dropped', status: 'deleted', created: s0 }] },
  { title: 'Fix the login loop', start: s0 - 2 * 86400, end: s0 - 2 * 86400 + 300, steps: [
    { id: '4', subject: 'Find the loop', status: 'completed', created: s0 - 2 * 86400, ended: s0 - 2 * 86400 + 300 },
    { id: '5', subject: 'Fix it', status: 'pending', created: s0 - 2 * 86400 }] },
  { title: 'Only dropped steps', start: s0, steps: [{ id: '6', subject: 'x', status: 'deleted', created: s0 }] }] }));
fs.writeFileSync(path.join(hdir, 'other.json'), JSON.stringify({ cwd: '/work/project-b', roadmaps: [
  { title: 'Elsewhere', start: s0 + 60, end: s0 + 120, steps: [{ id: '1', subject: 'y', status: 'completed', created: s0 + 60, ended: s0 + 120 }] }] }));
fs.writeFileSync(path.join(hdir, 'broken.json'), '{');
const hist = loadHistory(['/work/project-a'], home);
assert.deepStrictEqual(hist.map((e) => [e.steps[0].subject, e.here, e.done, e.total]),
  [['Read the <dark> code', true, 2, 2], ['y', false, 1, 1], ['Find the loop', true, 1, 2]]);
assert.strictEqual(hist[0].steps[1].ended - hist[0].steps[1].started, 360_000);
const list = renderApp(null, { tab: 'history', history: hist, lang: 'en' });
// a roadmap is named after its first step, never after the request (old files still hold one); the others under it
assert(list.includes('<b>Read the &lt;dark&gt; code</b><span class="hsteps">Write the screen</span>') && !list.includes('ok go on') && !list.includes('<dark>') && list.includes('data-pick="hh:0"') && list.includes('data-here="0"'));
assert(list.includes('<h3 data-k="dh">today</h3>') && list.includes('stopped · 1/2') && list.includes('2/2 ✓') && list.includes('data-text="read the &lt;dark&gt; code write the screen settings.tsx"'));
const opened = renderApp(null, { tab: 'history', history: hist, pick: 'hh:0', lang: 'en' });
assert(opened.includes('data-pick=""') && opened.includes('6 min · <button data-open="/work/project-a/Settings.tsx"') && opened.includes('All files · 1') && !opened.includes('Find the loop'));
assert.strictEqual(toMarkdown(hist[0], 'en').split('\n').slice(2).join('\n'), '\n- [x] Read the <dark> code — 4 min\n- [x] Write the screen — 6 min · `Settings.tsx`');
assert(opened.includes(`data-copy="${'### Read the &lt;dark&gt; code'}`));
const tab = renderApp(null, { layout: 'tab', history: hist, pick: 'hh:0', lang: 'en' });
assert(tab.includes('class="wide"') && tab.includes('this week · 3 roadmaps · 4 steps') && tab.includes('Find the loop') && tab.includes('class="long"') && tab.includes('data-period="7"'));
assert(renderApp(null, { tab: 'history', history: [], lang: 'fr' }).includes('Aucune roadmap gardée'));

// +/− per step, counted from the edits' results (an edit whose text mentions those markers is still an edit)
assert.deepStrictEqual([...tr.files['1']], [path.normalize('/work/project-d/src/a.js')]);
assert.deepStrictEqual(stepStats('ddd', [{ id: '1' }, { id: '2' }, { id: '3' }], tr), { 1: { add: 4, del: 1 }, 2: { add: 0, del: 0 } });
// step 2 runs tests: no false "no change"; then a script that writes: its numbers would be partial, so none
fs.appendFileSync(transcript('ddd'), line(t0 + 70_000, 'Bash', { command: 'npm test 2>&1 | tail -3 > /dev/null' }) + '\n');
fs.appendFileSync(transcript('ddd'), result(t0 + 71_000, { filePath: '/work/project-d/c.js', structuredPatch: [{ lines: ['+x'] }] }) + '\n');
assert.deepStrictEqual(stepStats('ddd', [{ id: '1' }, { id: '2' }], traceOf('ddd', home)), { 1: { add: 4, del: 1 }, 2: { add: 1, del: 0 } });
fs.appendFileSync(transcript('ddd'), line(t0 + 72_000, 'Bash', { command: "python3 - <<'EOF'\nopen('c.js','w')\nEOF" }) + '\n');
assert.deepStrictEqual(stepStats('ddd', [{ id: '1' }, { id: '2' }], traceOf('ddd', home)), { 1: { add: 4, del: 1 } });
const writes = ['cat > a.txt', 'echo x >> log', "python3 - <<'EOF'", 'sed -i "" s/a/b/ f', 'mv a b', 'rm -rf build', 'git checkout -- f', 'npm test | tee out'];
const reads = ['npm test 2>&1 | tail -3', 'grep -n x f > /dev/null', 'sed -n 1,9p f', 'git diff --stat', 'uv run pytest -q', 'ls -la', 'a && b || c'];
assert(writes.every((c) => WRITES.test(c)) && !reads.some((c) => WRITES.test(c)), [...writes.filter((c) => !WRITES.test(c)), ...reads.filter((c) => WRITES.test(c))].join(' / '));
assert(!renderApp(r, { stats: { 1: { add: 3, del: 0 } }, cmdFiles: { 1: new Set(['/x']) } }).includes('+3')); // partial: no numbers
// exact numbers from the hook's snapshots win, whatever wrote the files
fs.mkdirSync(path.join(home, 'cairn', 'snaps'), { recursive: true });
fs.writeFileSync(path.join(home, 'cairn', 'snaps', 'ddd.json'), JSON.stringify({ cur: '2', steps: { 2: { start: 'a', end: 'b', add: 12, del: 3 } } }));
assert.deepStrictEqual(stepStats('ddd', [{ id: '1' }, { id: '2' }], traceOf('ddd', home), home), { 1: { add: 4, del: 1 }, 2: { add: 12, del: 3, exact: true } });
assert(renderApp(r, { stats: { 1: { add: 3, del: 0, exact: true } }, cmdFiles: { 1: new Set(['/x']) } }).includes('+3'));
const withStats = renderApp(r, { stats: { 1: { add: 38, del: 4 } } });
assert(withStats.includes('<span class="add">+38</span> <span class="del">−4</span>'));
assert(renderApp(r, { stats: { 1: { add: 0, del: 0 } } }).includes('no change'));
// time left, from the median step of the history
const timed = [{ steps: Array.from({ length: 5 }, () => ({ started: 0, ended: 60_000 })) }];
assert.strictEqual(timeLeft({ total: 2, tasks: [{ status: 'in_progress' }, { status: 'pending' }] }, timed), 90_000);
assert.strictEqual(timeLeft(r, []), 0);
assert(renderApp(r, { eta: 12 * 60000 }).includes('~12 min to the summit'));

// steering: the view writes the user's notes and edits; titles come from the roadmap; at most 10 waiting
const tasks = [{ id: '7', subject: 'Write the screen' }, { id: '8', subject: 'Test it' }];
assert.strictEqual(steer('../x', { kind: 'go' }, tasks, home), false);
assert.strictEqual(steer('sv', { kind: 'remove', step: '99' }, tasks, home), false);
assert.strictEqual(steer('sv', { kind: 'note', step: '99', text: 'x' }, tasks, home), false);
assert.strictEqual(steer('sv', { kind: 'note', step: '7', text: '   ' }, tasks, home), false);
assert(steer('sv', { kind: 'note', step: '7', text: 'Reuse\u0007the client', subject: 'forged' }, tasks, home));
assert(steer('sv', { kind: 'remove', step: '8' }, tasks, home));
assert(steer('sv', { kind: 'add', text: 'Update the docs' }, tasks, home));
let sv = readSteer('sv', home);
assert.deepStrictEqual(sv.items.map((i) => [i.kind, i.step, i.subject, i.text]),
  [['note', '7', 'Write the screen', 'Reuse the client'], ['remove', '8', 'Test it', ''], ['add', '', '', 'Update the docs']]);
if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(home, 'cairn', 'steer', 'sv.json')).mode & 0o777, 0o600);
assert(steer('sv', { kind: 'cancel', id: sv.items[2].id }, tasks, home) && readSteer('sv', home).items.length === 2);
assert(steer('sv', { kind: 'note', text: 'Smaller steps please', go: true }, tasks, home) && readSteer('sv', home).gate === 'go');
for (let i = 0; i < 9; i++) steer('sv', { kind: 'add', text: `extra ${i}` }, tasks, home);
assert.strictEqual(readSteer('sv', home).items.filter((i) => !i.sent).length, 10);
// plan review: the plan waits for the user's go; steps can be noted, removed, added
const planned = { sid: 'sv', done: 0, total: 2, mtime: Date.now(), tasks: tasks.map((x) => ({ ...x, status: 'pending' })) };
const review = renderApp(planned, { steer: { gate: 'held', items: [
  { id: 'n1', kind: 'note', step: '7', subject: 'Write the screen', text: 'Reuse the client', sent: false },
  { id: 'r1', kind: 'remove', step: '8', subject: 'Test it', sent: false },
  { id: 'a1', kind: 'add', text: 'Update the docs', sent: false }] }, composing: 'plan' });
assert(review.includes('Claude has a plan · 2 steps') && review.includes('data-go="1"') && review.includes('class="now gate"'));
assert(review.includes('NOTE FOR CLAUDE · at its next action') && review.includes('data-cancel="n1"') && review.includes('class="todo gone"'));
assert(review.includes('data-k="ad-a1"') && review.includes('data-also-go="1"') && review.includes('<textarea name="text"'));
assert(!review.includes('data-remove="8"') && review.includes('data-remove="7"') && review.includes('data-compose="add"'));
const approved = renderApp(planned, { steer: { gate: 'go', items: [] }, canTerminal: true });
assert(approved.includes('Approved · Claude has your go') && approved.includes('data-terminal="1"') && !approved.includes('data-go="1"'));

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
