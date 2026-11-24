// node web/test.js — lance la vue universelle sur un faux ~/.claude et vérifie la page, le flux en direct, la sélection
// d'une session et le refus des requêtes qui ne visent pas 127.0.0.1 / localhost.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-web-'));
const projet = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-projet-')));
const claude = path.join(home, 'claude');
for (const [sid, sujet] of [['s1', 'Écrire <le> code'], ['s2', 'Ancienne demande']]) {
  fs.mkdirSync(path.join(claude, 'tasks', sid), { recursive: true });
  fs.mkdirSync(path.join(claude, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'projects', 'p', sid + '.jsonl'), JSON.stringify({ type: 'user', cwd: projet }) + '\n');
  fs.writeFileSync(path.join(claude, 'tasks', sid, '1.json'), JSON.stringify({ id: '1', subject: sujet, status: sid === 's1' ? 'in_progress' : 'completed' }));
}
const vieux = new Date(Date.now() - 3 * 86400e3);
fs.utimesSync(path.join(claude, 'tasks', 's2', '1.json'), vieux, vieux);

const port = 4900 + Math.floor(Math.random() * 500);
const serveur = spawn(process.execPath, [path.join(__dirname, 'serve.js'), projet, '--port', String(port), '--lang', 'fr'],
  { env: { ...process.env, CLAUDE_CONFIG_DIR: claude }, stdio: ['ignore', 'pipe', 'inherit'] });

const requete = (chemin, { host = `127.0.0.1:${port}`, method = 'GET', corps } = {}) => new Promise((ok, ko) => {
  const req = http.request({ host: '127.0.0.1', port, path: chemin, method, headers: { host, 'content-type': 'application/json' } }, (res) => {
    let data = '';
    res.on('data', (d) => {
      data += d;
      if (chemin === '/events' && data.includes('\n\n')) { req.destroy(); ok({ status: res.statusCode, headers: res.headers, data }); }
    });
    res.on('end', () => ok({ status: res.statusCode, headers: res.headers, data }));
  });
  req.on('error', (e) => (e.code === 'ECONNRESET' ? null : ko(e)));
  req.end(corps);
});

(async () => {
  await new Promise((ok) => serveur.stdout.once('data', ok));
  const page = await requete('/');
  assert.strictEqual(page.status, 200);
  assert(page.data.includes("connect-src 'self'") && page.data.includes('new EventSource') && page.data.includes('/fonts/BricolageGrotesque.woff2'));
  assert.strictEqual((await requete('/', { host: `evil.example:${port}` })).status, 403, 'hôte étranger refusé');
  assert.strictEqual((await requete('/fonts/../../etc/passwd')).status, 404);
  assert.strictEqual((await requete('/fonts/BricolageGrotesque.woff2')).headers['content-type'], 'font/woff2');

  let flux = await requete('/events');
  assert(flux.data.startsWith('data: '), flux.data.slice(0, 80));
  let etat = JSON.parse(flux.data.slice(6));
  assert(etat.html.includes('Écrire &lt;le&gt; code') && !etat.html.includes('<le>') && etat.html.includes('Journal · 1'));
  assert.match(etat.annonce, /^En cours : Écrire <le> code — 0\/1 étapes faites$/);

  assert.strictEqual((await requete('/action', { method: 'POST', corps: JSON.stringify({ type: 'select', sid: 's2' }) })).status, 204);
  flux = await requete('/events');
  etat = JSON.parse(flux.data.slice(6));
  assert(etat.html.includes('Ancienne demande') && etat.html.includes('ancienne roadmap'));

  serveur.kill();
  fs.rmSync(home, { recursive: true, force: true });
  console.log('ok');
})().catch((e) => { serveur.kill(); console.error(e); process.exit(1); });
