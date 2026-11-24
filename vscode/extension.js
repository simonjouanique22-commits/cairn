// Roadmap Claude : lit les tâches que Claude Code écrit dans ~/.claude/tasks/<session>/<n>.json
// et les dessine en frise (vue latérale) + barre d'état, pour la session lancée dans le dossier ouvert.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const cwdCache = new Map();
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

// Dossier de lancement de la session, lu une fois dans son transcript (~/.claude/projects/*/<session>.jsonl).
function sessionCwd(sid, claudeDir) {
  if (cwdCache.has(sid)) return cwdCache.get(sid);
  const projects = path.join(claudeDir, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projects); } catch { return null; }
  for (const p of dirs) {
    const f = path.join(projects, p, sid + '.jsonl');
    if (!fs.existsSync(f)) continue;
    const buf = Buffer.alloc(256 * 1024);
    const fd = fs.openSync(f, 'r');
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8', 0, n).match(/"cwd":("(?:[^"\\]|\\.)*")/);
    if (!m) return null; // transcript pas encore écrit : on réessaiera
    const cwd = JSON.parse(m[1]);
    cwdCache.set(sid, cwd);
    return cwd;
  }
  return null; // ponytail: liste nommée (CLAUDE_CODE_TASK_LIST_ID) sans transcript = ignorée si un dossier est ouvert
}

// Liste de tâches la plus récente dont la session tourne dans un des dossiers ouverts (n'importe laquelle sinon).
function loadRoadmap(folders, claudeDir = CLAUDE_DIR) {
  const root = path.join(claudeDir, 'tasks');
  let sids = [];
  try { sids = fs.readdirSync(root); } catch { return null; }
  let best = null;
  for (const sid of sids) {
    const dir = path.join(root, sid);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    if (!files.length) continue;
    const mtime = Math.max(...files.map((f) => mtimeOf(path.join(dir, f))));
    if (best && mtime <= best.mtime) continue;
    if (folders.length) {
      const cwd = sessionCwd(sid, claudeDir);
      if (!cwd || !folders.some((w) => cwd === w || cwd.startsWith(w + path.sep))) continue;
    }
    best = { sid, dir, files, mtime };
  }
  if (!best) return null;
  const tasks = best.files
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(best.dir, f), 'utf8')); } catch { return null; } })
    .filter((t) => t && t.status !== 'deleted')
    .sort((a, b) => Number(a.id) - Number(b.id));
  const done = tasks.filter((t) => t.status === 'completed').length;
  return { sid: best.sid, tasks, done, total: tasks.length };
}

