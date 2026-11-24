// node test.js — vérifie la lecture des sessions, des fichiers par étape, des signaux et le rendu, sur un faux ~/.claude
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadRoadmap, loadSessions, filesByStep, traceOf, sauvegardeAvant, filesParCommande, readSignal, annonce, bar, render, renderApp, shell, polices } = require('./extension.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-'));
const transcript = (sid) => path.join(home, 'projects', 'p-' + sid, sid + '.jsonl');
const vieillir = (f, ageMs) => { const t = new Date(Date.now() - ageMs); fs.utimesSync(f, t, t); };
const session = (sid, cwd, statuses, ageMs) => {
  fs.mkdirSync(path.dirname(transcript(sid)), { recursive: true });
  fs.writeFileSync(transcript(sid), JSON.stringify({ type: 'user', cwd }) + '\n');
  vieillir(transcript(sid), ageMs);
  const dir = path.join(home, 'tasks', sid);
  fs.mkdirSync(dir, { recursive: true });
  statuses.forEach((status, i) => {
    const f = path.join(dir, `${i + 1}.json`);
    fs.writeFileSync(f, JSON.stringify({ id: String(i + 1), subject: `Étape ${i + 1}`, status }));
    vieillir(f, ageMs);
  });
};

session('aaa', '/work/projet-a', ['completed', 'in_progress', 'pending'], 60_000);
session('bbb', '/work/projet-b', ['completed', 'completed'], 0); // plus récente, autre dossier
// 10 étapes pour vérifier le tri numérique (10 après 9)
session('ccc', '/work/projet-a/sous-dossier', Array(10).fill('pending'), 120_000);

// sessions du dossier, récentes d'abord
const a = loadRoadmap(['/work/projet-a'], home);
assert.strictEqual(a.sid, 'aaa');
assert.deepStrictEqual([a.done, a.total], [1, 3]);
assert.deepStrictEqual(loadSessions(['/work/projet-a'], home).map((s) => s.sid), ['aaa', 'ccc']);
assert.strictEqual(loadRoadmap(['/work/projet-b'], home).sid, 'bbb');
assert.strictEqual(loadRoadmap([], home).sid, 'bbb'); // aucun dossier ouvert : la plus récente
assert.strictEqual(loadRoadmap(['/work/autre'], home), null);
assert.strictEqual(loadRoadmap(['/work/projet-a/sous-dossier'], home).tasks.at(-1).id, '10');
assert.strictEqual(loadRoadmap(['/work'], os.tmpdir() + '/absent'), null);

assert.strictEqual(bar(1, 3), '▰▰▰▱▱▱▱▱▱▱');
assert.strictEqual(bar(0, 0), '▱▱▱▱▱▱▱▱▱▱');

// fichiers par étape, lus au fil de l'eau (ligne coupée en deux écritures, accents compris)
const outil = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
fs.appendFileSync(transcript('aaa'), [outil('TaskUpdate', { taskId: '1', status: 'in_progress' }), outil('Edit', { file_path: '/p/a.js' }),
  outil('Write', { file_path: '/p/b.js' }), outil('TaskUpdate', { taskId: '2', status: 'in_progress' })].join('\n') + '\n');
const moitie = outil('Edit', { file_path: '/p/écran.js' });
fs.appendFileSync(transcript('aaa'), moitie.slice(0, 40));
let f = filesByStep('aaa', home);
assert.deepStrictEqual([...f['1']], ['/p/a.js', '/p/b.js']);
assert.strictEqual(f['2'], undefined);
fs.appendFileSync(transcript('aaa'), moitie.slice(40) + '\n');
f = filesByStep('aaa', home);
assert.deepStrictEqual([...f['2']], ['/p/écran.js']);

// signal « Claude t'attend » : affiché tant que le transcript n'a pas bougé depuis
const etat = path.join(home, 'cairn', 'etat');
fs.mkdirSync(etat, { recursive: true });
fs.writeFileSync(path.join(etat, 'aaa.json'), JSON.stringify({ attente: true, message: 'permission Bash', t: Date.now() / 1000 }));
vieillir(transcript('aaa'), 60_000);
assert.strictEqual(readSignal(['/work/projet-a'], home).kind, 'attente');
assert.strictEqual(readSignal(['/work/projet-b'], home), null); // autre dossier
fs.utimesSync(transcript('aaa'), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000)); // Claude a repris
assert.strictEqual(readSignal(['/work/projet-a'], home), null);

