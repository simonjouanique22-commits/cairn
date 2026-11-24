// Cairn : affiche la roadmap que Claude Code tient dans ~/.claude/tasks/<session>/<n>.json, pour les sessions
// lancées dans le dossier ouvert : planche « sticker » vivante, fichiers touchés par étape (comparaison avant/après),
// « Claude t'attend », journal, avancement dans la barre d'état. Les mêmes fonctions servent la vue universelle (web/serve.js).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

// ---------- lecture des données de Claude Code (lecture seule) ----------

const transcrits = new Map();
// Transcript d'une session (~/.claude/projects/*/<session>.jsonl), chemin mis en cache une fois trouvé.
function transcriptOf(sid, claudeDir) {
  if (transcrits.has(sid)) return transcrits.get(sid);
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(claudeDir, 'projects')); } catch { return null; }
  for (const p of dirs) {
    const f = path.join(claudeDir, 'projects', p, sid + '.jsonl');
    if (fs.existsSync(f)) { transcrits.set(sid, f); return f; }
  }
  return null;
}

const cwdCache = new Map();
// Dossier de lancement de la session : seul le champ "cwd" du début du transcript est lu.
function sessionCwd(sid, claudeDir) {
  if (cwdCache.has(sid)) return cwdCache.get(sid);
  const f = transcriptOf(sid, claudeDir);
  if (!f) return null;
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
// Vrai si cwd est l'un des dossiers ouverts ou se trouve dedans (séparateurs et casse de Windows compris).
// ponytail: liste nommée (CLAUDE_CODE_TASK_LIST_ID) sans transcript = ignorée si un dossier est ouvert
const dansDossiers = (cwd, folders) => !folders.length || (!!cwd && folders.some((w) => {
  const rel = path.relative(w, cwd);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}));

function readTasks(dir, files) {
  return files
    .map((f) => {
      const p = path.join(dir, f);
      try { return { ...JSON.parse(fs.readFileSync(p, 'utf8')), mtime: mtimeOf(p) }; } catch { return null; }
    })
    .filter((t) => t && t.status !== 'deleted')
    .sort((a, b) => Number(a.id) - Number(b.id));
}

// Listes de tâches des sessions lancées dans les dossiers ouverts (toutes si aucun dossier), récentes d'abord.
function loadSessions(folders, claudeDir = CLAUDE_DIR, max = 9) {
  const root = path.join(claudeDir, 'tasks');
  let sids = [];
  try { sids = fs.readdirSync(root); } catch { return []; }
  const candidates = [];
  for (const sid of sids) {
    const dir = path.join(root, sid);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    if (!files.length) continue;
    candidates.push({ sid, dir, files, mtime: Math.max(...files.map((f) => mtimeOf(path.join(dir, f)))) });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const c of candidates) {
    if (out.length >= max) break;
    const cwd = sessionCwd(c.sid, claudeDir);
    if (!dansDossiers(cwd, folders)) continue;
    const tasks = readTasks(c.dir, c.files);
    if (!tasks.length) continue;
    const done = tasks.filter((t) => t.status === 'completed').length;
    out.push({ sid: c.sid, tasks, done, total: tasks.length, mtime: c.mtime, cwd });
  }
  return out;
}
const loadRoadmap = (folders, claudeDir = CLAUDE_DIR) => loadSessions(folders, claudeDir, 1)[0] ?? null;

// Clé de comparaison d'un chemin : séparateurs normalisés, et casse ignorée sous Windows.
const cle = (p) => (process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p));

const traces = new Map();
const traceVide =() => ({ offset: 0, cur: null, reste: Buffer.alloc(0), files: {}, debut: {}, fin: {}, sauvegardes: {} });
// Ce que le transcript dit des étapes, lu au fil de l'eau : début et fin de chaque étape (TaskUpdate), chemins des
// fichiers écrits pendant qu'elle était en cours (Write/Edit/MultiEdit/NotebookEdit) et copies de sauvegarde que
// Claude Code fait avant de modifier un fichier (file-history-snapshot). Jamais le contenu des messages.
function traceOf(sid, claudeDir = CLAUDE_DIR) {
  const f = transcriptOf(sid, claudeDir);
  if (!f) return traceVide();
  let tr = traces.get(sid);
  const size = sizeOf(f);
  if (!tr || size < tr.offset) tr = traceVide();
  if (size > tr.offset) {
    const len = Math.min(size - tr.offset, 8 * 1024 * 1024); // ponytail: 8 Mo par passage, le reste au suivant
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(f, 'r');
    fs.readSync(fd, buf, 0, len, tr.offset);
    fs.closeSync(fd);
    tr.offset += len;
    const tout = Buffer.concat([tr.reste, buf]);
    const coupe = tout.lastIndexOf(10);
    tr.reste = coupe < 0 ? tout : tout.subarray(coupe + 1);
    for (const ligne of coupe < 0 ? [] : tout.subarray(0, coupe).toString('utf8').split('\n')) {
      const instantane = ligne.includes('"file-history-snapshot"');
      if (!instantane && !ligne.includes('"tool_use"')) continue;
      let msg;
      try { msg = JSON.parse(ligne); } catch { continue; }
      if (instantane) {
        for (const [nomFichier, b] of Object.entries(msg.snapshot?.trackedFileBackups || {})) {
          const t = Date.parse(b?.backupTime);
          if (!t) continue;
          const abs = b.realParentDir ? path.join(b.realParentDir, path.basename(nomFichier)) : nomFichier;
          const liste = (tr.sauvegardes[cle(abs)] ||= []);
          if (!liste.some((x) => x.t === t)) liste.push({ t, nom: b.backupFileName ?? null });
        }
        continue;
      }
      const quand = Date.parse(msg.timestamp) || 0;
      for (const b of msg.message?.content || []) {
        if (b?.type !== 'tool_use') continue;
        if (b.name === 'TaskUpdate') {
          const id = String(b.input?.taskId);
          if (b.input?.status === 'in_progress') { tr.cur = id; tr.debut[id] ??= quand; }
          if (b.input?.status === 'completed') tr.fin[id] = quand;
        } else if (tr.cur && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name)) {
          const p = b.input?.file_path || b.input?.notebook_path;
          if (typeof p === 'string') (tr.files[tr.cur] ||= new Set()).add(path.normalize(p));
        }
      }
    }
    traces.set(sid, tr);
  }
  return tr;
}
const filesByStep = (sid, claudeDir = CLAUDE_DIR) => traceOf(sid, claudeDir).files;

