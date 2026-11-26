#!/usr/bin/env node
// Cairn's universal view: the same roadmap as in VS Code, served on http://127.0.0.1:4823 to open next to any editor
// (JetBrains, Zed, Neovim, Sublime Text…). Read-only, reachable from this machine only.
//   node web/serve.js [project folder] [--port 4823] [--lang en|fr] [--palette cairn|colorblind|violet|emerald|raspberry|teal] [--open]
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const cairn = require('../vscode/extension.js');

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const PORT = Number(option('--port', 4823));
const LANG = option('--lang', (process.env.LANG || '').toLowerCase().startsWith('fr') ? 'fr' : 'en');
const raw = args.find((a, i) => !a.startsWith('--') && !['--port', '--lang', '--palette'].includes(args[i - 1])) || process.cwd();
const FOLDER = (() => { try { return fs.realpathSync.native(path.resolve(raw)); } catch { return path.resolve(raw); } })();
// The palette: --palette, else the one chosen in VS Code (~/.claude/cairn/config.json), else Cairn's.
const palette = () => {
  try { return option('--palette') || JSON.parse(fs.readFileSync(path.join(cairn.CLAUDE_DIR, 'cairn', 'config.json'), 'utf8')).palette; } catch { return undefined; }
};
const FONTS = path.join(__dirname, '..', 'vscode', 'media', 'fonts');
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

let chosen = null, sessions = [], last = '', tab = 'now', pick = null, history = [], composing = null, current = null;
const clients = new Set();

// Files git sees as changed in the project (read-only command, no shell).
function gitChanges() {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '-z', '-uall'], { cwd: FOLDER, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: FOLDER, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out.split('\0').filter((e) => e.length > 3).map((e) => path.join(root, e.slice(3)));
  } catch { return []; }
}

function state() {
  const now = Date.now();
  sessions = cairn.loadSessions([FOLDER]);
  const latest = sessions[0];
  if (!sessions.some((s) => s.sid === chosen)) chosen = null;
  const r = sessions.find((s) => s.sid === chosen) || latest || null;
  current = r;
  const tr = r ? cairn.traceOf(r.sid) : cairn.emptyTrace();
  const cmdFiles = r ? cairn.filesByCommand(r.tasks, tr, gitChanges(), now) : {};
  const signal = cairn.readSignal([FOLDER], cairn.CLAUDE_DIR, now);
  const active = sessions.filter((s) => now - s.mtime < 2 * 3600e3);
  const pills = active.length > 1 ? active : [];
  history = cairn.loadHistory([FOLDER]);
  if (!history.some((e) => e.id === pick)) pick = null;
  const steering = { stats: r ? cairn.stepStats(r.sid, r.tasks, tr) : {}, eta: cairn.timeLeft(r, history), steer: r ? cairn.readSteer(r.sid) : { items: [] }, composing };
  return JSON.stringify({ type: 'state', html: cairn.renderApp(r, { files: tr.files, cmdFiles, signal, pills, now, lang: LANG, tab, pick, history, project: FOLDER, ...steering }),
    vars: cairn.paletteVars(palette()), announcement: cairn.announcement(r, signal, LANG) });
}

function broadcast(force) {
  const m = state();
  if (m === last && !force) return;
  last = m;
  for (const res of clients) res.write(`data: ${m}\n\n`);
}

const secure = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
const server = http.createServer((req, res) => {
  // Against DNS rebinding: only this server's local addresses are accepted.
  if (!HOSTS.has(req.headers.host)) { res.writeHead(403, secure).end(); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/') {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.writeHead(200, { ...secure, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(cairn.shell(nonce, "'self'", cairn.fontFaces((f) => `/fonts/${f}`), true, LANG));
  } else if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { ...secure, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    clients.add(res);
    res.write(`data: ${last || state()}\n\n`);
    req.on('close', () => clients.delete(res));
  } else if (req.method === 'GET' && /^\/fonts\/(BricolageGrotesque|JetBrainsMono)\.woff2$/.test(url.pathname)) {
    res.writeHead(200, { ...secure, 'Content-Type': 'font/woff2' });
    fs.createReadStream(path.join(FONTS, path.basename(url.pathname))).pipe(res);
  } else if (req.method === 'POST' && url.pathname === '/action') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const m = JSON.parse(body);
        if (m.type === 'select' && sessions.some((s) => s.sid === m.sid)) chosen = m.sid;
        else if (m.type === 'tab' && (m.tab === 'now' || m.tab === 'history')) { tab = m.tab; pick = null; }
        else if (m.type === 'pick') pick = history.some((e) => e.id === m.id) ? m.id : null;
        else if (m.type === 'compose') composing = typeof m.step === 'string' && /^[\w-]{1,12}$/.test(m.step) ? m.step : null;
        else if (m.type === 'steer' && current && cairn.steer(current.sid, m, current.tasks)) composing = null;
        broadcast(true);
      } catch { /* ignored */ }
      res.writeHead(204, secure).end();
    });
  } else {
    res.writeHead(404, secure).end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${PORT}`;
  console.log(`Cairn · roadmap of ${FOLDER}\n→ ${address}  (Ctrl+C to stop)`);
  if (args.includes('--open')) {
    const [cmd, ...a] = process.platform === 'darwin' ? ['open', address] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', address] : ['xdg-open', address];
    spawn(cmd, a, { stdio: 'ignore', detached: true }).unref();
  }
});
setInterval(() => broadcast(false), 2000);
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);