// rendu : texte échappé, pourcentage, étape en cours, fichiers, signal, sessions, journal
const r = { sid: 'aaa', done: 1, total: 2, cwd: '/work/<b>projet</b>', mtime: Date.now(), tasks: [
  { id: '1', subject: 'A', status: 'completed', mtime: Date.now() },
  { id: '2', subject: '<img src=x onerror=alert(1)>', activeForm: 'Codage', status: 'in_progress', mtime: Date.now() - 5 * 60000 },
] };
const html = render(r, { files: { 2: new Set(['/p/<script>.js']) }, signal: { kind: 'attente', message: '<b>Bash</b>' },
  pills: [r, { sid: 'zzz', done: 0, total: 3, mtime: Date.now() }], journal: [{ sid: 'old', done: 2, total: 2, mtime: 0, tasks: [{ subject: 'Ancienne' }] }] });
assert(!html.includes('<img') && !html.includes('<b>projet') && !html.includes('<script>') && !html.includes('<b>Bash'), 'le texte doit être échappé');
assert(html.includes('<b>1</b><span>/2</span>') && html.includes('class="cur"') && html.includes('Codage') && html.includes('depuis ') && html.includes('· 5 min'));
assert(html.includes('data-open="/p/&lt;script&gt;.js"') && html.includes('t&#39;attend') && html.includes('data-sid="zzz"') && html.includes('Journal · 1'));
assert(render({ done: 1, total: 1, tasks: [{ id: '1', subject: 'A', status: 'completed', mtime: 1 }], mtime: 1 }).includes('Sommet atteint'));
assert(render({ done: 1, total: 1, tasks: [{ id: '1', subject: 'A', status: 'completed', mtime: 1 }], mtime: 1 }).includes('ancienne roadmap'));
assert(render(null).includes('Rien à baliser') && render(null, { lang: 'en' }).includes('Nothing to mark yet'));
assert(renderApp(r, { lang: 'en' }).includes('IN PROGRESS'));
// chaque enfant direct d'un conteneur mis à jour par morceaux porte une clé data-k
for (const m of renderApp(r, { pills: [r, r], journal: [] }).matchAll(/<(main|ol|header|nav|li|div class="(?:card|row|cardtop)")[^>]*>/g)) {
  assert(m[0].includes('data-k='), `clé manquante : ${m[0]}`);
}