// Copie prise par Claude Code juste avant sa première modification du fichier depuis `depuis`
// ({ nom: null } : le fichier n'existait pas ; undefined : aucune copie connue).
function sauvegardeAvant(tr, file, depuis) {
  return (tr.sauvegardes[cle(file)] || []).filter((x) => x.t >= depuis - 1000).sort((a, b) => a.t - b.t)[0];
}

// Fichiers modifiés pendant une étape sans écriture directe de Claude (commande, script, à la main) : ceux que git
// voit modifiés et dont la date de modification tombe dans la fenêtre de l'étape.
function filesParCommande(tasks, tr, changes, now = Date.now()) {
  const out = {};
  for (const task of tasks) {
    const debut = tr.debut[task.id];
    if (!debut) continue;
    const fin = task.status === 'completed' ? (tr.fin[task.id] || task.mtime || now) : now;
    const directs = new Set([...(tr.files[task.id] || [])].map(cle));
    for (const f of changes) {
      if (directs.has(cle(f))) continue;
      const m = mtimeOf(f);
      if (m >= debut && m <= fin + 2000) (out[task.id] ||= new Set()).add(f);
    }
  }
  return out;
}

// Dernier signal (« Claude t'attend » / « Claude a fini ») d'une session du dossier, s'il n'a pas été suivi d'activité.
function readSignal(folders, claudeDir = CLAUDE_DIR, now = Date.now()) {
  const dir = path.join(claudeDir, 'cairn', 'etat');
  let noms = [];
  try { noms = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  let best = null;
  for (const nom of noms) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, nom), 'utf8')); } catch { continue; }
    const t = Number(s.t) * 1000;
    if (!t || now - t > 12 * 3600e3 || (best && t <= best.t)) continue;
    const sid = nom.slice(0, -5);
    if (!dansDossiers(sessionCwd(sid, claudeDir), folders)) continue;
    const tr = transcriptOf(sid, claudeDir);
    if (tr && mtimeOf(tr) > t + (s.attente ? 2000 : 3000)) continue; // Claude a repris depuis
    best = { sid, t, kind: s.attente ? 'attente' : s.fini ? 'fini' : null, message: String(s.message || '') };
  }
  return best?.kind ? best : null;
}

// ---------- rendu ----------

const T = {
  fr: {
    locale: 'fr-FR', steps: 'étapes', cur: 'EN COURS', after: 'après', foot: '→ arrivée au sommet',
    summit: 'Sommet atteint ✓', doneAt: 'fini à', count: (n) => `${n} étapes`, full: 'le cairn est complet.',
    emptyT: "Rien à baliser pour l'instant", emptyP: "Cairn affiche le plan de Claude dès qu'une demande compte plusieurs étapes.",
    wait: "Claude t'attend", finished: 'Claude a fini, à toi ✓', old: 'ancienne roadmap', journal: 'Journal',
    back: '↩ roadmap en cours', left: (n) => `${n} étape(s) restante(s)`, openTerm: 'Ouvrir le terminal',
    notif: (m) => `Claude t'attend${m ? ' : ' + m : ''}`, tip: 'Cairn — roadmap de Claude', statusDone: 'sommet atteint',
    since: (h, m) => `depuis ${h}${m ? ` · ${m} min` : ''}`, enCours: (x, d, n) => `En cours : ${x} — ${d}/${n} étapes faites`,
    cmdFile: "modifié pendant l'étape (commande ou à la main)", diffTitle: (f, s) => `${f} · avant l'étape ${s} ↔ maintenant`,
    ago: (ms, date) => { const m = Math.round(ms / 60000); return m < 1 ? "à l'instant" : m < 60 ? `il y a ${m} min` : m < 2880 ? `il y a ${Math.round(m / 60)} h` : `le ${date}`; },
  },
  en: {
    locale: 'en-GB', steps: 'steps', cur: 'IN PROGRESS', after: 'after', foot: '→ on to the summit',
    summit: 'Summit reached ✓', doneAt: 'done at', count: (n) => `${n} steps`, full: 'the cairn is complete.',
    emptyT: 'Nothing to mark yet', emptyP: "Cairn shows Claude's plan as soon as a request has several steps.",
    wait: 'Claude is waiting for you', finished: 'Claude is done — your turn ✓', old: 'old roadmap', journal: 'Log',
    back: '↩ current roadmap', left: (n) => `${n} step(s) left`, openTerm: 'Open terminal',
    notif: (m) => `Claude is waiting for you${m ? ': ' + m : ''}`, tip: "Cairn — Claude's roadmap", statusDone: 'summit reached',
    since: (h, m) => `since ${h}${m ? ` · ${m} min` : ''}`, enCours: (x, d, n) => `In progress: ${x} — ${d}/${n} steps done`,
    cmdFile: 'changed during the step (command or by hand)', diffTitle: (f, s) => `${f} · before step ${s} ↔ now`,
    ago: (ms, date) => { const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `on ${date}`; },
  },
};

