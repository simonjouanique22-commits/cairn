#!/usr/bin/env node
// Vue universelle de Cairn : la même roadmap que dans VS Code, servie sur http://127.0.0.1:4823 pour l'ouvrir à côté de
// n'importe quel éditeur (JetBrains, Zed, Neovim, Sublime Text…). Lecture seule, accessible uniquement depuis ce poste.
//   node web/serve.js [dossier du projet] [--port 4823] [--lang fr|en] [--open]
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const cairn = require('../vscode/extension.js');

const args = process.argv.slice(2);
const option = (nom, defaut) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : defaut; };
const PORT = Number(option('--port', 4823));
const LANG = option('--lang', (process.env.LANG || '').toLowerCase().startsWith('fr') ? 'fr' : 'en');
const brut = args.find((a, i) => !a.startsWith('--') && !['--port', '--lang'].includes(args[i - 1])) || process.cwd();
const DOSSIER = (() => { try { return fs.realpathSync.native(path.resolve(brut)); } catch { return path.resolve(brut); } })();
const POLICES = path.join(__dirname, '..', 'vscode', 'media', 'fonts');
const HOTES = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

let choisi = null, sessions = [], dernier = '';
const clients = new Set();

// Fichiers que git voit modifiés dans le projet (commande en lecture seule, sans shell).
function changesGit() {
  try {
    const sortie = execFileSync('git', ['status', '--porcelain', '-z', '-uall'], { cwd: DOSSIER, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const racine = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: DOSSIER, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return sortie.split('\0').filter((e) => e.length > 3).map((e) => path.join(racine, e.slice(3)));
  } catch { return []; }
}

function etat() {
  const now = Date.now();
  sessions = cairn.loadSessions([DOSSIER]);
  const latest = sessions[0];
  if (!sessions.some((s) => s.sid === choisi)) choisi = null;
  const r = sessions.find((s) => s.sid === choisi) || latest || null;
  const tr = r ? cairn.traceOf(r.sid) : cairn.traceVide();
  const cmdFiles = r ? cairn.filesParCommande(r.tasks, tr, changesGit(), now) : {};
  const signal = cairn.readSignal([DOSSIER], cairn.CLAUDE_DIR, now);
  const actives = sessions.filter((s) => now - s.mtime < 2 * 3600e3);
  const pills = actives.length > 1 ? actives : [];
  const journal = sessions.filter((s) => s.sid !== r?.sid && !pills.includes(s)).slice(0, 8);
  return JSON.stringify({ type: 'state', html: cairn.renderApp(r, { files: tr.files, cmdFiles, signal, pills, journal, latestSid: latest?.sid, now, lang: LANG }),
    annonce: cairn.annonce(r, signal, LANG) });
}

function diffuser(force) {
  const m = etat();
  if (m === dernier && !force) return;
  dernier = m;
  for (const res of clients) res.write(`data: ${m}\n\n`);
}

const securite = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
const serveur = http.createServer((req, res) => {
  // Contre le « DNS rebinding » : seules les adresses locales de ce serveur sont acceptées.
  if (!HOTES.has(req.headers.host)) { res.writeHead(403, securite).end(); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/') {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.writeHead(200, { ...securite, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(cairn.shell(nonce, "'self'", cairn.polices((f) => `/fonts/${f}`), true));
  } else if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { ...securite, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    clients.add(res);
    res.write(`data: ${dernier || etat()}\n\n`);
    req.on('close', () => clients.delete(res));
  } else if (req.method === 'GET' && /^\/fonts\/(BricolageGrotesque|JetBrainsMono)\.woff2$/.test(url.pathname)) {
    res.writeHead(200, { ...securite, 'Content-Type': 'font/woff2' });
    fs.createReadStream(path.join(POLICES, path.basename(url.pathname))).pipe(res);
  } else if (req.method === 'POST' && url.pathname === '/action') {
    let corps = '';
    req.on('data', (d) => { corps += d; if (corps.length > 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const m = JSON.parse(corps);
        if (m.type === 'select' && sessions.some((s) => s.sid === m.sid)) { choisi = m.sid; diffuser(true); }
      } catch { /* ignoré */ }
      res.writeHead(204, securite).end();
    });
  } else {
    res.writeHead(404, securite).end();
  }
});

serveur.listen(PORT, '127.0.0.1', () => {
  const adresse = `http://127.0.0.1:${PORT}`;
  console.log(`Cairn · roadmap de ${DOSSIER}\n→ ${adresse}  (Ctrl+C pour arrêter)`);
  if (args.includes('--open')) {
    const [cmd, ...a] = process.platform === 'darwin' ? ['open', adresse] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', adresse] : ['xdg-open', adresse];
    spawn(cmd, a, { stdio: 'ignore', detached: true }).unref();
  }
});
setInterval(() => diffuser(false), 2000);
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);