// début et fin des étapes, copies « avant l'étape » de Claude Code, fichiers modifiés par commande
const t0 = Date.now() - 600_000;
const iso = (ms) => new Date(ms).toISOString();
const ligne = (ts, name, input) => JSON.stringify({ type: 'assistant', timestamp: iso(ts), message: { content: [{ type: 'tool_use', name, input }] } });
const instantane = (fichiers) => JSON.stringify({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: fichiers } });
session('ddd', '/work/projet-d', ['completed', 'in_progress'], 0);
fs.appendFileSync(transcript('ddd'), [
  ligne(t0, 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
  instantane({ 'src/a.js': { backupFileName: 'aaaa1111@v1', version: 1, backupTime: iso(t0 + 1000), realParentDir: '/work/projet-d/src' } }),
  ligne(t0 + 2000, 'Edit', { file_path: '/work/projet-d/src/a.js' }),
  ligne(t0 + 60_000, 'TaskUpdate', { taskId: '1', status: 'completed' }),
  ligne(t0 + 61_000, 'TaskUpdate', { taskId: '2', status: 'in_progress' }),
  instantane({ 'src/a.js': { backupFileName: 'bbbb2222@v2', version: 2, backupTime: iso(t0 + 62_000), realParentDir: '/work/projet-d/src' },
    'neuf.js': { backupFileName: null, version: 1, backupTime: iso(t0 + 63_000), realParentDir: '/work/projet-d' } }),
].join('\n') + '\n');
const tr = traceOf('ddd', home);
assert.deepStrictEqual([tr.debut['1'], tr.fin['1'], tr.debut['2']], [t0, t0 + 60_000, t0 + 61_000]);
assert.strictEqual(sauvegardeAvant(tr, '/work/projet-d/src/a.js', tr.debut['1']).nom, 'aaaa1111@v1');
assert.strictEqual(sauvegardeAvant(tr, '/work/projet-d/src/a.js', tr.debut['2']).nom, 'bbbb2222@v2');
assert.strictEqual(sauvegardeAvant(tr, '/work/projet-d/neuf.js', tr.debut['2']).nom, null); // créé pendant l'étape
assert.strictEqual(sauvegardeAvant(tr, '/work/projet-d/autre.js', tr.debut['2']), undefined);
const viaCmd = path.join(home, 'genere.txt'), avant = path.join(home, 'vieux.txt');
fs.writeFileSync(viaCmd, 'x');
fs.utimesSync(viaCmd, new Date(t0 + 120_000), new Date(t0 + 120_000)); // pendant l'étape 2 (en cours)
fs.writeFileSync(avant, 'x');
fs.utimesSync(avant, new Date(t0 - 60_000), new Date(t0 - 60_000)); // avant toute étape
const parCmd = filesParCommande([{ id: '1', status: 'completed' }, { id: '2', status: 'in_progress' }], tr, [viaCmd, avant, '/work/projet-d/src/a.js']);
assert.deepStrictEqual(Object.keys(parCmd), ['2']);
assert.deepStrictEqual([...parCmd['2']], [viaCmd]);
assert(renderApp({ ...r, tasks: [r.tasks[0], { ...r.tasks[1], id: '2' }] }, { cmdFiles: { 2: new Set([viaCmd]) } }).includes('class="cmd" data-open='));

// annonce pour les lecteurs d'écran
assert.strictEqual(annonce(r, null), 'En cours : Codage — 1/2 étapes faites');
assert.strictEqual(annonce(r, { kind: 'attente', message: 'm' }, 'en'), 'Claude is waiting for you: m');
assert.strictEqual(annonce(null, null), '');

// contrastes des couleurs du thème (WCAG : 4,5 pour le texte courant, 3 pour le grand texte)
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contraste = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
for (const [texte, fond, mini, quoi] of [
  ['#121212', '#FFFDF8', 4.5, 'texte clair'], ['#5E5A52', '#FFFDF8', 4.5, 'texte discret clair'], ['#8A857B', '#FFFDF8', 3, 'grand chiffre clair'],
  ['#F4F0E8', '#222226', 4.5, 'texte sombre'], ['#C9C4BA', '#222226', 4.5, 'texte discret sombre'], ['#85807A', '#222226', 3, 'grand chiffre sombre'],
  ['#FFFFFF', '#2B3BFF', 4.5, 'carte en cours'], ['#121212', '#FF7AD9', 4.5, 'autocollants'],
  ['#121212', '#F3F3F3', 4.5, 'pastilles sur fond clair'], ['#F4F0E8', '#181818', 4.5, 'pastilles sur fond sombre'],
]) assert(contraste(texte, fond) >= mini, `${quoi} : ${contraste(texte, fond).toFixed(2)} < ${mini}`);

// la vue n'autorise que son script et les polices de l'extension, qui existent bien
const page = shell('N0NCE', 'https://ext.vscode-resource', polices((f) => `https://ext.vscode-resource/fonts/${f}`));
assert(page.includes("script-src 'nonce-N0NCE'; font-src https://ext.vscode-resource;") && page.includes("default-src 'none'"));
assert(page.includes("font-family:'Bricolage Grotesque'") && page.includes('/fonts/JetBrainsMono.woff2'));
assert(page.includes('aria-live="polite"') && page.includes('acquireVsCodeApi') && !page.includes('EventSource'));
const web = shell('N', "'self'", '', true);
assert(web.includes("connect-src 'self'") && web.includes('new EventSource') && !web.includes('acquireVsCodeApi'));
for (const f of ['BricolageGrotesque.woff2', 'JetBrainsMono.woff2']) {
  assert.strictEqual(fs.readFileSync(path.join(__dirname, 'media', 'fonts', f)).subarray(0, 4).toString(), 'wOF2', f);
}

fs.rmSync(home, { recursive: true });
console.log('ok');