const bar = (done, total, width = 10) => {
  const n = total ? Math.round((done / total) * width) : 0;
  return '▰'.repeat(n) + '▱'.repeat(width - n);
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Phrase annoncée aux lecteurs d'écran quand elle change.
function annonce(r, signal, lang = 'fr') {
  const t = T[lang] || T.fr;
  if (signal?.kind === 'attente') return t.notif(signal.message);
  if (signal?.kind === 'fini') return t.finished;
  if (!r?.total) return '';
  if (r.done === r.total) return t.summit;
  const cur = r.tasks.find((x) => x.status === 'in_progress');
  return cur ? t.enCours(cur.activeForm || cur.subject, r.done, r.total) : `${r.done}/${r.total}`;
}

// Logo S1 en miniature, pile de lettres complète (sommet), tampon S4 (écran vide).
const MINI = '<span class="mini" aria-hidden="true" data-k="mini"><i class="p4"></i><i class="p3"></i><i class="p2"></i><i class="p1"></i></span>';
const PILE = '<div class="pile" aria-hidden="true" data-k="pile"><b class="l-c">c</b><b class="l-a">a</b><b class="l-i">i</b><b class="l-r">r</b><b class="l-n">n</b></div>';
const TAMPON = `<div class="tampon" aria-hidden="true" data-k="tampon"><svg viewBox="0 0 220 220"><defs><path id="rond" d="M110,110 m-86,0 a86,86 0 1,1 172,0 a86,86 0 1,1 -172,0"/></defs>
<text><textPath href="#rond" textLength="536" lengthAdjust="spacing">CAIRN · LE PLAN DE CLAUDE · PIERRE APRÈS PIERRE ·</textPath></text></svg>
<div class="coeur"><i class="p4"></i><i class="p3"></i><i class="p2"></i><i class="p1"></i></div></div>`;

const CSS = `
:root{--paper:#FFFDF8;--ink:#121212;--text:#121212;--muted:#5E5A52;--soft:#8A857B;--accent:#2B3BFF;--pop:#FF7AD9;
--sheet-shadow:#121212;--card-shadow:#121212;--box-fg:#FFFDF8;
--brand:'Bricolage Grotesque',system-ui,-apple-system,'Segoe UI',sans-serif;
--mono:'JetBrains Mono',var(--vscode-editor-font-family,ui-monospace),Menlo,monospace}
body.vscode-dark,body.vscode-high-contrast{--paper:#222226;--ink:#F4F0E8;--text:#F4F0E8;--muted:#C9C4BA;--soft:#85807A;
--sheet-shadow:var(--pop);--card-shadow:#000;--box-fg:#121212}
*{box-sizing:border-box}
body{margin:0;padding:8px 14px 18px 8px;font-family:var(--brand);color:var(--text)}
#app{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
button{font:inherit;color:inherit;cursor:pointer}
button:focus-visible,summary:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.sheet{padding:16px;background:var(--paper);border:2.5px solid var(--ink);border-radius:18px;
box-shadow:5px 5px 0 var(--sheet-shadow);display:flex;flex-direction:column;gap:14px;transition:opacity .4s,filter .4s}
.sheet.stale{opacity:.72;filter:saturate(.35)}
.top{display:flex;align-items:center;gap:8px}
.word{font-weight:800;font-size:20px;letter-spacing:-.04em}
.mini,.coeur{display:flex;flex-direction:column;align-items:center;gap:1.5px}
.mini i{display:block;height:4px;border-radius:99px}.mini .p4{width:7px;border:1px dashed var(--ink);height:3.5px}
.mini .p3{width:11px;background:var(--accent)}.mini .p2{width:15px;background:var(--pop)}.mini .p1{width:19px;background:var(--ink);height:4.5px}
.chip{font-family:var(--mono);font-size:10.5px;font-weight:600;padding:0 8px;border:2px solid var(--ink);border-radius:99px;white-space:nowrap}
.proj{margin-left:auto;max-width:55%;overflow:hidden;text-overflow:ellipsis}
.oldchip{align-self:flex-start;border-style:dashed}
.count{display:flex;align-items:baseline;gap:4px}
.count b{font-weight:800;font-size:64px;letter-spacing:-.05em;line-height:.9}
.count span{font-weight:800;font-size:30px;letter-spacing:-.03em;color:var(--soft)}
.count em{margin-left:auto;font-style:normal;font-family:var(--mono);font-size:11px;color:var(--muted)}
.bar{display:grid;gap:5px}.bar i{height:14px;border:2px solid var(--ink);border-radius:99px;transition:background-color .6s ease}
.bar .d{background:var(--ink)}.bar .c{background:var(--accent)}
.steps{list-style:none;margin:0;padding:4px 0 0;display:flex;flex-direction:column;gap:9px}
.row{display:flex;align-items:center;gap:9px}
.box{width:20px;height:20px;flex:none;border-radius:6px;display:flex;align-items:center;justify-content:center;
font-family:var(--mono);font-size:10.5px;font-weight:700;transition:background-color .4s,color .4s}
.done .box{background:var(--ink);color:var(--box-fg);font-family:var(--brand);font-size:12px;font-weight:800}
.todo .box{border:2px dashed var(--ink)}
.t{flex:1;min-width:0;font-size:13.5px;font-weight:600;overflow-wrap:anywhere}
.done .t{color:var(--muted);text-decoration:line-through;text-decoration-color:var(--pop);text-decoration-thickness:2px}
.done span.t,.done summary{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
time{font-family:var(--mono);font-size:10.5px;color:var(--muted);white-space:nowrap}
.cur{margin:4px 0}
.card{padding:12px 14px;border:2.5px solid var(--ink);border-radius:16px;background:var(--accent);color:#fff;
box-shadow:4px 4px 0 var(--card-shadow);transform:rotate(-1.5deg);display:flex;flex-direction:column;gap:5px}
.cardtop{display:flex;align-items:center;justify-content:space-between;gap:8px}.card time{color:#fff}
.tag{font-family:var(--mono);font-size:10px;font-weight:700;padding:0 7px;border:2px solid #121212;border-radius:99px;
background:var(--pop);color:#121212}
.ct{font-size:18px;font-weight:800;line-height:1.15;letter-spacing:-.02em;overflow-wrap:anywhere}
.af{font-size:12.5px}
.files{display:flex;flex-wrap:wrap;gap:4px;margin:5px 0 0 29px}.card .files{margin:3px 0 0}
.files button{font-family:var(--mono);font-size:10px;font-weight:600;padding:0 7px;border:1.5px solid var(--ink);border-radius:99px;
background:transparent;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.files button.cmd{border-style:dashed}
.files button:hover,.files button.copie{background:var(--pop);color:#121212;border-color:#121212}
.card .files button{border-color:#fff;color:#fff}.files span{font-family:var(--mono);font-size:10px;color:var(--muted)}
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
.coeur .p3{width:32px;background:var(--accent)}.coeur .p2{width:46px;background:var(--pop)}.coeur .p1{width:60px;background:#121212}
.sig{align-self:flex-start;display:flex;align-items:center;gap:9px;padding:7px 13px;border:2.5px solid var(--ink);border-radius:14px;
background:var(--pop);color:#121212;box-shadow:3px 3px 0 var(--card-shadow);transform:rotate(-1.5deg);font-weight:800;font-size:14px}
.sig::before{content:"";flex:none;width:9px;height:9px;border-radius:50%;background:#121212;animation:clignote 1s steps(2) infinite}
.sig small{display:block;font-family:var(--mono);font-weight:600;font-size:10.5px}
.sig.fini{background:var(--accent);color:#fff}.sig.fini::before{display:none}
.pills{display:flex;gap:6px;flex-wrap:wrap}
.pill{font-family:var(--mono);font-size:10.5px;font-weight:700;padding:2px 9px;border:2px solid var(--ink);border-radius:99px;background:transparent}
.pill.on{background:var(--ink);color:var(--paper)}
.journal summary{font-family:var(--mono);font-size:11px;font-weight:700}
.journal ul{list-style:none;padding:0;margin:8px 0 0;display:flex;flex-direction:column;gap:6px}
.journal button{width:100%;text-align:left;display:flex;gap:8px;align-items:center;font-size:12.5px;padding:6px 10px;
border:2px solid var(--ink);border-radius:12px;background:var(--paper)}
.journal button b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.journal button span{font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap}
@keyframes pop{from{opacity:0;transform:rotate(-6deg) scale(.85)}}
@keyframes tampon{from{opacity:0;transform:rotate(-14deg) scale(1.6)}}
@keyframes glisse{from{opacity:0;transform:translateX(-8px)}}
@keyframes clignote{50%{opacity:.15}}
.card.in,.sig.in,.sheet.in{animation:pop .45s cubic-bezier(.2,1.5,.4,1)}
.summit.in{animation:tampon .5s cubic-bezier(.2,1.6,.4,1)}
.row.in,.files.in{animation:glisse .35s ease-out}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;

// Contenu de la vue (éléments marqués data-k : la page ne remplace que ce qui change, et anime ce qui arrive).
function renderApp(r, o = {}) {
  const t = T[o.lang] || T.fr;
  const now = o.now ?? Date.now();
  const heure = (ms) => (ms ? new Date(ms).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' }) : '');
  const date = (ms) => new Date(ms).toLocaleDateString(t.locale, { day: 'numeric', month: 'short' });
  const files = o.files || {};
  const cmdFiles = o.cmdFiles || {};
  const parts = [];

  if (o.pills?.length > 1) {
    parts.push(`<nav class="pills" data-k="pills">${o.pills.map((s) => `<button class="pill${s.sid === r?.sid ? ' on' : ''}" data-k="p-${esc(s.sid)}" data-sid="${esc(s.sid)}">${heure(s.mtime)} · ${s.done}/${s.total}</button>`).join('')}</nav>`);
  }
  if (o.signal) {
    const s = o.signal;
    parts.push(s.kind === 'attente'
      ? `<div class="sig" data-k="sig-a"><span>${esc(t.wait)}${s.message ? `<small>${esc(s.message)}</small>` : ''}</span></div>`
      : `<div class="sig fini" data-k="sig-f"><span>${esc(t.finished)}</span></div>`);
  }

  if (!r?.total) {
    parts.push(`<main class="sheet empty" data-k="empty">${TAMPON}<h2 data-k="h">${esc(t.emptyT)}</h2><p data-k="p">${esc(t.emptyP)}</p></main>`);
  } else {
    const { tasks, done, total } = r;
    const complete = done === total;
    const stale = r.mtime && now - r.mtime > (o.staleHours ?? 2) * 3600e3;
    const fichiers = (id, dansCarte) => {
      const directs = [...(files[id] || [])].map((p) => [p, '']);
      const autres = [...(cmdFiles[id] || [])].map((p) => [p, 'cmd']);
      const liste = [...directs.slice(-4), ...autres].slice(0, 4);
      const total = directs.length + autres.length;
      if (!total) return '';
      const vus = liste.map(([p, cls]) => `<button${cls ? ` class="${cls}"` : ''} data-open="${esc(p)}" data-step="${esc(id)}" title="${esc(p)}${cls ? ' · ' + esc(t.cmdFile) : ''}">${esc(path.basename(p))}</button>`).join('');
      return `<div class="files" data-k="f${dansCarte ? 'c' : ''}">${vus}${total > 4 ? `<span>+${total - 4}</span>` : ''}</div>`;
    };
    const titre = (task, cls) => {
      const desc = task.description && task.description !== task.subject ? esc(task.description) : '';
      return desc ? `<details class="${cls}" data-k="t"><summary title="${esc(task.subject)}">${esc(task.subject)}</summary><p>${desc}</p></details>`
        : `<span class="${cls}" data-k="t" title="${esc(task.subject)}">${esc(task.subject)}</span>`;
    };
    const steps = tasks.map((task) => {
      const k = `s${esc(task.id)}`;
      if (task.status === 'completed') {
        return `<li class="done" data-k="${k}"><div class="row" data-k="row"><span class="box" data-k="box">✓</span>${titre(task, 't')}<time data-k="time">${heure(task.mtime)}</time></div>${fichiers(task.id)}</li>`;
      }
      if (task.status === 'in_progress') {
        const min = task.mtime ? Math.floor((now - task.mtime) / 60000) : 0;
        return `<li class="cur" data-k="${k}"><div class="card" data-k="card"><div class="cardtop" data-k="top"><span class="tag" data-k="tag">${esc(t.cur)}</span><time data-k="since">${esc(t.since(heure(task.mtime), min))}</time></div>${titre(task, 'ct')}${task.activeForm ? `<span class="af" data-k="af">${esc(task.activeForm)}…</span>` : ''}${fichiers(task.id, true)}</div></li>`;
      }
      const wait = task.blockedBy?.length ? `<span class="chip" data-k="wait">${esc(t.after)} #${task.blockedBy.map(esc).join(', #')}</span>` : '';
      return `<li class="todo" data-k="${k}"><div class="row" data-k="row"><span class="box" data-k="box">${esc(task.id)}</span>${titre(task, 't')}${wait}</div></li>`;
    }).join('');
    const segs = tasks.map((task) => `<i class="${task.status === 'completed' ? 'd' : task.status === 'in_progress' ? 'c' : ''}" data-k="b${esc(task.id)}"></i>`).join('');
    const proj = r.cwd ? `<span class="chip proj" title="${esc(r.cwd)}" data-k="proj">${esc(path.basename(r.cwd))}</span>` : '';
    const head = complete
      ? `<div class="summit" data-k="summit">${esc(t.summit)}</div>`
      : `<div class="count" data-k="count"><b>${done}</b><span>/${total}</span><em>${esc(t.steps)} · ${Math.round((done / total) * 100)} %</em></div>`;
    const after = complete
      ? `<div class="chips" data-k="chips"><span class="chip">${esc(t.count(total))}</span><span class="chip fin">${esc(t.doneAt)} ${heure(Math.max(...tasks.map((x) => x.mtime || 0)))}</span></div>`
      : '';
    const ancien = stale ? `<span class="chip oldchip" data-k="old">${esc(t.old)} · ${esc(t.ago(now - r.mtime, date(r.mtime)))}</span>` : '';
    const retour = o.latestSid && o.latestSid !== r.sid && !o.pills?.some((s) => s.sid === r.sid)
      ? `<button class="pill" data-k="back" data-sid="${esc(o.latestSid)}">${esc(t.back)}</button>` : '';
    const foot = complete ? `${PILE}<span class="foot" data-k="foot" style="align-self:center">${esc(t.full)}</span>` : `<span class="foot" data-k="foot">${esc(t.foot)}</span>`;
    parts.push(`<main class="sheet${stale ? ' stale' : ''}" data-k="sheet-${esc(r.sid)}"><header class="top" data-k="top">${MINI}<span class="word" data-k="w">cairn</span>${proj}</header>${retour}${ancien}${head}
<div class="bar" data-k="bar" style="grid-template-columns:repeat(${total},minmax(0,1fr))">${segs}</div>${after}
<ol class="steps" data-k="steps">${steps}</ol>${foot}</main>`);
  }

  if (o.journal?.length) {
    const items = o.journal.map((s) => `<li data-k="j-${esc(s.sid)}"><button data-sid="${esc(s.sid)}"><b>${esc(s.tasks[0]?.subject)}</b><span>${date(s.mtime)} · ${s.done}/${s.total}</span></button></li>`).join('');
    parts.push(`<details class="journal" data-k="journal"><summary data-k="sum">${esc(t.journal)} · ${o.journal.length}</summary><ul data-k="list">${items}</ul></details>`);
  }
  return parts.join('');
}

