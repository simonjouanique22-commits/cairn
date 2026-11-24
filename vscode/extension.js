// Cairn: shows the roadmap Claude Code keeps in ~/.claude/tasks/<session>/<n>.json for the sessions started in the
// open folder: a live "sticker" sheet, files touched per step (before/after diff), "Claude is waiting for you",
// a log of past roadmaps, and progress in the status bar. The same functions serve the universal view (web/serve.js).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

// ---------- reading Claude Code's data (read-only) ----------

const transcripts = new Map();
// A session's transcript (~/.claude/projects/*/<session>.jsonl); the path is cached once found.
function transcriptOf(sid, claudeDir) {
  if (transcripts.has(sid)) return transcripts.get(sid);
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(claudeDir, 'projects')); } catch { return null; }
  for (const p of dirs) {
    const f = path.join(claudeDir, 'projects', p, sid + '.jsonl');
    if (fs.existsSync(f)) { transcripts.set(sid, f); return f; }
  }
  return null;
}

const cwdCache = new Map();
// Folder the session was started in: only the "cwd" field near the top of the transcript is read.
function sessionCwd(sid, claudeDir) {
  if (cwdCache.has(sid)) return cwdCache.get(sid);
  const f = transcriptOf(sid, claudeDir);
  if (!f) return null;
  const buf = Buffer.alloc(256 * 1024);
  const fd = fs.openSync(f, 'r');
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const m = buf.toString('utf8', 0, n).match(/"cwd":("(?:[^"\\]|\\.)*")/);
  if (!m) return null; // transcript not written yet: try again later
  let cwd = JSON.parse(m[1]);
  try { cwd = fs.realpathSync.native(cwd); } catch { /* folder gone: keep the path as is */ } // links, Windows short names
  cwdCache.set(sid, cwd);
  return cwd;
}
// True when cwd is one of the open folders or inside one (Windows separators and case included).
// ponytail: a named list (CLAUDE_CODE_TASK_LIST_ID) with no transcript is ignored when a folder is open
const inFolders = (cwd, folders) => !folders.length || (!!cwd && folders.some((w) => {
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

// Task lists of the sessions started in the open folders (all of them when no folder is open), most recent first.
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
    if (!inFolders(cwd, folders)) continue;
    const tasks = readTasks(c.dir, c.files);
    if (!tasks.length) continue;
    const done = tasks.filter((t) => t.status === 'completed').length;
    out.push({ sid: c.sid, tasks, done, total: tasks.length, mtime: c.mtime, cwd });
  }
  return out;
}
const loadRoadmap = (folders, claudeDir = CLAUDE_DIR) => loadSessions(folders, claudeDir, 1)[0] ?? null;

// Comparison key for a path: normalized separators, and case ignored on Windows.
const key = (p) => (process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p));