const bar = (done, total, width = 10) => {
  const n = total ? Math.round((done / total) * width) : 0;
  return '▰'.repeat(n) + '▱'.repeat(width - n);
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Frise verticale dans une barre latérale, horizontale dès que la vue est large (panneau du bas).
const CSS = `
:root{--fg:var(--vscode-foreground,#1f2328);--muted:var(--vscode-descriptionForeground,#656d76);
--line:var(--vscode-widget-border,var(--vscode-editorWidget-border,#d0d7de));
--ok:var(--vscode-testing-iconPassed,#1a7f37);--cur:var(--vscode-charts-blue,#0969da)}
body{margin:0;padding:14px 14px 24px;font:13px/1.45 var(--vscode-font-family,system-ui,sans-serif);color:var(--fg)}
header{margin-bottom:20px}
.top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.pct{font-size:30px;font-weight:700;letter-spacing:-.02em}.pct small{font-size:14px;color:var(--muted)}
.count{color:var(--muted)}
.bar{height:8px;border-radius:99px;background:var(--line);overflow:hidden;margin:8px 0}
.bar i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--ok),color-mix(in srgb,var(--ok) 55%,var(--cur)))}
.now{margin:0;color:var(--muted)}.now b{color:var(--fg)}
.road{list-style:none;margin:0;padding:0}
.step{position:relative;display:grid;grid-template-columns:26px 1fr;column-gap:12px;padding-bottom:18px}
.step:not(:last-child)::after{content:"";position:absolute;left:12px;top:30px;bottom:2px;width:2px;
background:repeating-linear-gradient(var(--line) 0 4px,transparent 4px 8px)}
.step.done::after{background:var(--ok)}
.step.current::after{background:linear-gradient(var(--cur),var(--line))}
.node{width:26px;height:26px;box-sizing:border-box;border-radius:50%;display:grid;place-items:center;
font-size:12px;font-weight:700;border:2px solid var(--line);color:var(--muted)}
.done .node{background:var(--ok);border-color:var(--ok);color:#fff}
.current .node{border-color:var(--cur);color:var(--cur);animation:pulse 1.8s ease-out infinite}
@keyframes pulse{from{box-shadow:0 0 0 0 color-mix(in srgb,var(--cur) 50%,transparent)}to{box-shadow:0 0 0 10px transparent}}
@media (prefers-reduced-motion:reduce){.current .node{animation:none}}
.body{min-width:0;padding-top:3px}
.title{font-weight:600;overflow-wrap:anywhere}
.done .title{color:var(--muted);font-weight:500}
.current .body{margin-top:-4px;padding:6px 10px;border-radius:8px;
background:color-mix(in srgb,var(--cur) 10%,transparent);border:1px solid color-mix(in srgb,var(--cur) 40%,transparent)}
.active{color:var(--muted);font-style:italic;margin-top:2px}
.tag{font:700 10px/1 var(--vscode-font-family,system-ui,sans-serif);text-transform:uppercase;letter-spacing:.05em;color:var(--cur);margin-right:4px;white-space:nowrap}
.chip{display:inline-block;margin-top:4px;font-size:11px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
summary::after{content:" ▾";color:var(--muted);font-weight:400}details[open] summary::after{content:" ▴"}
details p{margin:4px 0 0;color:var(--muted);white-space:pre-wrap}
.empty{color:var(--muted);text-align:center;margin-top:40px}
@media (min-width:640px){
.road{display:flex;align-items:flex-start;overflow-x:auto;padding:4px 0 8px}
.step{flex:1 0 130px;grid-template-columns:1fr;justify-items:center;text-align:center;row-gap:10px;padding:0 6px}
.step:not(:last-child)::after{left:calc(50% + 17px);right:calc(-50% + 17px);top:12px;bottom:auto;width:auto;height:2px;
background:repeating-linear-gradient(90deg,var(--line) 0 4px,transparent 4px 8px)}
.step.done::after{background:var(--ok)}
.step.current::after{background:linear-gradient(90deg,var(--cur),var(--line))}
.current .body{margin-top:0}
.tag{display:block;margin:4px 0 2px}}`;

function render(r) {
  let body = `<p class="empty">Pas encore de roadmap.<br>Claude en crée une dès qu'une tâche compte plusieurs étapes.</p>`;
  if (r?.total) {
    const { tasks, done, total } = r;
    const pct = Math.round((done / total) * 100);
    const current = tasks.find((t) => t.status === 'in_progress');
    const now = current ? `En cours : <b>${esc(current.activeForm || current.subject)}</b>`
      : done === total ? 'Tout est terminé 🎉' : 'En attente de la prochaine étape';
    const steps = tasks.map((t) => {
      const s = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'current' : 'todo';
      const title = t.description && t.description !== t.subject
        ? `<details><summary class="title">${esc(t.subject)}</summary><p>${esc(t.description)}</p></details>`
        : `<div class="title">${esc(t.subject)}</div>`;
      const active = s === 'current' ? `<div class="active"><span class="tag">En cours</span>${esc(t.activeForm || '')}…</div>` : '';
      const wait = s === 'todo' && t.blockedBy?.length ? `<span class="chip">attend #${t.blockedBy.map(esc).join(', #')}</span>` : '';
      return `<li class="step ${s}"><span class="node">${s === 'done' ? '✓' : esc(t.id)}</span><div class="body">${title}${active}${wait}</div></li>`;
    }).join('');
    body = `<header><div class="top"><span class="pct">${pct}<small> %</small></span><span class="count">${done} / ${total} étapes</span></div>
<div class="bar"><i style="width:${pct}%"></i></div><p class="now">${now}</p></header>
<ol class="road">${steps}<li class="step ${done === total ? 'done' : 'todo'}"><span class="node">⚑</span><div class="body"><div class="title">Arrivée</div></div></li></ol>`;
  }
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body>${body}</body></html>`;
}

function activate(context) {
  const vscode = require('vscode');
  let roadmap = null, view, lastHtml;
  const mark = { completed: '✓', in_progress: '▶', pending: '○' };
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'claudeRoadmap.steps.focus';

  const paint = () => {
    if (!view) return;
    const html = render(roadmap);
    if (html !== lastHtml) view.webview.html = lastHtml = html;
    const left = roadmap ? roadmap.total - roadmap.done : 0;
    view.description = roadmap?.total ? `${roadmap.done}/${roadmap.total}` : undefined;
    view.badge = left ? { value: left, tooltip: `${left} étape(s) restante(s)` } : undefined;
  };

  const refresh = () => {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => {
      try { return fs.realpathSync.native(f.uri.fsPath); } catch { return f.uri.fsPath; }
    });
    roadmap = loadRoadmap(folders);
    paint();
    if (!roadmap?.total) return status.hide();
    const { tasks, done, total } = roadmap;
    const current = tasks.find((t) => t.status === 'in_progress');
    status.text = `$(checklist) ${bar(done, total, 8)} ${done}/${total}` +
      (current ? ` · ${current.activeForm || current.subject}` : done === total ? ' · terminé' : '');
    status.tooltip = tasks.map((t) => `${mark[t.status] || '○'} ${t.id}. ${t.subject}`).join('\n');
    status.show();
  };

  let timer, watcher;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 150); };
  const watch = () => {
    if (watcher) return;
    try {
      watcher = fs.watch(path.join(CLAUDE_DIR, 'tasks'), { recursive: true }, schedule);
      watcher.on('error', () => { watcher.close(); watcher = undefined; });
      schedule();
    } catch { /* ~/.claude/tasks n'existe pas encore */ }
  };
  watch();
  const retry = setInterval(watch, 3000);

  refresh();
  context.subscriptions.push(
    status,
    vscode.window.registerWebviewViewProvider('claudeRoadmap.steps', {
      resolveWebviewView(v) {
        view = v;
        lastHtml = undefined;
        v.onDidDispose(() => { view = undefined; });
        paint();
      },
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(schedule),
    { dispose: () => { clearInterval(retry); clearTimeout(timer); watcher?.close(); } },
  );
}

module.exports = { activate, deactivate() {}, loadRoadmap, bar, render };