// Page statique (tests, captures du README) : même contenu, sans script.
function render(r, o = {}) {
  return `<!doctype html><html lang="${o.lang || 'fr'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body><div id="app">${renderApp(r, o)}</div></body></html>`;
}

// Script de la vue : remplace seulement les éléments qui changent (et anime ceux qui arrivent), annonce les
// changements aux lecteurs d'écran, relaie les clics. Le transport diffère entre VS Code et la vue universelle.
const SCRIPT = `
const app = document.getElementById('app'); const annonce = document.getElementById('annonce'); let premier = true;
const sync = (a, b) => {
  for (const { name } of [...a.attributes]) if (name !== 'open' && !b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) {
    const v = name === 'class' && a.classList.contains('in') ? value + ' in' : value;
    if (a.getAttribute(name) !== v) a.setAttribute(name, v);
  }
};
function patch(a, b) {
  const old = new Map();
  for (const c of [...a.children]) c.dataset.k ? old.set(c.dataset.k, c) : c.remove();
  [...b.children].forEach((n, i) => {
    let cur = old.get(n.dataset.k);
    if (cur && cur.tagName === n.tagName) {
      old.delete(n.dataset.k);
      sync(cur, n);
      if ([...n.children].some((c) => c.dataset.k)) patch(cur, n);
      else if (cur.innerHTML !== n.innerHTML) cur.innerHTML = n.innerHTML;
    } else {
      cur = n;
      if (!premier) cur.classList.add('in');
    }
    if (a.children[i] !== cur) a.insertBefore(cur, a.children[i] || null);
  });
  old.forEach((c) => c.remove());
}
const recevoir = (m) => {
  if (m.type !== 'state') return;
  for (const [k, v] of Object.entries(m.vars || {})) document.documentElement.style.setProperty(k, v);
  const tpl = document.createElement('template');
  tpl.innerHTML = m.html;
  patch(app, tpl.content);
  premier = false;
  if (typeof m.annonce === 'string' && annonce.textContent !== m.annonce) annonce.textContent = m.annonce;
};
addEventListener('click', (e) => {
  const el = e.target.closest('[data-open],[data-sid]');
  if (!el) return;
  e.preventDefault();
  if (el.dataset.open) ouvrir(el); else envoyer({ type: 'select', sid: el.dataset.sid });
});`;
const TRANSPORT = {
  vscode: `
const vscode = acquireVsCodeApi();
const envoyer = (m) => vscode.postMessage(m);
const ouvrir = (el) => envoyer({ type: 'open', file: el.dataset.open, step: el.dataset.step });
addEventListener('message', (e) => recevoir(e.data));
envoyer({ type: 'ready' });`,
  web: `
const envoyer = (m) => fetch('/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) });
const ouvrir = (el) => navigator.clipboard?.writeText(el.dataset.open).then(() => { el.classList.add('copie'); setTimeout(() => el.classList.remove('copie'), 1200); });
const sombre = matchMedia('(prefers-color-scheme: dark)');
const theme = () => { document.body.className = sombre.matches ? 'vscode-dark' : 'vscode-light'; };
theme(); sombre.addEventListener('change', theme);
new EventSource('/events').onmessage = (e) => recevoir(JSON.parse(e.data));`,
};
const CSS_WEB = 'body{min-height:100vh;padding:24px 16px}body.vscode-light{background:#F3F3F3}body.vscode-dark{background:#181818}';