const traces = new Map();
const emptyTrace = () => ({ offset: 0, cur: null, rest: Buffer.alloc(0), files: {}, start: {}, end: {}, backups: {} });
// What the transcript says about the steps, read incrementally: start and end of each step (TaskUpdate), paths of the
// files written while it was in progress (Write/Edit/MultiEdit/NotebookEdit), and the backups Claude Code makes before
// changing a file (file-history-snapshot). Never the content of messages.
function traceOf(sid, claudeDir = CLAUDE_DIR) {
  const f = transcriptOf(sid, claudeDir);
  if (!f) return emptyTrace();
  let tr = traces.get(sid);
  const size = sizeOf(f);
  if (!tr || size < tr.offset) tr = emptyTrace();
  if (size > tr.offset) {
    const len = Math.min(size - tr.offset, 8 * 1024 * 1024); // ponytail: 8 MB per pass, the rest on the next one
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(f, 'r');
    fs.readSync(fd, buf, 0, len, tr.offset);
    fs.closeSync(fd);
    tr.offset += len;
    const all = Buffer.concat([tr.rest, buf]);
    const cut = all.lastIndexOf(10);
    tr.rest = cut < 0 ? all : all.subarray(cut + 1);
    for (const line of cut < 0 ? [] : all.subarray(0, cut).toString('utf8').split('\n')) {
      const snapshot = line.includes('"file-history-snapshot"');
      if (!snapshot && !line.includes('"tool_use"')) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (snapshot) {
        for (const [name, b] of Object.entries(msg.snapshot?.trackedFileBackups || {})) {
          const t = Date.parse(b?.backupTime);
          if (!t) continue;
          const abs = b.realParentDir ? path.join(b.realParentDir, path.basename(name)) : name;
          const list = (tr.backups[key(abs)] ||= []);
          if (!list.some((x) => x.t === t)) list.push({ t, name: b.backupFileName ?? null });
        }
        continue;
      }
      const when = Date.parse(msg.timestamp) || 0;
      for (const b of msg.message?.content || []) {
        if (b?.type !== 'tool_use') continue;
        if (b.name === 'TaskUpdate') {
          const id = String(b.input?.taskId);
          if (b.input?.status === 'in_progress') { tr.cur = id; tr.start[id] ??= when; }
          if (b.input?.status === 'completed') tr.end[id] = when;
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

// Backup Claude Code took right before its first change to the file since `since`
// ({ name: null }: the file did not exist yet; undefined: no known backup).
function backupBefore(tr, file, since) {
  return (tr.backups[key(file)] || []).filter((x) => x.t >= since - 1000).sort((a, b) => a.t - b.t)[0];
}

// Files changed during a step without a direct write from Claude (command, script, by hand): those git sees as changed
// whose modification time falls within the step's time window.
function filesByCommand(tasks, tr, changes, now = Date.now()) {
  const out = {};
  for (const task of tasks) {
    const start = tr.start[task.id];
    if (!start) continue;
    const end = task.status === 'completed' ? (tr.end[task.id] || task.mtime || now) : now;
    const direct = new Set([...(tr.files[task.id] || [])].map(key));
    for (const f of changes) {
      if (direct.has(key(f))) continue;
      const m = mtimeOf(f);
      if (m >= start && m <= end + 2000) (out[task.id] ||= new Set()).add(f);
    }
  }
  return out;
}

// Latest signal ("Claude is waiting for you" / "Claude is done") from a session in the folder, unless activity followed.
function readSignal(folders, claudeDir = CLAUDE_DIR, now = Date.now()) {
  const dir = path.join(claudeDir, 'cairn', 'state');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  let best = null;
  for (const name of names) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    const t = Number(s.t) * 1000;
    if (!t || now - t > 12 * 3600e3 || (best && t <= best.t)) continue;
    const sid = name.slice(0, -5);
    if (!inFolders(sessionCwd(sid, claudeDir), folders)) continue;
    const tr = transcriptOf(sid, claudeDir);
    if (tr && mtimeOf(tr) > t + (s.waiting ? 2000 : 3000)) continue; // Claude moved on since
    best = { sid, t, kind: s.waiting ? 'waiting' : s.done ? 'done' : null, message: String(s.message || '') };
  }
  return best?.kind ? best : null;
}

// ---------- rendering ----------

const T = {
  en: {
    locale: 'en-GB', steps: 'steps', cur: 'IN PROGRESS', after: 'after', foot: '→ on to the summit',
    summit: 'Summit reached ✓', doneAt: 'done at', count: (n) => `${n} steps`, full: 'the cairn is complete.',
    emptyT: 'Nothing to mark yet', emptyP: "Cairn shows Claude's plan as soon as a request has several steps.",
    wait: 'Claude is waiting for you', finished: 'Claude is done — your turn ✓', old: 'old roadmap', log: 'Log',
    back: '↩ current roadmap', left: (n) => `${n} step(s) left`, openTerm: 'Open terminal',
    notif: (m) => `Claude is waiting for you${m ? ': ' + m : ''}`, tip: "Cairn — Claude's roadmap", statusDone: 'summit reached',
    since: (h, m) => `since ${h}${m ? ` · ${m} min` : ''}`, inProgress: (x, d, n) => `In progress: ${x} — ${d}/${n} steps done`,
    cmdFile: 'changed during the step (command or by hand)', diffTitle: (f, s) => `${f} · before step ${s} ↔ now`,
    ago: (ms, date) => { const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `on ${date}`; },
  },
  fr: {
    locale: 'fr-FR', steps: 'étapes', cur: 'EN COURS', after: 'après', foot: '→ arrivée au sommet',
    summit: 'Sommet atteint ✓', doneAt: 'fini à', count: (n) => `${n} étapes`, full: 'le cairn est complet.',
    emptyT: "Rien à baliser pour l'instant", emptyP: "Cairn affiche le plan de Claude dès qu'une demande compte plusieurs étapes.",
    wait: "Claude t'attend", finished: 'Claude a fini, à toi ✓', old: 'ancienne roadmap', log: 'Journal',
    back: '↩ roadmap en cours', left: (n) => `${n} étape(s) restante(s)`, openTerm: 'Ouvrir le terminal',
    notif: (m) => `Claude t'attend${m ? ' : ' + m : ''}`, tip: 'Cairn — roadmap de Claude', statusDone: 'sommet atteint',
    since: (h, m) => `depuis ${h}${m ? ` · ${m} min` : ''}`, inProgress: (x, d, n) => `En cours : ${x} — ${d}/${n} étapes faites`,
    cmdFile: "modifié pendant l'étape (commande ou à la main)", diffTitle: (f, s) => `${f} · avant l'étape ${s} ↔ maintenant`,
    ago: (ms, date) => { const m = Math.round(ms / 60000); return m < 1 ? "à l'instant" : m < 60 ? `il y a ${m} min` : m < 2880 ? `il y a ${Math.round(m / 60)} h` : `le ${date}`; },
  },
};

const bar = (done, total, width = 10) => {
  const n = total ? Math.round((done / total) * width) : 0;
  return '▰'.repeat(n) + '▱'.repeat(width - n);
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Sentence announced to screen readers when it changes.
function announcement(r, signal, lang = 'en') {
  const t = T[lang] || T.en;
  if (signal?.kind === 'waiting') return t.notif(signal.message);
  if (signal?.kind === 'done') return t.finished;
  if (!r?.total) return '';
  if (r.done === r.total) return t.summit;
  const cur = r.tasks.find((x) => x.status === 'in_progress');
  return cur ? t.inProgress(cur.activeForm || cur.subject, r.done, r.total) : `${r.done}/${r.total}`;
}

// Small S1 logo, full letter stack (summit), S4 stamp (empty state).
const MINI = '<span class="mini" aria-hidden="true" data-k="mini"><i class="p4"></i><i class="p3"></i><i class="p2"></i><i class="p1"></i></span>';
const STACK = '<div class="stack" aria-hidden="true" data-k="stack"><b class="l-c">c</b><b class="l-a">a</b><b class="l-i">i</b><b class="l-r">r</b><b class="l-n">n</b></div>';
const STAMP = `<div class="stamp" aria-hidden="true" data-k="stamp"><svg viewBox="0 0 220 220"><defs><path id="ring" d="M110,110 m-86,0 a86,86 0 1,1 172,0 a86,86 0 1,1 -172,0"/></defs>
<text><textPath href="#ring" textLength="536" lengthAdjust="spacing">CAIRN · CLAUDE CODE'S PLAN · STONE BY STONE ·</textPath></text></svg>
<div class="core"><i class="p4"></i><i class="p3"></i><i class="p2"></i><i class="p1"></i></div></div>`;

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
.mini,.core{display:flex;flex-direction:column;align-items:center;gap:1.5px}
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
.files button:hover,.files button.copied{background:var(--pop);color:#121212;border-color:#121212}
.card .files button{border-color:#fff;color:#fff}.files span{font-family:var(--mono);font-size:10px;color:var(--muted)}
summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
summary::after{content:" ▾";font-size:10px;opacity:.6}details[open] summary::after{content:" ▴"}
details p{margin:4px 0 0;font-size:12px;font-weight:500;color:var(--muted);text-decoration:none;white-space:pre-wrap}
.card details p{color:#fff;opacity:.85}
.foot{font-family:var(--mono);font-size:11px;color:var(--muted)}
.summit{align-self:center;margin:4px 0 0;padding:4px 18px;background:var(--pop);color:#121212;border:2.5px solid var(--ink);
border-radius:99px;box-shadow:4px 4px 0 var(--card-shadow);transform:rotate(-4deg);font-weight:800;font-size:24px;letter-spacing:-.03em}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chips .fin{background:var(--accent);color:#fff}
.stack{display:flex;flex-direction:column;align-items:center;gap:3px;padding-top:8px}
.stack b{display:block;border:2px solid var(--ink);border-radius:99px;font-weight:800;line-height:1.1}
.l-c{padding:0 9px;font-size:16px;background:var(--pop);color:#121212;transform:rotate(-6deg)}
.l-a{padding:0 12px;font-size:20px;background:var(--accent);color:#fff;transform:rotate(4deg)}
.l-i{padding:0 18px;font-size:23px;background:var(--paper);transform:rotate(-3deg)}
.l-r{padding:0 24px;font-size:27px;background:var(--pop);color:#121212;transform:rotate(5deg)}
.l-n{padding:0 32px;font-size:32px;background:var(--ink);color:var(--paper);transform:rotate(-2deg)}
.empty{align-items:center;text-align:center;padding:26px 16px}
.empty h2{margin:6px 0 0;font-size:19px;font-weight:800;letter-spacing:-.03em}.empty p{margin:0;font-family:var(--mono);font-size:11px;color:var(--muted)}
.stamp{position:relative;width:190px;height:190px;border-radius:50%;background:var(--pop);border:2.5px solid var(--ink);
box-shadow:5px 5px 0 var(--card-shadow);transform:rotate(-10deg);display:flex;align-items:center;justify-content:center}
.stamp svg{position:absolute;inset:0;width:100%;height:100%}
.stamp text{font-family:var(--mono);font-size:12.5px;font-weight:700;fill:#121212}
.core{width:104px;height:104px;border-radius:50%;background:#FFFDF8;border:2.5px solid #121212;justify-content:center;gap:3px}
.core i{display:block;height:11px;border:2px solid #121212;border-radius:99px}.core .p4{width:20px;border-style:dashed}
.core .p3{width:32px;background:var(--accent)}.core .p2{width:46px;background:var(--pop)}.core .p1{width:60px;background:#121212}
.signal{align-self:flex-start;display:flex;align-items:center;gap:9px;padding:7px 13px;border:2.5px solid var(--ink);border-radius:14px;
background:var(--pop);color:#121212;box-shadow:3px 3px 0 var(--card-shadow);transform:rotate(-1.5deg);font-weight:800;font-size:14px}
.signal::before{content:"";flex:none;width:9px;height:9px;border-radius:50%;background:#121212;animation:blink 1s steps(2) infinite}
.signal small{display:block;font-family:var(--mono);font-weight:600;font-size:10.5px}
.signal.done{background:var(--accent);color:#fff}.signal.done::before{display:none}
.pills{display:flex;gap:6px;flex-wrap:wrap}
.pill{font-family:var(--mono);font-size:10.5px;font-weight:700;padding:2px 9px;border:2px solid var(--ink);border-radius:99px;background:transparent}
.pill.on{background:var(--ink);color:var(--paper)}
.log summary{font-family:var(--mono);font-size:11px;font-weight:700}
.log ul{list-style:none;padding:0;margin:8px 0 0;display:flex;flex-direction:column;gap:6px}
.log button{width:100%;text-align:left;display:flex;gap:8px;align-items:center;font-size:12.5px;padding:6px 10px;
border:2px solid var(--ink);border-radius:12px;background:var(--paper)}
.log button b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.log button span{font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap}
@keyframes pop{from{opacity:0;transform:rotate(-6deg) scale(.85)}}
@keyframes stamp{from{opacity:0;transform:rotate(-14deg) scale(1.6)}}
@keyframes slide{from{opacity:0;transform:translateX(-8px)}}
@keyframes blink{50%{opacity:.15}}
.card.in,.signal.in,.sheet.in{animation:pop .45s cubic-bezier(.2,1.5,.4,1)}
.summit.in{animation:stamp .5s cubic-bezier(.2,1.6,.4,1)}
.row.in,.files.in{animation:slide .35s ease-out}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;

// View content (elements tagged data-k: the page only replaces what changed, and animates what arrives).
function renderApp(r, o = {}) {
  const t = T[o.lang] || T.en;
  const now = o.now ?? Date.now();
  const hour = (ms) => (ms ? new Date(ms).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' }) : '');
  const date = (ms) => new Date(ms).toLocaleDateString(t.locale, { day: 'numeric', month: 'short' });
  const files = o.files || {};
  const cmdFiles = o.cmdFiles || {};
  const parts = [];

  if (o.pills?.length > 1) {
    parts.push(`<nav class="pills" data-k="pills">${o.pills.map((s) => `<button class="pill${s.sid === r?.sid ? ' on' : ''}" data-k="p-${esc(s.sid)}" data-sid="${esc(s.sid)}">${hour(s.mtime)} · ${s.done}/${s.total}</button>`).join('')}</nav>`);
  }
  if (o.signal) {
    const s = o.signal;
    parts.push(s.kind === 'waiting'
      ? `<div class="signal" data-k="sig-w"><span>${esc(t.wait)}${s.message ? `<small>${esc(s.message)}</small>` : ''}</span></div>`
      : `<div class="signal done" data-k="sig-d"><span>${esc(t.finished)}</span></div>`);
  }

  if (!r?.total) {
    parts.push(`<main class="sheet empty" data-k="empty">${STAMP}<h2 data-k="h">${esc(t.emptyT)}</h2><p data-k="p">${esc(t.emptyP)}</p></main>`);
  } else {
    const { tasks, done, total } = r;
    const complete = done === total;
    const stale = r.mtime && now - r.mtime > (o.staleHours ?? 2) * 3600e3;
    const fileChips = (id, inCard) => {
      const direct = [...(files[id] || [])].map((p) => [p, '']);
      const others = [...(cmdFiles[id] || [])].map((p) => [p, 'cmd']);
      const shown = [...direct.slice(-4), ...others].slice(0, 4);
      const count = direct.length + others.length;
      if (!count) return '';
      const chips = shown.map(([p, cls]) => `<button${cls ? ` class="${cls}"` : ''} data-open="${esc(p)}" data-step="${esc(id)}" title="${esc(p)}${cls ? ' · ' + esc(t.cmdFile) : ''}">${esc(path.basename(p))}</button>`).join('');
      return `<div class="files" data-k="f${inCard ? 'c' : ''}">${chips}${count > 4 ? `<span>+${count - 4}</span>` : ''}</div>`;
    };
    const title = (task, cls) => {
      const desc = task.description && task.description !== task.subject ? esc(task.description) : '';
      return desc ? `<details class="${cls}" data-k="t"><summary title="${esc(task.subject)}">${esc(task.subject)}</summary><p>${desc}</p></details>`
        : `<span class="${cls}" data-k="t" title="${esc(task.subject)}">${esc(task.subject)}</span>`;
    };
    const steps = tasks.map((task) => {
      const k = `s${esc(task.id)}`;
      if (task.status === 'completed') {
        return `<li class="done" data-k="${k}"><div class="row" data-k="row"><span class="box" data-k="box">✓</span>${title(task, 't')}<time data-k="time">${hour(task.mtime)}</time></div>${fileChips(task.id)}</li>`;
      }
      if (task.status === 'in_progress') {
        const min = task.mtime ? Math.floor((now - task.mtime) / 60000) : 0;
        return `<li class="cur" data-k="${k}"><div class="card" data-k="card"><div class="cardtop" data-k="top"><span class="tag" data-k="tag">${esc(t.cur)}</span><time data-k="since">${esc(t.since(hour(task.mtime), min))}</time></div>${title(task, 'ct')}${task.activeForm ? `<span class="af" data-k="af">${esc(task.activeForm)}…</span>` : ''}${fileChips(task.id, true)}</div></li>`;
      }
      const wait = task.blockedBy?.length ? `<span class="chip" data-k="wait">${esc(t.after)} #${task.blockedBy.map(esc).join(', #')}</span>` : '';
      return `<li class="todo" data-k="${k}"><div class="row" data-k="row"><span class="box" data-k="box">${esc(task.id)}</span>${title(task, 't')}${wait}</div></li>`;
    }).join('');
    const segs = tasks.map((task) => `<i class="${task.status === 'completed' ? 'd' : task.status === 'in_progress' ? 'c' : ''}" data-k="b${esc(task.id)}"></i>`).join('');
    const proj = r.cwd ? `<span class="chip proj" title="${esc(r.cwd)}" data-k="proj">${esc(path.basename(r.cwd))}</span>` : '';
    const head = complete
      ? `<div class="summit" data-k="summit">${esc(t.summit)}</div>`
      : `<div class="count" data-k="count"><b>${done}</b><span>/${total}</span><em>${esc(t.steps)} · ${Math.round((done / total) * 100)} %</em></div>`;
    const after = complete
      ? `<div class="chips" data-k="chips"><span class="chip">${esc(t.count(total))}</span><span class="chip fin">${esc(t.doneAt)} ${hour(Math.max(...tasks.map((x) => x.mtime || 0)))}</span></div>`
      : '';
    const old = stale ? `<span class="chip oldchip" data-k="old">${esc(t.old)} · ${esc(t.ago(now - r.mtime, date(r.mtime)))}</span>` : '';
    const back = o.latestSid && o.latestSid !== r.sid && !o.pills?.some((s) => s.sid === r.sid)
      ? `<button class="pill" data-k="back" data-sid="${esc(o.latestSid)}">${esc(t.back)}</button>` : '';
    const foot = complete ? `${STACK}<span class="foot" data-k="foot" style="align-self:center">${esc(t.full)}</span>` : `<span class="foot" data-k="foot">${esc(t.foot)}</span>`;
    parts.push(`<main class="sheet${stale ? ' stale' : ''}" data-k="sheet-${esc(r.sid)}"><header class="top" data-k="top">${MINI}<span class="word" data-k="w">cairn</span>${proj}</header>${back}${old}${head}
<div class="bar" data-k="bar" style="grid-template-columns:repeat(${total},minmax(0,1fr))">${segs}</div>${after}
<ol class="steps" data-k="steps">${steps}</ol>${foot}</main>`);
  }

  if (o.log?.length) {
    const items = o.log.map((s) => `<li data-k="j-${esc(s.sid)}"><button data-sid="${esc(s.sid)}"><b>${esc(s.tasks[0]?.subject)}</b><span>${date(s.mtime)} · ${s.done}/${s.total}</span></button></li>`).join('');
    parts.push(`<details class="log" data-k="log"><summary data-k="sum">${esc(t.log)} · ${o.log.length}</summary><ul data-k="list">${items}</ul></details>`);
  }
  return parts.join('');
}

// Static page (tests, README screenshots): same content, no script.
function render(r, o = {}) {
  return `<!doctype html><html lang="${o.lang || 'en'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body><div id="app">${renderApp(r, o)}</div></body></html>`;
}

// View script: only replaces the elements that changed (and animates the ones that arrive), announces changes to
// screen readers, relays clicks. The transport differs between VS Code and the universal view.
const SCRIPT = `
const app = document.getElementById('app'); const live = document.getElementById('live'); let first = true;
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
      if (!first) cur.classList.add('in');
    }
    if (a.children[i] !== cur) a.insertBefore(cur, a.children[i] || null);
  });
  old.forEach((c) => c.remove());
}
const receive = (m) => {
  if (m.type !== 'state') return;
  for (const [k, v] of Object.entries(m.vars || {})) document.documentElement.style.setProperty(k, v);
  const tpl = document.createElement('template');
  tpl.innerHTML = m.html;
  patch(app, tpl.content);
  first = false;
  if (typeof m.announcement === 'string' && live.textContent !== m.announcement) live.textContent = m.announcement;
};
addEventListener('click', (e) => {
  const el = e.target.closest('[data-open],[data-sid]');
  if (!el) return;
  e.preventDefault();
  if (el.dataset.open) open(el); else send({ type: 'select', sid: el.dataset.sid });
});`;
const TRANSPORT = {
  vscode: `
const vscode = acquireVsCodeApi();
const send = (m) => vscode.postMessage(m);
const open = (el) => send({ type: 'open', file: el.dataset.open, step: el.dataset.step });
addEventListener('message', (e) => receive(e.data));
send({ type: 'ready' });`,
  web: `
const send = (m) => fetch('/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) });
const open = (el) => navigator.clipboard?.writeText(el.dataset.open).then(() => { el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 1200); });
const dark = matchMedia('(prefers-color-scheme: dark)');
const theme = () => { document.body.className = dark.matches ? 'vscode-dark' : 'vscode-light'; };
theme(); dark.addEventListener('change', theme);
new EventSource('/events').onmessage = (e) => receive(JSON.parse(e.data));`,
};
const CSS_WEB = 'body{min-height:100vh;padding:24px 16px}body.vscode-light{background:#F3F3F3}body.vscode-dark{background:#181818}';

// Brand fonts shipped with the extension (media/fonts, SIL OFL 1.1); url(f) gives the address of a font file.
const fontFaces = (url) =>
  `@font-face{font-family:'Bricolage Grotesque';font-weight:400 800;font-display:swap;src:url(${url('BricolageGrotesque.woff2')}) format('woff2')}` +
  `@font-face{font-family:'JetBrains Mono';font-weight:400 700;font-display:swap;src:url(${url('JetBrainsMono.woff2')}) format('woff2')}`;

// View page: only its own script (nonce) and the extension's fonts (source) are allowed;
// in web mode, the page also talks to its own server (connect-src 'self').
function shell(nonce, source = '', fontsCss = '', web = false, lang = 'en') {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';${source ? ` font-src ${source};` : ''}${web ? " connect-src 'self';" : ''}`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Cairn</title><style>${fontsCss}${CSS}${web ? CSS_WEB : ''}</style></head>
<body><div id="live" class="sr" role="status" aria-live="polite"></div><div id="app"></div>
<script nonce="${nonce}">${SCRIPT}${TRANSPORT[web ? 'web' : 'vscode']}</script></body></html>`;
}

// ---------- extension ----------

function activate(context) {
  const vscode = require('vscode');
  let view, ready = false, last, chosen = null, current = null, known = new Set(), sessions = [];
  const notified = new Set();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'cairn.roadmap.focus';

  const settings = () => {
    const c = vscode.workspace.getConfiguration('cairn');
    const hex = (v, d) => (/^#[0-9a-fA-F]{3,8}$/.test(String(v)) ? v : d);
    const language = c.get('language', 'auto');
    return {
      accent: hex(c.get('accent'), '#2B3BFF'), pop: hex(c.get('pop'), '#FF7AD9'),
      staleHours: Math.max(0.1, Number(c.get('staleHours', 2)) || 2), notifications: c.get('notifications', true) !== false,
      lang: language === 'fr' || language === 'en' ? language : vscode.env.language.toLowerCase().startsWith('fr') ? 'fr' : 'en',
    };
  };

  // Files git sees as changed, through the built-in Git extension (no process started).
  const gitChanges = () => {
    try {
      const git = vscode.extensions.getExtension('vscode.git');
      if (!git?.isActive) return [];
      return [...new Set(git.exports.getAPI(1).repositories.flatMap((repo) =>
        [...repo.state.workingTreeChanges, ...repo.state.indexChanges, ...(repo.state.untrackedChanges || [])].map((c) => c.uri.fsPath)))];
    } catch { return []; }
  };

  const post = (msg) => {
    const k = JSON.stringify(msg);
    if (!view || !ready || k === last) return;
    last = k;
    view.webview.postMessage(msg);
  };

  const refresh = () => {
    const c = settings();
    const t = T[c.lang];
    const now = Date.now();
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => {
      try { return fs.realpathSync.native(f.uri.fsPath); } catch { return f.uri.fsPath; }
    });
    sessions = loadSessions(folders);
    const latest = sessions[0];
    if (!sessions.some((s) => s.sid === chosen)) chosen = null;
    const r = sessions.find((s) => s.sid === chosen) || latest || null;
    current = r;
    const tr = r ? traceOf(r.sid) : emptyTrace();
    const cmdFiles = r ? filesByCommand(r.tasks, tr, gitChanges(), now) : {};
    known = new Set([...Object.values(tr.files), ...Object.values(cmdFiles)].flatMap((s) => [...s]));
    const signal = readSignal(folders, CLAUDE_DIR, now);
    const active = sessions.filter((s) => now - s.mtime < c.staleHours * 3600e3);
    const pills = active.length > 1 ? active : [];
    const log = sessions.filter((s) => s.sid !== r?.sid && !pills.includes(s)).slice(0, 8);

    post({ type: 'state', html: renderApp(r, { files: tr.files, cmdFiles, signal, pills, log, latestSid: latest?.sid, now, lang: c.lang, staleHours: c.staleHours }),
      vars: { '--accent': c.accent, '--pop': c.pop }, announcement: announcement(r, signal, c.lang) });
    if (view) {
      const left = r ? r.total - r.done : 0;
      view.description = r?.total ? `${r.done}/${r.total}` : undefined;
      view.badge = left ? { value: left, tooltip: t.left(left) } : undefined;
    }

    const tally = r?.total ? ` · ${r.done}/${r.total}` : '';
    status.backgroundColor = signal?.kind === 'waiting' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    if (signal?.kind === 'waiting') status.text = `$(bell-dot) ${t.wait}${tally}`;
    else if (signal?.kind === 'done') status.text = `$(check) ${t.finished}${tally}`;
    else if (r?.total) {
      const cur = r.tasks.find((x) => x.status === 'in_progress');
      status.text = `$(milestone) ${bar(r.done, r.total, 8)} ${r.done}/${r.total}` +
        (cur ? ` · ${cur.activeForm || cur.subject}` : r.done === r.total ? ` · ${t.statusDone}` : '');
    }
    status.tooltip = r?.total ? t.tip + '\n' + r.tasks.map((x) => `${{ completed: '✓', in_progress: '▶' }[x.status] || '○'} ${x.id}. ${x.subject}`).join('\n') : t.tip;
    if (signal || r?.total) status.show(); else status.hide();

    if (signal?.kind === 'waiting' && c.notifications && !notified.has(signal.sid + signal.t)) {
      notified.add(signal.sid + signal.t);
      vscode.window.showInformationMessage(t.notif(signal.message), t.openTerm)
        .then((choice) => choice && vscode.commands.executeCommand('workbench.action.terminal.focus'));
    }
  };

  // Click on a file: "before the step ↔ now" diff when Claude Code kept a backup, else the git diff, else the file.
  const BEFORE = 'cairn-before';
  const openFile = async (file, step) => {
    const right = vscode.Uri.file(file);
    const tr = current ? traceOf(current.sid) : null;
    const backup = tr?.files[step]?.has(file) ? backupBefore(tr, file, tr.start[step] ?? 0) : undefined;
    if (backup) {
      const left = vscode.Uri.from({ scheme: BEFORE, path: `/${current.sid}/${backup.name || 'empty'}/${path.basename(file)}` });
      return vscode.commands.executeCommand('vscode.diff', left, right, T[settings().lang].diffTitle(path.basename(file), step));
    }
    try { await vscode.commands.executeCommand('git.openChange', right); } catch { await vscode.commands.executeCommand('vscode.open', right); }
  };

  let timer, loop;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 150); };
  const watchers = {};
  const watch = () => {
    for (const dir of [path.join(CLAUDE_DIR, 'tasks'), path.join(CLAUDE_DIR, 'cairn', 'state')]) {
      if (watchers[dir]) continue;
      try {
        watchers[dir] = fs.watch(dir, { recursive: true }, schedule);
        watchers[dir].on('error', () => { watchers[dir].close(); delete watchers[dir]; });
      } catch { /* folder not created yet */ }
    }
  };
  // Transcripts and the "since … min" timer are re-read every 2 s in the foreground, every 15 s otherwise
  // (the task and state folders stay watched live).
  const plan = () => {
    clearTimeout(loop);
    const activeNow = vscode.window.state.focused && view?.visible;
    loop = setTimeout(() => { watch(); refresh(); plan(); }, activeNow ? 2000 : 15000);
  };
  watch();
  refresh();
  plan();

  context.subscriptions.push(
    status,
    vscode.workspace.registerTextDocumentContentProvider(BEFORE, {
      // Claude Code's backup, read-only: ~/.claude/file-history/<session>/<name>, names checked.
      provideTextDocumentContent(uri) {
        const [, sid, name] = uri.path.split('/');
        if (name === 'empty' || !/^[\w-]+$/.test(sid) || !/^[0-9a-f]+@v\d+$/.test(name)) return '';
        try { return fs.readFileSync(path.join(CLAUDE_DIR, 'file-history', sid, name), 'utf8'); } catch { return ''; }
      },
    }),
    vscode.window.registerWebviewViewProvider('cairn.roadmap', {
      resolveWebviewView(v) {
        view = v;
        ready = false;
        last = undefined;
        const fonts = vscode.Uri.joinPath(context.extensionUri, 'media', 'fonts');
        v.webview.options = { enableScripts: true, localResourceRoots: [fonts] };
        const url = (f) => v.webview.asWebviewUri(vscode.Uri.joinPath(fonts, f)).toString();
        v.webview.html = shell(crypto.randomBytes(16).toString('base64'), v.webview.cspSource, fontFaces(url), false, settings().lang);
        v.webview.onDidReceiveMessage((m) => {
          if (m?.type === 'ready') { ready = true; last = undefined; refresh(); }
          else if (m?.type === 'select' && sessions.some((s) => s.sid === m.sid)) { chosen = m.sid; refresh(); }
          else if (m?.type === 'open' && known.has(m.file)) openFile(m.file, String(m.step ?? ''));
        });
        v.onDidChangeVisibility(() => { schedule(); plan(); });
        v.onDidDispose(() => { view = undefined; ready = false; });
      },
    }),
    vscode.commands.registerCommand('cairn.open', () => vscode.commands.executeCommand('cairn.roadmap.focus')),
    vscode.commands.registerCommand('cairn.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'cairn')),
    vscode.commands.registerCommand('cairn.refresh', refresh),
    vscode.window.onDidChangeWindowState(() => { schedule(); plan(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(schedule),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('cairn') && schedule()),
    { dispose: () => { clearTimeout(loop); clearTimeout(timer); Object.values(watchers).forEach((w) => w.close()); } },
  );
}

module.exports = {
  activate, deactivate() {}, loadRoadmap, loadSessions, filesByStep, traceOf, emptyTrace, backupBefore, filesByCommand,
  readSignal, announcement, bar, render, renderApp, shell, fontFaces, CLAUDE_DIR,
};
