// node test.js — vérifie le choix de la session et le calcul d'avancement sur un faux ~/.claude
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadRoadmap, bar, render } = require('./extension.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roadmap-'));
const session = (sid, cwd, statuses, ageMs) => {
  fs.mkdirSync(path.join(home, 'projects', 'p-' + sid), { recursive: true });
  fs.writeFileSync(path.join(home, 'projects', 'p-' + sid, sid + '.jsonl'), JSON.stringify({ type: 'user', cwd }) + '\n');
  const dir = path.join(home, 'tasks', sid);
  fs.mkdirSync(dir, { recursive: true });
  statuses.forEach((status, i) => {
    const f = path.join(dir, `${i + 1}.json`);
    fs.writeFileSync(f, JSON.stringify({ id: String(i + 1), subject: `Étape ${i + 1}`, status }));
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(f, t, t);
  });
};

session('aaa', '/work/projet-a', ['completed', 'in_progress', 'pending'], 60_000);
session('bbb', '/work/projet-b', ['completed', 'completed'], 0); // plus récente, autre dossier
// 10 étapes pour vérifier le tri numérique (10 après 9)
session('ccc', '/work/projet-a/sous-dossier', Array(10).fill('pending'), 120_000);

const a = loadRoadmap(['/work/projet-a'], home);
assert.strictEqual(a.sid, 'aaa');
assert.deepStrictEqual([a.done, a.total], [1, 3]);

assert.strictEqual(loadRoadmap(['/work/projet-b'], home).sid, 'bbb');
assert.strictEqual(loadRoadmap([], home).sid, 'bbb'); // aucun dossier ouvert : la plus récente
assert.strictEqual(loadRoadmap(['/work/autre'], home), null);
assert.strictEqual(loadRoadmap(['/work/projet-a/sous-dossier'], home).tasks.at(-1).id, '10');
assert.strictEqual(loadRoadmap(['/work'], os.tmpdir() + '/absent'), null);

assert.strictEqual(bar(1, 3), '▰▰▰▱▱▱▱▱▱▱');
assert.strictEqual(bar(0, 0), '▱▱▱▱▱▱▱▱▱▱');

// la frise : texte des tâches échappé, pourcentage, étape en cours
const html = render({ done: 1, total: 2, tasks: [
  { id: '1', subject: 'A', status: 'completed' },
  { id: '2', subject: '<img src=x onerror=alert(1)>', activeForm: 'Codage', status: 'in_progress' },
] });
assert(!html.includes('<img'), 'le texte des tâches doit être échappé');
assert(html.includes('50<small>') && html.includes('step current') && html.includes('Codage'));
assert(render(null).includes('Pas encore de roadmap'));

fs.rmSync(home, { recursive: true });
console.log('ok');