// Polices de marque embarquées (media/fonts, licence SIL OFL 1.1) ; url(f) donne l'adresse d'un fichier de police.
const polices = (url) =>
  `@font-face{font-family:'Bricolage Grotesque';font-weight:400 800;font-display:swap;src:url(${url('BricolageGrotesque.woff2')}) format('woff2')}` +
  `@font-face{font-family:'JetBrains Mono';font-weight:400 700;font-display:swap;src:url(${url('JetBrainsMono.woff2')}) format('woff2')}`;

// Page de la vue : seuls son script (jeton) et les polices de l'extension (source) sont autorisés ;
// en mode web, la page parle aussi à son propre serveur (connect-src 'self').
function shell(nonce, source = '', fontsCss = '', web = false) {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';${source ? ` font-src ${source};` : ''}${web ? " connect-src 'self';" : ''}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Cairn</title><style>${fontsCss}${CSS}${web ? CSS_WEB : ''}</style></head>
<body><div id="annonce" class="sr" role="status" aria-live="polite"></div><div id="app"></div>
<script nonce="${nonce}">${SCRIPT}${TRANSPORT[web ? 'web' : 'vscode']}</script></body></html>`;
}

// ---------- extension ----------

function activate(context) {
  const vscode = require('vscode');
  let view, pret = false, dernier, choisi = null, courant = null, connus = new Set(), sessions = [];
  const notifies = new Set();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'cairn.roadmap.focus';

  const reglages = () => {
    const c = vscode.workspace.getConfiguration('cairn');
    const hex = (v, d) => (/^#[0-9a-fA-F]{3,8}$/.test(String(v)) ? v : d);
    const langue = c.get('language', 'auto');
    return {
      accent: hex(c.get('accent'), '#2B3BFF'), pop: hex(c.get('pop'), '#FF7AD9'),
      staleHours: Math.max(0.1, Number(c.get('staleHours', 2)) || 2), notifications: c.get('notifications', true) !== false,
      lang: langue === 'fr' || langue === 'en' ? langue : vscode.env.language.toLowerCase().startsWith('fr') ? 'fr' : 'en',
    };
  };

  // Fichiers que git voit modifiés, via l'extension Git intégrée (aucun processus lancé).
  const changesGit = () => {
    try {
      const git = vscode.extensions.getExtension('vscode.git');
      if (!git?.isActive) return [];
      return [...new Set(git.exports.getAPI(1).repositories.flatMap((repo) =>
        [...repo.state.workingTreeChanges, ...repo.state.indexChanges, ...(repo.state.untrackedChanges || [])].map((c) => c.uri.fsPath)))];
    } catch { return []; }
  };

  const envoyer = (msg) => {
    const cle = JSON.stringify(msg);
    if (!view || !pret || cle === dernier) return;
    dernier = cle;
    view.webview.postMessage(msg);
  };

  const refresh = () => {
    const c = reglages();
    const t = T[c.lang];
    const now = Date.now();
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => {
      try { return fs.realpathSync.native(f.uri.fsPath); } catch { return f.uri.fsPath; }
    });
    sessions = loadSessions(folders);
    const latest = sessions[0];
    if (!sessions.some((s) => s.sid === choisi)) choisi = null;
    const r = sessions.find((s) => s.sid === choisi) || latest || null;
    courant = r;
    const tr = r ? traceOf(r.sid) : traceVide();
    const cmdFiles = r ? filesParCommande(r.tasks, tr, changesGit(), now) : {};
    connus = new Set([...Object.values(tr.files), ...Object.values(cmdFiles)].flatMap((s) => [...s]));
    const signal = readSignal(folders, CLAUDE_DIR, now);
    const actives = sessions.filter((s) => now - s.mtime < c.staleHours * 3600e3);
    const pills = actives.length > 1 ? actives : [];
    const journal = sessions.filter((s) => s.sid !== r?.sid && !pills.includes(s)).slice(0, 8);

    envoyer({ type: 'state', html: renderApp(r, { files: tr.files, cmdFiles, signal, pills, journal, latestSid: latest?.sid, now, lang: c.lang, staleHours: c.staleHours }),
      vars: { '--accent': c.accent, '--pop': c.pop }, annonce: annonce(r, signal, c.lang) });
    if (view) {
      const reste = r ? r.total - r.done : 0;
      view.description = r?.total ? `${r.done}/${r.total}` : undefined;
      view.badge = reste ? { value: reste, tooltip: t.left(reste) } : undefined;
    }

    const compte = r?.total ? ` · ${r.done}/${r.total}` : '';
    status.backgroundColor = signal?.kind === 'attente' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    if (signal?.kind === 'attente') status.text = `$(bell-dot) ${t.wait}${compte}`;
    else if (signal?.kind === 'fini') status.text = `$(check) ${t.finished}${compte}`;
    else if (r?.total) {
      const cur = r.tasks.find((x) => x.status === 'in_progress');
      status.text = `$(milestone) ${bar(r.done, r.total, 8)} ${r.done}/${r.total}` +
        (cur ? ` · ${cur.activeForm || cur.subject}` : r.done === r.total ? ` · ${t.statusDone}` : '');
    }
    status.tooltip = r?.total ? t.tip + '\n' + r.tasks.map((x) => `${{ completed: '✓', in_progress: '▶' }[x.status] || '○'} ${x.id}. ${x.subject}`).join('\n') : t.tip;
    if (signal || r?.total) status.show(); else status.hide();

    if (signal?.kind === 'attente' && c.notifications && !notifies.has(signal.sid + signal.t)) {
      notifies.add(signal.sid + signal.t);
      vscode.window.showInformationMessage(t.notif(signal.message), t.openTerm)
        .then((choix) => choix && vscode.commands.executeCommand('workbench.action.terminal.focus'));
    }
  };

  // Clic sur un fichier : comparaison « avant l'étape ↔ maintenant » si Claude Code en a gardé une copie,
  // sinon comparaison avec git, sinon le fichier seul.
  const AVANT = 'cairn-avant';
  const ouvrir = async (file, step) => {
    const droite = vscode.Uri.file(file);
    const tr = courant ? traceOf(courant.sid) : null;
    const copie = tr?.files[step]?.has(file) ? sauvegardeAvant(tr, file, tr.debut[step] ?? 0) : undefined;
    if (copie) {
      const gauche = vscode.Uri.from({ scheme: AVANT, path: `/${courant.sid}/${copie.nom || 'vide'}/${path.basename(file)}` });
      return vscode.commands.executeCommand('vscode.diff', gauche, droite, T[reglages().lang].diffTitle(path.basename(file), step));
    }
    try { await vscode.commands.executeCommand('git.openChange', droite); } catch { await vscode.commands.executeCommand('vscode.open', droite); }
  };

  let timer, boucle;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 150); };
  const watchers = {};
  const watch = () => {
    for (const dir of [path.join(CLAUDE_DIR, 'tasks'), path.join(CLAUDE_DIR, 'cairn', 'etat')]) {
      if (watchers[dir]) continue;
      try {
        watchers[dir] = fs.watch(dir, { recursive: true }, schedule);
        watchers[dir].on('error', () => { watchers[dir].close(); delete watchers[dir]; });
      } catch { /* dossier pas encore créé */ }
    }
  };
  // Relecture des transcripts et du chrono : toutes les 2 s au premier plan, toutes les 15 s sinon
  // (les dossiers de tâches et d'état restent surveillés en direct).
  const planifier = () => {
    clearTimeout(boucle);
    const actif = vscode.window.state.focused && view?.visible;
    boucle = setTimeout(() => { watch(); refresh(); planifier(); }, actif ? 2000 : 15000);
  };
  watch();
  refresh();
  planifier();

  context.subscriptions.push(
    status,
    vscode.workspace.registerTextDocumentContentProvider(AVANT, {
      // Copie de Claude Code en lecture seule : ~/.claude/file-history/<session>/<nom>, noms vérifiés.
      provideTextDocumentContent(uri) {
        const [, sid, nom] = uri.path.split('/');
        if (nom === 'vide' || !/^[\w-]+$/.test(sid) || !/^[0-9a-f]+@v\d+$/.test(nom)) return '';
        try { return fs.readFileSync(path.join(CLAUDE_DIR, 'file-history', sid, nom), 'utf8'); } catch { return ''; }
      },
    }),
    vscode.window.registerWebviewViewProvider('cairn.roadmap', {
      resolveWebviewView(v) {
        view = v;
        pret = false;
        dernier = undefined;
        const fonts = vscode.Uri.joinPath(context.extensionUri, 'media', 'fonts');
        v.webview.options = { enableScripts: true, localResourceRoots: [fonts] };
        const url = (f) => v.webview.asWebviewUri(vscode.Uri.joinPath(fonts, f)).toString();
        v.webview.html = shell(crypto.randomBytes(16).toString('base64'), v.webview.cspSource, polices(url));
        v.webview.onDidReceiveMessage((m) => {
          if (m?.type === 'ready') { pret = true; dernier = undefined; refresh(); }
          else if (m?.type === 'select' && sessions.some((s) => s.sid === m.sid)) { choisi = m.sid; refresh(); }
          else if (m?.type === 'open' && connus.has(m.file)) ouvrir(m.file, String(m.step ?? ''));
        });
        v.onDidChangeVisibility(() => { schedule(); planifier(); });
        v.onDidDispose(() => { view = undefined; pret = false; });
      },
    }),
    vscode.commands.registerCommand('cairn.ouvrir', () => vscode.commands.executeCommand('cairn.roadmap.focus')),
    vscode.commands.registerCommand('cairn.reglages', () => vscode.commands.executeCommand('workbench.action.openSettings', 'cairn')),
    vscode.commands.registerCommand('cairn.rafraichir', refresh),
    vscode.window.onDidChangeWindowState(() => { schedule(); planifier(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(schedule),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('cairn') && schedule()),
    { dispose: () => { clearTimeout(boucle); clearTimeout(timer); Object.values(watchers).forEach((w) => w.close()); } },
  );
}

module.exports = {
  activate, deactivate() {}, loadRoadmap, loadSessions, filesByStep, traceOf, traceVide, sauvegardeAvant, filesParCommande,
  readSignal, annonce, bar, render, renderApp, shell, polices, CLAUDE_DIR,
};
