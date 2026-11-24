// Cairn : affiche dans VS Code la roadmap que Claude Code tient dans ~/.claude/tasks/<session>/<n>.json,
// pour la session lancée dans le dossier ouvert : planche « sticker » dans la barre latérale + avancement
// dans la barre d'état. Thème clair ou sombre selon celui de VS Code.
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
    .map((f) => {
      const p = path.join(best.dir, f);
      try { return { ...JSON.parse(fs.readFileSync(p, 'utf8')), mtime: mtimeOf(p) }; } catch { return null; }
    })
    .filter((t) => t && t.status !== 'deleted')
    .sort((a, b) => Number(a.id) - Number(b.id));
  const done = tasks.filter((t) => t.status === 'completed').length;
  return { sid: best.sid, tasks, done, total: tasks.length, cwd: sessionCwd(best.sid, claudeDir) };
}

const bar = (done, total, width = 10) => {
  const n = total ? Math.round((done / total) * width) : 0;
  return '▰'.repeat(n) + '▱'.repeat(width - n);
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const heure = (ms) => (ms ? new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');

// Logo S1 en miniature : pierre suivante en pointillés, en cours (bleu), faites (rose, encre).
const MINI = '<span class="mini" aria-hidden="true"><i class="p4"></i><i class="p3"></i><i class="p2"></i><i class="p1"></i></span>';
// Pile de lettres complète, affichée au sommet.
const PILE = '<div class="pile" aria-hidden="true"><b class="l-c">c</b><b class="l-a">a</b><b class="l-i">i</b><b class="l-r">r</b><b class="l-n">n</b></div>';
// Tampon S4, pour l'écran vide.
const TAMPON = `<div class="tampon" aria-hidden="true"><svg viewBox="0 0 220 220"><defs><path id="rond" d="M110,110 m-86,0 a86,86 0 1,1 172,0 a86,86 0 1,1 -172,0"/></defs>
<text><textPath href="#rond" textLength="536" lengthAdjust="spacing">CAIRN · LE PLAN DE CLAUDE · PIERRE APRÈS PIERRE ·</textPath></text></svg>
<div class="coeur"><i class="p4"></i><i class="p3"></i><i class="p2"></i><i class="p1"></i></div></div>`;

const CSS = `
:root{--paper:#FFFDF8;--ink:#121212;--text:#121212;--muted:#5E5A52;--soft:#8A857B;--accent:#2B3BFF;--pop:#FF7AD9;
--sheet-shadow:#121212;--card-shadow:#121212;--box-fg:#FFFDF8;
--brand:'Bricolage Grotesque',system-ui,-apple-system,'Segoe UI',sans-serif;
--mono:var(--vscode-editor-font-family,'JetBrains Mono',ui-monospace,Menlo,monospace)}
body.vscode-dark,body.vscode-high-contrast{--paper:#222226;--ink:#F4F0E8;--text:#F4F0E8;--muted:#C9C4BA;--soft:#85807A;
--sheet-shadow:var(--pop);--card-shadow:#000;--box-fg:#121212}
*{box-sizing:border-box}
body{margin:0;padding:8px 14px 18px 8px;font-family:var(--brand);color:var(--text)}
.sheet{max-width:560px;margin:0 auto;padding:16px;background:var(--paper);border:2.5px solid var(--ink);border-radius:18px;
box-shadow:5px 5px 0 var(--sheet-shadow);display:flex;flex-direction:column;gap:14px}
.top{display:flex;align-items:center;gap:8px}
.word{font-weight:800;font-size:20px;letter-spacing:-.04em}
.mini,.coeur{display:flex;flex-direction:column;align-items:center;gap:1.5px}
.mini i{display:block;height:4px;border-radius:99px}.mini .p4{width:7px;border:1px dashed var(--ink);height:3.5px}
.mini .p3{width:11px;background:var(--accent)}.mini .p2{width:15px;background:var(--pop)}.mini .p1{width:19px;background:var(--ink);height:4.5px}
.chip{font-family:var(--mono);font-size:10.5px;font-weight:600;padding:0 8px;border:2px solid var(--ink);border-radius:99px;white-space:nowrap}
.proj{margin-left:auto;max-width:55%;overflow:hidden;text-overflow:ellipsis}
.count{display:flex;align-items:baseline;gap:4px}
.count b{font-weight:800;font-size:64px;letter-spacing:-.05em;line-height:.9}
.count span{font-weight:800;font-size:30px;letter-spacing:-.03em;color:var(--soft)}
.count em{margin-left:auto;font-style:normal;font-family:var(--mono);font-size:11px;color:var(--muted)}
.bar{display:grid;gap:5px}.bar i{height:14px;border:2px solid var(--ink);border-radius:99px}
.bar .d{background:var(--ink)}.bar .c{background:var(--accent)}
.steps{list-style:none;margin:0;padding:4px 0 0;display:flex;flex-direction:column;gap:9px}
.row{display:flex;align-items:center;gap:9px}
.box{width:20px;height:20px;flex:none;border-radius:6px;display:flex;align-items:center;justify-content:center;
font-family:var(--mono);font-size:10.5px;font-weight:700}
.done .box{background:var(--ink);color:var(--box-fg);font-family:var(--brand);font-size:12px;font-weight:800}
.todo .box{border:2px dashed var(--ink)}
.t{flex:1;min-width:0;font-size:13.5px;font-weight:600;overflow-wrap:anywhere}
.done .t{color:var(--muted);text-decoration:line-through;text-decoration-color:var(--pop);text-decoration-thickness:4px}
time{font-family:var(--mono);font-size:10.5px;color:var(--muted);white-space:nowrap}
.cur{margin:4px 0}
.card{padding:12px 14px;border:2.5px solid var(--ink);border-radius:16px;background:var(--accent);color:#fff;
box-shadow:4px 4px 0 var(--card-shadow);transform:rotate(-1.5deg);display:flex;flex-direction:column;gap:5px}
.cardtop{display:flex;align-items:center;justify-content:space-between;gap:8px}.card time{color:#fff}
.tag{font-family:var(--mono);font-size:10px;font-weight:700;padding:0 7px;border:2px solid #121212;border-radius:99px;
background:var(--pop);color:#121212}
.ct{font-size:18px;font-weight:800;line-height:1.15;letter-spacing:-.02em;overflow-wrap:anywhere}
.af{font-size:12.5px}
summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
summary::after{content:" ▾";font-size:10px;opacity:.6}details[open] summary::after{content:" ▴"}
details p{margin:4px 0 0;font-size:12px;font-weight:500;color:var(--muted);text-decoration:none;white-space:pre-wrap}
.card details p{color:#fff;opacity:.85}
.foot{font-family:var(--mono);font-size:11px;color:var(--muted)}
.summit{align-self:center;margin:4px 0 0;padding:4px 18px;background:var(--pop);color:#121212;border:2.5px solid var(--ink);
border-radius:99px;box-shadow:4px 4px 0 var(--card-shadow);transform:rotate(-4deg);font-weight:800;font-size:24px;letter-spacing:-.03em}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chips .fin{background:var(--accent);color:#fff}
.pile{display:flex;flex-direction:column;align-items:center;gap:3px;padding-top:8px}
.pile b{display:block;border:2px solid var(--ink);border-radius:99px;font-weight:800;line-height:1.1}
.l-c{padding:0 9px;font-size:16px;background:var(--pop);color:#121212;transform:rotate(-6deg)}
.l-a{padding:0 12px;font-size:20px;background:var(--accent);color:#fff;transform:rotate(4deg)}
.l-i{padding:0 18px;font-size:23px;background:var(--paper);transform:rotate(-3deg)}
.l-r{padding:0 24px;font-size:27px;background:var(--pop);color:#121212;transform:rotate(5deg)}
.l-n{padding:0 32px;font-size:32px;background:var(--ink);color:var(--paper);transform:rotate(-2deg)}
.empty{align-items:center;text-align:center;padding:26px 16px}
.empty h2{margin:6px 0 0;font-size:19px;font-weight:800;letter-spacing:-.03em}.empty p{margin:0;font-family:var(--mono);font-size:11px;color:var(--muted)}
.tampon{position:relative;width:190px;height:190px;border-radius:50%;background:var(--pop);border:2.5px solid var(--ink);
box-shadow:5px 5px 0 var(--card-shadow);transform:rotate(-10deg);display:flex;align-items:center;justify-content:center}
.tampon svg{position:absolute;inset:0;width:100%;height:100%}
.tampon text{font-family:var(--mono);font-size:12.5px;font-weight:700;fill:#121212}
.coeur{width:104px;height:104px;border-radius:50%;background:#FFFDF8;border:2.5px solid #121212;justify-content:center;gap:3px}
.coeur i{display:block;height:11px;border:2px solid #121212;border-radius:99px}.coeur .p4{width:20px;border-style:dashed}
.coeur .p3{width:32px;background:var(--accent)}.coeur .p2{width:46px;background:var(--pop)}.coeur .p1{width:60px;background:#121212}`;

function render(r) {
  let body = `<main class="sheet empty">${TAMPON}<h2>Rien à baliser pour l'instant</h2>
<p>Cairn affiche le plan de Claude dès qu'une demande compte plusieurs étapes.</p></main>`;
  if (r?.total) {
    const { tasks, done, total } = r;
    const complete = done === total;
    const proj = r.cwd ? `<span class="chip proj" title="${esc(r.cwd)}">${esc(path.basename(r.cwd))}</span>` : '';
    const segs = tasks.map((t) => `<i class="${t.status === 'completed' ? 'd' : t.status === 'in_progress' ? 'c' : ''}"></i>`).join('');
    const titre = (t, cls) => {
      const desc = t.description && t.description !== t.subject ? esc(t.description) : '';
      return desc ? `<details class="${cls}"><summary>${esc(t.subject)}</summary><p>${desc}</p></details>`
        : `<span class="${cls}">${esc(t.subject)}</span>`;
    };
    const steps = tasks.map((t) => {
      if (t.status === 'completed') {
        return `<li class="row done"><span class="box">✓</span>${titre(t, 't')}<time>${heure(t.mtime)}</time></li>`;
      }
      if (t.status === 'in_progress') {
        return `<li class="cur"><div class="card"><div class="cardtop"><span class="tag">EN COURS</span><time>depuis ${heure(t.mtime)}</time></div>
${titre(t, 'ct')}${t.activeForm ? `<span class="af">${esc(t.activeForm)}…</span>` : ''}</div></li>`;
      }
      const wait = t.blockedBy?.length ? `<span class="chip">après #${t.blockedBy.map(esc).join(', #')}</span>` : '';
      return `<li class="row todo"><span class="box">${esc(t.id)}</span>${titre(t, 't')}${wait}</li>`;
    }).join('');
    const head = complete
      ? `<div class="summit">Sommet atteint ✓</div>`
      : `<div class="count"><b>${done}</b><span>/${total}</span><em>étapes · ${Math.round((done / total) * 100)} %</em></div>`;
    const after = complete
      ? `<div class="chips"><span class="chip">${total} étapes</span><span class="chip fin">fini à ${heure(Math.max(...tasks.map((t) => t.mtime || 0)))}</span></div>`
      : '';
    const foot = complete ? `${PILE}<span class="foot" style="align-self:center">le cairn est complet.</span>` : '<span class="foot">→ arrivée au sommet</span>';
    body = `<main class="sheet"><header class="top">${MINI}<span class="word">cairn</span>${proj}</header>${head}
<div class="bar" style="grid-template-columns:repeat(${total},minmax(0,1fr))">${segs}</div>${after}
<ol class="steps">${steps}</ol>${foot}</main>`;
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
  status.command = 'cairn.roadmap.focus';

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
    status.text = `$(milestone) ${bar(done, total, 8)} ${done}/${total}` +
      (current ? ` · ${current.activeForm || current.subject}` : done === total ? ' · sommet atteint' : '');
    status.tooltip = 'Cairn — roadmap de Claude\n' + tasks.map((t) => `${mark[t.status] || '○'} ${t.id}. ${t.subject}`).join('\n');
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
    vscode.window.registerWebviewViewProvider('cairn.roadmap', {
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
