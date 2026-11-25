// Cairn: shows the roadmap Claude Code keeps in ~/.claude/tasks/<session>/<n>.json for the sessions started in the
// open folder: a live "sticker" sheet, files touched per step (before/after diff), "Claude is waiting for you",
// a history of past roadmaps, and progress in the status bar. The same functions serve the universal view (web/serve.js).
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

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
const histories = new Map();
// Past roadmaps kept by the hook (~/.claude/cairn/history/<session>.json), most recent first; `here` when the session
// ran in one of the open folders. Times are turned into milliseconds; dropped (deleted) steps are left out.
function loadHistory(folders = [], claudeDir = CLAUDE_DIR, max = 300) {
  const dir = path.join(claudeDir, 'cairn', 'history');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const f = path.join(dir, name);
    const m = mtimeOf(f);
    let c = histories.get(f);
    if (!c || c.m !== m) {
      let h;
      try { h = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      const sid = name.slice(0, -5);
      const cwd = h.cwd ? real(h.cwd) : '';
      const ms = (s) => (Number(s) ? Number(s) * 1000 : 0);
      const entries = (h.roadmaps || []).map((r, i) => {
        const steps = (r.steps || []).filter((s) => s.status !== 'deleted').map((s) => ({
          id: String(s.id), subject: String(s.subject || ''), status: s.status, created: ms(s.created),
          started: ms(s.started) || ms(s.created), ended: ms(s.ended), files: (s.files || []).filter((p) => typeof p === 'string'),
        }));
        return { id: `${sid}:${i}`, sid, cwd, start: ms(r.start), end: ms(r.end) || ms(r.start),
          steps, done: steps.filter((s) => s.status === 'completed').length, total: steps.length };
      }).filter((e) => e.total);
      c = { m, entries };
      histories.set(f, c);
    }
    out.push(...c.entries);
  }
  return out.sort((a, b) => b.end - a.end).slice(0, max).map((e) => ({ ...e, here: inFolders(e.cwd, folders) }));
}

// ---------- steering: the user's notes and edits on the roadmap; the hook passes them on to Claude ----------
// ~/.claude/cairn/steer/<session>.json = {"gate": "waiting" | "go" | null, "items": [{"id", "kind": "note" | "remove" |
// "add", "step", "subject", "text", "t", "sent"}]}. The hook marks an item sent once Claude has it.

const steerFile = (sid, claudeDir) => path.join(claudeDir, 'cairn', 'steer', `${sid}.json`);
function readSteer(sid, claudeDir = CLAUDE_DIR) {
  try {
    const s = JSON.parse(fs.readFileSync(steerFile(sid, claudeDir), 'utf8'));
    return s && typeof s === 'object' ? { ...s, items: Array.isArray(s.items) ? s.items.filter((i) => i && typeof i === 'object') : [] } : { items: [] };
  } catch { return { items: [] }; }
}

// One action from the view: note (on a step, or on the whole plan without a step), remove, add, cancel (an item not
// sent yet), go. Step titles come from the roadmap, never from the page. Returns true when something changed.
function steer(sid, action, tasks = [], claudeDir = CLAUDE_DIR) {
  if (!/^[\w-]+$/.test(String(sid)) || !action || typeof action !== 'object') return false;
  const s = readSteer(sid, claudeDir);
  const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);
  const task = action.step ? tasks.find((x) => String(x.id) === String(action.step)) : undefined;
  if (action.kind === 'go') {
    s.gate = 'go';
  } else if (action.kind === 'cancel') {
    const i = s.items.findIndex((x) => x.id === action.id && !x.sent);
    if (i < 0) return false;
    s.items.splice(i, 1);
  } else if (['note', 'remove', 'add'].includes(action.kind)) {
    const text = clean(action.text, 500);
    if (action.kind === 'remove' ? !task : !text) return false;
    if (action.kind === 'note' && action.step && !task) return false;
    if (s.items.filter((x) => !x.sent).length >= 10) return false; // ponytail: 10 waiting items, then send them first
    s.items.push({ id: crypto.randomBytes(4).toString('hex'), kind: action.kind, step: task ? String(task.id) : '',
      subject: task ? clean(task.subject, 200) : '', text: action.kind === 'remove' ? '' : text, t: Date.now() / 1000, sent: false });
    if (action.go) s.gate = 'go'; // "ask for another plan": the note goes with the go
  } else {
    return false;
  }
  s.items = s.items.slice(-50);
  const f = steerFile(sid, claudeDir);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f + '.tmp', JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
  return true;
}

// ---------- +/− per step ----------

// Lines added and removed between two versions of a text.
// ponytail: compares the lines as a multiset (a moved line counts for nothing); a real diff if exact numbers matter
function lineDiff(a, b) {
  const left = new Map();
  for (const l of a.split('\n')) left.set(l, (left.get(l) || 0) + 1);
  let add = 0;
  for (const l of b.split('\n')) {
    const n = left.get(l);
    if (n) left.set(l, n - 1); else add += 1;
  }
  let del = 0;
  for (const n of left.values()) del += n;
  return [add, del];
}
const readText = (f) => { try { return fs.statSync(f).size < 2e6 ? fs.readFileSync(f, 'utf8') : null; } catch { return null; } };
const diffs = new Map();

// +/− of each step of a roadmap: for each file Claude wrote during the step, from Claude Code's copy taken before the
// step to its copy taken before the next step (or the file as it is now). A step that wrote nothing: { add: 0, del: 0 }.
// No entry when Claude Code kept no copy.
function stepStats(sid, tasks, tr, claudeDir = CLAUDE_DIR) {
  const out = {};
  const starts = Object.values(tr.start).sort((a, b) => a - b);
  for (const task of tasks) {
    const start = tr.start[task.id];
    if (!start) continue;
    const files = tr.files[task.id];
    if (!files?.size) { out[task.id] = { add: 0, del: 0 }; continue; }
    const next = starts.find((x) => x > start) ?? Infinity;
    let add = 0, del = 0, known = false;
    for (const file of files) {
      const before = backupBefore(tr, file, start);
      if (!before) continue;
      const later = (tr.backups[key(file)] || []).filter((x) => x.t >= next - 1000).sort((a, b) => a.t - b.t)[0];
      const k = `${sid}|${file}|${before.name}|${later ? later.name : mtimeOf(file)}`;
      let d = diffs.get(k);
      if (!d) {
        const copy = (name) => (name ? readText(path.join(claudeDir, 'file-history', sid, name)) : '');
        const old = copy(before.name);
        const cur = later ? copy(later.name) : readText(file) ?? '';
        if (old === null || cur === null) continue;
        d = lineDiff(old, cur);
        diffs.set(k, d);
      }
      add += d[0];
      del += d[1];
      known = true;
    }
    if (known) out[task.id] = { add, del };
  }
  return out;
}

// ---------- rendering ----------

const T = {
  en: {
    locale: 'en-GB', steps: 'steps', cur: 'IN PROGRESS', after: 'after', foot: '→ on to the summit',
    summit: 'Summit reached ✓', doneAt: 'done at', count: (n) => `${n} steps`, full: 'the cairn is complete.',
    emptyT: 'Nothing to mark yet', emptyP: "Cairn shows Claude's plan as soon as a request has several steps.",
    wait: 'Claude is waiting for you', finished: 'Claude is done — your turn ✓', old: 'old roadmap',
    left: (n) => `${n} step(s) left`, openTerm: 'Open terminal',
    notif: (m) => `Claude is waiting for you${m ? ': ' + m : ''}`, tip: "Cairn — Claude's roadmap", statusDone: 'summit reached',
    since: (h, m) => `since ${h}${m ? ` · ${m} min` : ''}`, inProgress: (x, d, n) => `In progress: ${x} — ${d}/${n} steps done`,
    cmdFile: 'changed during the step (command or by hand)', diffTitle: (f, s) => `${f} · before step ${s} ↔ now`,
    ago: (ms, date) => { const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `on ${date}`; },
    now: 'Now', history: 'History', historyTitle: 'Cairn · History', search: 'Search steps, files…', searchLabel: 'Search the history',
    here: 'This project', all: 'All projects', today: 'today', yesterday: 'yesterday', periodToday: 'Today',
    days: (n) => `${n} days`, periodAll: 'All', running: 'in progress', stopped: 'stopped', copy: 'Copy as Markdown',
    copied: 'Copied ✓', allFiles: (n) => `All files · ${n}`, backHist: '← History', openTab: 'Open as a tab',
    histEmpty: 'No roadmap kept yet: they are saved here as Claude works.', kept: 'Kept on this machine only',
    week: (r, s, d) => `this week · ${r} roadmaps · ${s} steps · ${d}`, timePer: 'TIME PER STEP',
    stepOf: (i, n) => `Step ${i} of ${n}`, doneOf: (d, n) => `${d} of ${n} done`, eta: (d) => `~${d} to the summit`,
    onTrail: (i, n) => `Step ${i} of ${n} on the way to the summit`, atStart: (n) => `${n} steps to the summit`, youAreHere: 'you are here',
    stonesLeft: (n) => (n === 1 ? '→ 1 stone to the summit' : `→ ${n} stones to the summit`), noChange: 'no change',
    planT: (n) => `Claude has a plan · ${n} steps`, planP: 'Read it, change it if you want, leave a note on a step. Claude starts when you say go.',
    go: 'Let Claude go', rethink: 'Ask for another plan', approvedT: 'Approved · Claude has your go',
    approvedP: 'If Claude does not pick it up by itself, send it any message, or /cairn:go.', openTerminal: 'Open the terminal',
    noteFor: 'NOTE FOR CLAUDE', planNote: 'NOTE ON THE PLAN', sent: 'sent ✓', queued: 'at its next action', cancel: 'Cancel',
    send: 'Send', notePh: 'A note for Claude about this step…', addPh: 'A step to add…', planPh: 'What should change in this plan?',
    addStep: '+ Add a step', note: 'Note for Claude', remove: 'Remove this step', undo: 'Undo',
  },
  fr: {
    locale: 'fr-FR', steps: 'étapes', cur: 'EN COURS', after: 'après', foot: '→ arrivée au sommet',
    summit: 'Sommet atteint ✓', doneAt: 'fini à', count: (n) => `${n} étapes`, full: 'le cairn est complet.',
    emptyT: "Rien à baliser pour l'instant", emptyP: "Cairn affiche le plan de Claude dès qu'une demande compte plusieurs étapes.",
    wait: "Claude t'attend", finished: 'Claude a fini, à toi ✓', old: 'ancienne roadmap',
    left: (n) => `${n} étape(s) restante(s)`, openTerm: 'Ouvrir le terminal',
    notif: (m) => `Claude t'attend${m ? ' : ' + m : ''}`, tip: 'Cairn — roadmap de Claude', statusDone: 'sommet atteint',
    since: (h, m) => `depuis ${h}${m ? ` · ${m} min` : ''}`, inProgress: (x, d, n) => `En cours : ${x} — ${d}/${n} étapes faites`,
    cmdFile: "modifié pendant l'étape (commande ou à la main)", diffTitle: (f, s) => `${f} · avant l'étape ${s} ↔ maintenant`,
    ago: (ms, date) => { const m = Math.round(ms / 60000); return m < 1 ? "à l'instant" : m < 60 ? `il y a ${m} min` : m < 2880 ? `il y a ${Math.round(m / 60)} h` : `le ${date}`; },
    now: 'En cours', history: 'Historique', historyTitle: 'Cairn · Historique', search: 'Chercher une étape, un fichier…',
    searchLabel: "Chercher dans l'historique", here: 'Ce projet', all: 'Tous les projets', today: "aujourd'hui", yesterday: 'hier',
    periodToday: "Aujourd'hui", days: (n) => `${n} jours`, periodAll: 'Tout', running: 'en cours', stopped: 'arrêtée',
    copy: 'Copier en Markdown', copied: 'Copié ✓', allFiles: (n) => `Tous les fichiers · ${n}`, backHist: '← Historique',
    openTab: 'Ouvrir en onglet', histEmpty: "Aucune roadmap gardée pour l'instant : elles s'enregistrent ici au fil du travail de Claude.",
    kept: 'Gardé sur ce poste uniquement', week: (r, s, d) => `cette semaine · ${r} roadmaps · ${s} étapes · ${d}`, timePer: 'TEMPS PAR ÉTAPE',
    stepOf: (i, n) => `Étape ${i} sur ${n}`, doneOf: (d, n) => `${d} sur ${n} faites`, eta: (d) => `~${d} avant le sommet`,
    onTrail: (i, n) => `Étape ${i} sur ${n} sur la route du sommet`, atStart: (n) => `${n} étapes jusqu'au sommet`, youAreHere: 'tu es ici',
    stonesLeft: (n) => (n === 1 ? '→ 1 pierre avant le sommet' : `→ ${n} pierres avant le sommet`), noChange: 'aucun changement',
    planT: (n) => `Claude a un plan · ${n} étapes`, planP: 'Lis-le, change-le si tu veux, laisse une note sur une étape. Claude démarre quand tu dis go.',
    go: 'Go, Claude', rethink: 'Demander un autre plan', approvedT: 'Validé · Claude a ton go',
    approvedP: "S'il ne repart pas tout seul, envoie-lui n'importe quel message, ou /cairn:go.", openTerminal: 'Ouvrir le terminal',
    noteFor: 'NOTE POUR CLAUDE', planNote: 'NOTE SUR LE PLAN', sent: 'envoyée ✓', queued: 'à sa prochaine action', cancel: 'Annuler',
    send: 'Envoyer', notePh: 'Une note pour Claude sur cette étape…', addPh: 'Une étape à ajouter…', planPh: 'Que faut-il changer dans ce plan ?',
    addStep: '+ Ajouter une étape', note: 'Note pour Claude', remove: 'Retirer cette étape', undo: 'Annuler',
  },
};

const bar = (done, total, width = 10) => {
  const n = total ? Math.round((done / total) * width) : 0;
  return '▰'.repeat(n) + '▱'.repeat(width - n);
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 864e5;
const duration = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };
const clock = (t) => ({
  hour: (ms) => (ms ? new Date(ms).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' }) : ''),
  date: (ms) => new Date(ms).toLocaleDateString(t.locale, { day: 'numeric', month: 'short' }),
});
const stepTime = (s) => (s.ended && s.ended >= s.started ? s.ended - s.started : 0);

// Rough time left: the median duration of past steps (history) times the steps left, half for the one in progress.
// Nothing until the history holds a few timed steps.
function timeLeft(r, history = []) {
  const times = history.flatMap((e) => e.steps.map(stepTime)).filter((ms) => ms > 0 && ms < 3 * 3600e3).sort((a, b) => a - b);
  if (times.length < 5 || !r?.total) return 0;
  const left = r.tasks.filter((x) => x.status === 'pending').length + (r.tasks.some((x) => x.status === 'in_progress') ? 0.5 : 0);
  return times[Math.floor(times.length / 2)] * left;
}

// The trail (7b): one stone per step on a winding path up to the summit; walked stones filled, the current one ringed.
function trail(tasks, t) {
  const n = tasks.length;
  const gap = n > 1 ? 224 / (n - 1) : 0;
  const r = Math.max(3.5, Math.min(7.5, gap ? gap / 3 : 7.5));
  const pts = tasks.map((_, i) => [Math.round((14 + i * gap) * 10) / 10, 40 + Math.round(7 * Math.sin(i * 1.3 + 0.4))]);
  const cur = tasks.findIndex((x) => x.status === 'in_progress');
  const complete = n > 0 && tasks.every((x) => x.status === 'completed');
  const reach = cur >= 0 ? cur : tasks.reduce((m, x, i) => (x.status === 'completed' ? i : m), -1);
  const line = (list) => list.map(([x, y]) => `${x},${y}`).join(' ');
  const base = [254, 52];
  const walked = complete ? line([...pts, base]) : reach > 0 ? line(pts.slice(0, reach + 1)) : '';
  const ahead = complete ? '' : line([...pts.slice(Math.max(reach, 0)), base]);
  const stones = pts.map(([x, y], i) => {
    const s = tasks[i].status;
    if (s === 'completed') return `<circle class="done" cx="${x}" cy="${y}" r="${r}"/>${r >= 6 ? `<path class="tk" d="M${x - 3.5} ${y}l2.2 2.2 4-4.4"/>` : ''}`;
    if (s === 'in_progress') return `<circle class="ring" cx="${x}" cy="${y}" r="${r + 4.5}"/><circle class="cur" cx="${x}" cy="${y}" r="${r + 0.5}"/>`;
    return `<circle class="todo" cx="${x}" cy="${y}" r="${Math.max(3, r - 1.5)}"/>`;
  }).join('');
  const here = cur >= 0 ? (() => {
    const [x] = pts[cur];
    const anchor = x < 40 ? 'start' : x > 230 ? 'end' : 'middle';
    return `<text class="here" x="${anchor === 'start' ? Math.max(2, x - 8) : x}" y="66" text-anchor="${anchor}">${esc(t.youAreHere)}</text>`;
  })() : '';
  const label = complete ? t.summit : cur >= 0 ? t.onTrail(cur + 1, n) : t.atStart(n);
  return `<svg xmlns="http://www.w3.org/2000/svg" class="trail-map" viewBox="0 0 286 70" role="img" aria-label="${esc(label)}" data-k="trail">`
    + (walked ? `<polyline class="walked" points="${walked}"/>` : '') + (ahead ? `<polyline class="ahead" points="${ahead}"/>` : '')
    + `<polygon class="peak${complete ? ' won' : ''}" points="252,58 268,28 284,58"/><line class="pole" x1="268" y1="28" x2="268" y2="10"/>`
    + `<polygon class="flag" points="268,10 280,13.5 268,17"/>${stones}${here}</svg>`;
}

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

// A past roadmap as Markdown (pull request description, stand-up note…).
function toMarkdown(e, lang = 'en') {
  const t = T[lang] || T.en;
  const { hour, date } = clock(t);
  const lines = [`### ${e.steps[0]?.subject ?? ''}`, `${date(e.start)} · ${hour(e.start)} → ${hour(e.end)} · ${duration(e.end - e.start)} · ${e.done}/${e.total} ${t.steps}`, ''];
  for (const s of e.steps) {
    const files = s.files.map((f) => '`' + path.basename(f) + '`').join(', ');
    lines.push(`- [${s.status === 'completed' ? 'x' : ' '}] ${s.subject}${stepTime(s) ? ` — ${duration(stepTime(s))}` : ''}${files ? ` · ${files}` : ''}`);
  }
  return lines.join('\n');
}

// Small S1 logo, full letter stack (summit), S4 stamp (empty state), tick.
const MINI = '<span class="mini" aria-hidden="true" data-k="mini"><i class="p4"></i><i class="p3"></i><i class="p2"></i><i class="p1"></i></span>';
const STACK = '<div class="stack" aria-hidden="true" data-k="stack"><b class="l-c">c</b><b class="l-a">a</b><b class="l-i">i</b><b class="l-r">r</b><b class="l-n">n</b></div>';
const STAMP = `<div class="stamp" aria-hidden="true" data-k="stamp"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220"><defs><path id="ring" d="M110,110 m-86,0 a86,86 0 1,1 172,0 a86,86 0 1,1 -172,0"/></defs>
<text><textPath href="#ring" textLength="536" lengthAdjust="spacing">CAIRN · CLAUDE CODE'S PLAN · STONE BY STONE ·</textPath></text></svg>
<div class="core"><i class="p4"></i><i class="p3"></i><i class="p2"></i><i class="p1"></i></div></div>`;
const TICK = '<svg xmlns="http://www.w3.org/2000/svg" class="tick" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5l2.3 2.3L9.5 3.8"/></svg>';
const SEARCH = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.8"/><path d="M10.6 10.6L14 14"/></svg>';
const NOTE_IC = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z"/></svg>';
const X_IC = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';

const CSS = `
:root{--paper:#FFFDF8;--outline:#121212;--shadow:#121212;--ink:#121212;--text:#1F1F1F;--muted:#6B675F;--soft:#8A857B;
--hollow:#8A857B;--chip:#C9C4BA;--line:#E7E3DA;--hover:rgba(18,18,18,.05);--accent:#2B3BFF;--accent-text:#2B3BFF;--pop:#FF7AD9;
--card-border:#121212;--card-shadow:#121212;--card-muted:#DADFFF;--box-fg:#FFFDF8;--add:#1A7F37;--del:#CF222E;
--tab-on:#121212;--tab-on-text:#FFFDF8;--sticker-border:#121212;--note-bg:#FFFFFF;
--brand:'Bricolage Grotesque',system-ui,-apple-system,'Segoe UI',sans-serif;
--ui:var(--vscode-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif);
--mono:'JetBrains Mono',var(--vscode-editor-font-family,ui-monospace),Menlo,monospace}
body.vscode-dark,body.vscode-high-contrast{--paper:#1C1C21;--outline:#2E2E36;--shadow:#000;--ink:#E7E3DB;--text:#E7E3DB;
--muted:#9B968D;--soft:#7E7A72;--hollow:#6E6A63;--chip:#3A3A42;--line:#2A2A31;--hover:rgba(255,255,255,.05);--accent:#3F4CF0;
--accent-text:#9AA4FF;--card-border:var(--accent);--card-shadow:#000;--card-muted:#DCE0FF;--box-fg:#1C1C21;--add:#3FB950;
--del:#F85149;--tab-on:#2F2F37;--tab-on-text:#F0ECE4;--sticker-border:var(--pop);--note-bg:#24242B}
*{box-sizing:border-box}
body{margin:0;padding:8px 14px 18px 8px;font-family:var(--ui);font-size:13px;color:var(--text)}
#app{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
button,input,textarea{font:inherit;color:inherit}button{cursor:pointer}
button:focus-visible,summary:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent-text);outline-offset:2px}
[hidden]{display:none!important}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.sheet{padding:14px;background:var(--paper);border:1.5px solid var(--outline);border-radius:16px;
box-shadow:4px 4px 0 var(--shadow);display:flex;flex-direction:column;gap:14px}
.now{display:flex;flex-direction:column;gap:14px;transition:opacity .4s,filter .4s}
.now.stale{opacity:.72;filter:saturate(.35)}
.top{display:flex;align-items:center;gap:8px}
.word{font-family:var(--brand);font-weight:800;font-size:18px;letter-spacing:-.04em}
.mini,.core{display:flex;flex-direction:column;align-items:center;gap:1.5px}
.mini i{display:block;height:3.5px;border-radius:99px}.mini .p4{width:7px;border:1px dashed var(--hollow)}
.mini .p3{width:10px;background:var(--accent)}.mini .p2{width:13px;background:var(--pop)}.mini .p1{width:16px;background:var(--ink);height:4px}
.chip{font-family:var(--mono);font-size:10.5px;padding:0 8px;border:1px solid var(--chip);border-radius:99px;white-space:nowrap;color:var(--muted)}
.proj{margin-left:auto;max-width:55%;overflow:hidden;text-overflow:ellipsis}
.oldchip{align-self:flex-start;border-style:dashed}
.tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));padding:2px;border:1px solid var(--chip);border-radius:9px}
.tabs button{padding:5px 0;border:0;border-radius:7px;background:transparent;font-size:12.5px;color:var(--muted)}
.tabs button[aria-pressed=true]{background:var(--tab-on);color:var(--tab-on-text);font-weight:600}
.hero{display:flex;flex-direction:column;gap:4px}
.trail-map{width:100%;max-width:380px;height:auto;display:block;overflow:visible}
.trail-map .walked{fill:none;stroke:var(--ink);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.trail-map .ahead{fill:none;stroke:var(--hollow);stroke-width:2;stroke-dasharray:4 4;stroke-linecap:round}
.trail-map .done{fill:var(--ink)}
.trail-map .tk{fill:none;stroke:var(--box-fg);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.trail-map .ring{fill:none;stroke:var(--pop);stroke-width:2.5}.trail-map .cur{fill:var(--accent)}
.trail-map .todo{fill:var(--paper);stroke:var(--hollow);stroke-width:1.5;stroke-dasharray:2.5 2}
.trail-map .peak{fill:var(--paper);stroke:var(--ink);stroke-width:2;stroke-linejoin:round}.trail-map .peak.won{fill:var(--pop)}
.trail-map .pole{stroke:var(--ink);stroke-width:1.5}.trail-map .flag{fill:var(--pop)}
.trail-map .here{font-family:var(--mono);font-size:9px;fill:var(--muted)}
.where{display:flex;align-items:baseline;gap:8px}
.where b{font-family:var(--brand);font-weight:800;font-size:19px;letter-spacing:-.03em}
.where span{margin-left:auto;font-size:12px;color:var(--muted);text-align:right}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.row{display:flex;align-items:flex-start;gap:9px;padding:2px 0}
summary.row{cursor:pointer;list-style:none}summary.row::-webkit-details-marker{display:none}
.st-ic{width:16px;height:16px;flex:none;margin-top:1px;border-radius:99px;display:flex;align-items:center;justify-content:center;
font-family:var(--mono);font-size:9px;color:var(--muted);overflow:hidden}
.done .st-ic{background:var(--ink)}
.todo .st-ic{border:1.5px dashed var(--hollow)}
.tick{width:9px;height:9px;fill:none;stroke:var(--box-fg);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.t{flex:1;min-width:0;line-height:1.4;overflow-wrap:anywhere}
.done .t{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.drow[open] .t{-webkit-line-clamp:unset}
.delta,.row time,.after{font-family:var(--mono);font-size:10.5px;color:var(--muted);white-space:nowrap;padding-top:2px}
.add{color:var(--add)}.del{color:var(--del)}
.more{margin:2px 0 4px 25px;display:flex;flex-direction:column;gap:6px}
.more p{margin:0;font-size:12px;color:var(--muted);white-space:pre-wrap}
.files{display:flex;flex-wrap:wrap;gap:4px}
.files button{font-family:var(--mono);font-size:10px;padding:0 7px;border:1px solid var(--chip);border-radius:99px;
background:transparent;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.files button.cmd{border-style:dashed}
.files button:hover,.files button.copied{background:var(--pop);color:#121212;border-color:var(--pop)}
.files span{font-family:var(--mono);font-size:10px;color:var(--muted)}
.acts{display:flex;gap:2px;opacity:0;transition:opacity .15s}
.todo:hover .acts,.todo:focus-within .acts,.gate .acts,.gone .acts,.added .acts{opacity:1}
.ic{width:24px;height:24px;flex:none;padding:0;border:0;border-radius:6px;background:transparent;display:flex;align-items:center;
justify-content:center;color:var(--muted)}
.ic:hover{background:var(--hover);color:var(--text)}
.ic svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.gone .t{text-decoration:line-through;color:var(--soft)}
.added .st-ic{border-style:solid;border-color:var(--accent-text);color:var(--accent-text);font-size:12px}
.added .t{color:var(--accent-text)}
.link{padding:0 4px;border:0;background:none;font-size:11.5px;color:var(--accent-text)}
.cur{margin:4px 0}
.card{padding:12px 13px;border:1.5px solid var(--card-border);border-radius:14px;background:var(--accent);color:#fff;
box-shadow:3px 3px 0 var(--card-shadow);transform:rotate(-1.5deg);display:flex;flex-direction:column;gap:6px}
.cardtop{display:flex;align-items:center;gap:8px}.cardtop time{margin-left:auto;font-family:var(--mono);font-size:10.5px;color:var(--card-muted)}
.tag{font-family:var(--mono);font-size:9.5px;font-weight:700;letter-spacing:.04em;padding:1px 7px;border-radius:99px;
background:var(--pop);color:#121212}
.ct{font-family:var(--brand);font-size:17px;font-weight:800;line-height:1.15;letter-spacing:-.02em;overflow-wrap:anywhere}
.af{font-size:12px;color:var(--card-muted)}
.cardfoot{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.card .files button{border-color:rgba(255,255,255,.65);color:#fff}
.card .delta{margin-left:auto;color:var(--card-muted);padding:0}.card .add,.card .del{color:inherit}
.cardfoot .files,.cardfoot span[data-k=fc]{flex:1}.card .ic{color:#fff;width:22px;height:22px}.card .ic:hover{background:rgba(255,255,255,.18)}
.note{margin:4px 0 4px 25px;padding:7px 10px;border:1.5px solid var(--accent-text);border-radius:10px;background:var(--note-bg);
display:flex;flex-direction:column;gap:2px;font-size:12.5px;line-height:1.4;overflow-wrap:anywhere}
.note.plan{margin-left:0}.note.sent{border-style:dashed;opacity:.8}
.note small{display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:9.5px;font-weight:700;letter-spacing:.04em;color:var(--accent-text)}
.note small .link{margin-left:auto;font-family:var(--ui);font-weight:400;letter-spacing:0}
.composer{margin:4px 0 4px 25px;display:flex;flex-direction:column;gap:6px}.composer.plan,.composer.add{margin-left:0}
.composer textarea{width:100%;min-height:54px;resize:vertical;padding:7px 9px;border:1.5px solid var(--accent-text);border-radius:10px;
background:var(--note-bg);font-size:12.5px;line-height:1.4}
.composer div{display:flex;gap:8px;justify-content:flex-end}
.addrow{width:100%;padding:6px 10px;border:1.5px dashed var(--chip);border-radius:10px;background:transparent;text-align:left;
font-size:12.5px;color:var(--muted)}
.addrow:hover{color:var(--text);border-color:var(--hollow)}
.btn{display:block;padding:8px 12px;border:1.5px solid var(--outline);border-radius:12px;background:transparent;font-weight:600;
font-size:12.5px;text-align:center}
.btn.primary{background:var(--accent);color:#fff;border-color:var(--card-border);box-shadow:3px 3px 0 var(--card-shadow);
font-family:var(--brand);font-weight:800;font-size:15px}
.btn.small{padding:4px 12px;font-size:12px;box-shadow:none;font-family:var(--ui);font-weight:600}
.btn.copied{background:var(--pop);color:#121212;border-color:var(--pop)}
.gobar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.sticker{align-self:flex-start;display:flex;align-items:center;gap:8px;padding:6px 11px;border:1.5px solid var(--sticker-border);
border-radius:12px;background:var(--pop);color:#121212;box-shadow:3px 3px 0 var(--card-shadow);transform:rotate(-1.5deg);
font-size:12.5px;font-weight:700}
.sticker::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:#121212}
.sticker small{display:block;font-family:var(--mono);font-weight:500;font-size:10.5px}
.sticker.blink::before{animation:blink 1s steps(2) infinite}
.sticker.ok{background:var(--accent);color:#fff;border-color:var(--card-border)}.sticker.ok::before{background:#fff}
.lead{margin:0;font-size:12.5px;line-height:1.45;color:var(--muted)}
.foot{font-family:var(--mono);font-size:11px;color:var(--muted)}
.summit{align-self:flex-start;padding:3px 14px;background:var(--pop);color:#121212;border:1.5px solid var(--sticker-border);
border-radius:99px;box-shadow:3px 3px 0 var(--card-shadow);transform:rotate(-3deg);font-family:var(--brand);font-weight:800;
font-size:18px;letter-spacing:-.02em}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chips .fin{background:var(--accent);color:#fff;border-color:var(--accent)}
.stack{display:flex;flex-direction:column;align-items:center;gap:3px;padding-top:4px}
.stack b{display:block;border:1.5px solid var(--outline);border-radius:99px;font-family:var(--brand);font-weight:800;line-height:1.1}
.l-c{padding:0 8px;font-size:13px;background:var(--pop);color:#121212;transform:rotate(-6deg)}
.l-a{padding:0 10px;font-size:16px;background:var(--accent);color:#fff;transform:rotate(4deg)}
.l-i{padding:0 15px;font-size:18px;background:var(--paper);transform:rotate(-3deg)}
.l-r{padding:0 20px;font-size:21px;background:var(--pop);color:#121212;transform:rotate(5deg)}
.l-n{padding:0 26px;font-size:25px;background:var(--ink);color:var(--paper);transform:rotate(-2deg)}
.empty{display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;padding:14px 0 6px}
.empty h2{margin:6px 0 0;font-family:var(--brand);font-size:18px;font-weight:800;letter-spacing:-.03em}.empty p{margin:0;font-size:12px;color:var(--muted)}
.stamp{position:relative;width:170px;height:170px;border-radius:50%;background:var(--pop);border:1.5px solid var(--sticker-border);
box-shadow:4px 4px 0 var(--card-shadow);transform:rotate(-10deg);display:flex;align-items:center;justify-content:center}
.stamp svg{position:absolute;inset:0;width:100%;height:100%}
.stamp text{font-family:var(--mono);font-size:12.5px;font-weight:700;fill:#121212}
.core{width:94px;height:94px;border-radius:50%;background:#FFFDF8;border:2px solid #121212;justify-content:center;gap:3px}
.core i{display:block;height:10px;border:2px solid #121212;border-radius:99px}.core .p4{width:18px;border-style:dashed}
.core .p3{width:29px;background:var(--accent)}.core .p2{width:41px;background:var(--pop)}.core .p1{width:54px;background:#121212}
.pills{display:flex;gap:6px;flex-wrap:wrap}
.pill{font-family:var(--mono);font-size:10.5px;font-weight:600;padding:2px 10px;border:1px solid var(--chip);border-radius:99px;
background:transparent;color:var(--muted)}
.pill.on,.pill[aria-pressed=true]{background:var(--tab-on);color:var(--tab-on-text);border-color:var(--tab-on)}
.hlist{display:flex;flex-direction:column;gap:10px;min-width:0}
.hsearch{display:flex;align-items:center;gap:8px;padding:0 10px;height:32px;border:1px solid var(--chip);border-radius:8px}
.hsearch svg{width:13px;height:13px;flex:none;fill:none;stroke:var(--muted);stroke-width:2;stroke-linecap:round}
.hsearch input{flex:1;min-width:0;border:0;outline:none;background:transparent;font-size:12px}
.filters{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.filters .pill:last-child:not([data-scope]):not([data-period]){margin-left:auto}
.day{display:flex;flex-direction:column;gap:6px}
.day h3{margin:6px 0 0;font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.hcard{width:100%;text-align:left;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:transparent;
display:flex;flex-direction:column;gap:4px;transition:background-color .15s}
.hcard:hover{background:var(--hover)}.hcard[aria-current=true]{border-color:var(--accent-text);background:var(--hover)}
.hcard.stop{border-style:dashed}
.hcard b{font-size:13px;font-weight:600;line-height:1.3;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden}
.hsteps{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hmeta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-family:var(--mono);font-size:10.5px;color:var(--muted)}
.st{padding:0 6px;border:1px solid var(--chip);border-radius:99px;font-weight:600;white-space:nowrap;color:var(--text)}
.st.ok{background:var(--pop);color:#121212;border-color:var(--pop)}.st.run{background:var(--accent);color:#fff;border-color:var(--accent)}
.st.stop{border-style:dashed}
.pj{display:none}#app[data-scope=all] .pj{display:inline}
.hdetail{display:flex;flex-direction:column;gap:12px;min-width:0}
.hdetail h2{margin:0;font-family:var(--brand);font-size:19px;font-weight:800;line-height:1.15;letter-spacing:-.02em;overflow-wrap:anywhere}
.hback{align-self:flex-start}
.trail{list-style:none;margin:2px 0 0;padding:0;display:flex;flex-direction:column}
.trail li{display:flex;gap:11px}
.rail{width:16px;flex:none;display:flex;flex-direction:column;align-items:center}
.stone{width:16px;height:16px;flex:none;border-radius:99px;background:var(--ink);display:flex;align-items:center;justify-content:center;
font-family:var(--mono);font-size:9px;color:var(--muted)}
.trail .todo .stone{background:transparent;border:1.5px dashed var(--hollow)}
.line{width:1.5px;flex:1;background:var(--ink)}.trail li:last-child .line{display:none}
.trail .todo .line{width:0;background:none;border-left:1.5px dashed var(--hollow);margin-top:3px}
.body{flex:1;min-width:0;padding:0 0 11px;display:flex;flex-direction:column;gap:2px}
.body b{font-weight:500;line-height:1.35;overflow-wrap:anywhere}
.meta{font-family:var(--mono);font-size:10.5px;color:var(--muted);overflow-wrap:anywhere}
.meta button{font-size:inherit;font-family:inherit;color:var(--accent-text);background:none;border:0;padding:0}
.hactions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.hactions .btn{width:100%}
.allfiles[open]{grid-column:1/-1}.allfiles .files{margin:8px 0 0}
.timebar{display:none}
.wide{display:flex;flex-direction:column;gap:18px}
.whead{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}
.whead h1{margin:0;font-family:var(--brand);font-size:34px;font-weight:800;letter-spacing:-.04em;line-height:1}
.whead .filters{margin-left:auto}
.cols{display:flex;gap:28px;align-items:flex-start}
.cols .hlist{width:380px;flex:none}
.cols .hdetail{flex:1;padding:22px 24px;background:var(--paper);border:1.5px solid var(--outline);border-radius:16px;
box-shadow:4px 4px 0 var(--shadow);gap:16px}
.cols .hdetail h2{font-size:26px}.cols .hback{display:none}
.cols .trail{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:28px}.cols .line{display:none}
.cols .hactions{display:flex;flex-wrap:wrap}.cols .hactions .btn{width:auto}.cols .allfiles[open]{flex-basis:100%}
.cols .timebar{display:flex;flex-direction:column;gap:6px}
.timebar span{font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--muted)}
.timebar div{display:flex;gap:4px;height:24px}
.timebar i{border-radius:6px;background:var(--ink);color:var(--box-fg);font-style:normal;font-family:var(--mono);font-size:10.5px;
font-weight:700;display:flex;align-items:center;justify-content:center;overflow:hidden;min-width:16px}
.timebar i.long{background:var(--accent);color:#fff}
@media (max-width:760px){.cols{flex-direction:column}.cols .hlist{width:100%}.cols .trail{grid-template-columns:1fr}}
@keyframes pop{from{opacity:0;transform:rotate(-6deg) scale(.85)}}
@keyframes stamp{from{opacity:0;transform:rotate(-14deg) scale(1.6)}}
@keyframes slide{from{opacity:0;transform:translateX(-8px)}}
@keyframes blink{50%{opacity:.15}}
.card.in,.sticker.in{animation:pop .45s cubic-bezier(.2,1.5,.4,1)}
.summit.in{animation:stamp .5s cubic-bezier(.2,1.6,.4,1)}
.row.in,.files.in,.now.in,.note.in{animation:slide .35s ease-out}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;

// History: one card per roadmap, grouped by day (5a), and one roadmap opened (5b; in a wide editor tab, 5c).
function renderHistory(o, t, wide) {
  const { hour } = clock(t);
  const now = o.now ?? Date.now();
  const entries = o.history || [];
  const staleMs = (o.staleHours ?? 2) * 3600e3;
  const state = (e) => (e.done === e.total ? ['ok', `${e.done}/${e.total} ✓`] : now - e.end < staleMs
    ? ['run', `${t.running} · ${e.done}/${e.total}`] : ['stop', `${t.stopped} · ${e.done}/${e.total}`]);
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const dayOf = (ms) => (ms >= midnight ? t.today : ms >= midnight - DAY ? t.yesterday
    : new Date(ms).toLocaleDateString(t.locale, { weekday: 'short', day: 'numeric', month: 'short' }));
  const pick = entries.find((e) => e.id === o.pick);
  const fileButton = (p) => `<button data-open="${esc(p)}" data-step="" title="${esc(p)}">${esc(path.basename(p))}</button>`;

  const scope = `<button class="pill" data-scope="here">${esc(t.here)}</button><button class="pill" data-scope="all">${esc(t.all)}</button>`;
  const periods = [[1, t.periodToday], [7, t.days(7)], [30, t.days(30)], [0, t.periodAll]]
    .map(([n, label]) => `<button class="pill" data-period="${n}">${esc(label)}</button>`).join('');
  const groups = [];
  for (const e of entries) {
    const [cls, chip] = state(e);
    const text = [...e.steps.map((s) => s.subject), ...e.steps.flatMap((s) => s.files.map((f) => path.basename(f)))].join(' ').toLowerCase();
    const card = `<button class="hcard ${cls}" data-k="h-${esc(e.id)}" data-pick="${esc(e.id)}" data-here="${e.here ? 1 : 0}" data-t="${e.end}" data-text="${esc(text)}"${e === pick ? ' aria-current="true"' : ''}>
<b>${esc(e.steps[0].subject)}</b>${e.total > 1 ? `<span class="hsteps">${esc(e.steps.slice(1).map((x) => x.subject).join(' · '))}</span>` : ''}<span class="hmeta"><span class="st ${cls}">${esc(chip)}</span><span>${hour(e.start)} → ${hour(e.end)} · ${duration(e.end - e.start)}</span><span class="pj">· ${esc(path.basename(e.cwd))}</span></span></button>`;
    const day = dayOf(e.end);
    if (groups.at(-1)?.day !== day) groups.push({ day, cards: [] });
    groups.at(-1).cards.push(card);
  }
  const list = `<div class="hlist" data-k="hlist"><label class="hsearch" data-k="search">${SEARCH}<span class="sr">${esc(t.searchLabel)}</span><input type="search" data-filter="q" placeholder="${esc(t.search)}"></label>
${wide ? '' : `<div class="filters" data-k="scope">${scope}${o.canTab ? `<button class="pill" data-opentab="1">${esc(t.openTab)}</button>` : ''}</div>`}
${groups.map((g) => `<div class="day" data-k="d-${esc(g.day)}"><h3 data-k="dh">${esc(g.day)}</h3>${g.cards.join('')}</div>`).join('') || `<p class="foot" data-k="none">${esc(t.histEmpty)}</p>`}
<span class="foot" data-k="kept">${esc(t.kept)}</span></div>`;

  let detail = '';
  if (pick) {
    const [cls, chip] = state(pick);
    const longest = Math.max(0, ...pick.steps.map(stepTime));
    const timed = pick.steps.filter(stepTime);
    const timebar = timed.length ? `<div class="timebar" data-k="tb" aria-hidden="true"><span>${esc(t.timePer)}</span><div>${pick.steps.map((s, i) => (stepTime(s)
      ? `<i class="${stepTime(s) === longest ? 'long' : ''}" style="flex:${Math.max(1, Math.round(stepTime(s) / 60000))} 1 0">${i + 1}</i>` : '')).join('')}</div></div>` : '';
    const steps = pick.steps.map((s, i) => {
      const done = s.status === 'completed';
      const meta = [stepTime(s) ? duration(stepTime(s)) : '', ...s.files.map(fileButton)].filter(Boolean).join(' · ');
      return `<li class="${done ? 'done' : 'todo'}" data-k="hs-${esc(s.id)}"><span class="rail"><span class="stone">${done ? TICK : i + 1}</span><span class="line"></span></span>
<span class="body"><b>${esc(s.subject)}</b>${meta ? `<span class="meta">${meta}</span>` : ''}</span></li>`;
    }).join('');
    const files = [...new Set(pick.steps.flatMap((s) => s.files))];
    detail = `<section class="hdetail" data-k="hd-${esc(pick.id)}"><button class="pill hback" data-k="back" data-pick="">${esc(t.backHist)}</button>
<h2 data-k="t">${esc(pick.steps[0].subject)}</h2><div class="chips" data-k="chips"><span class="chip st ${cls}">${esc(chip)}</span><span class="chip">${esc(dayOf(pick.end))} · ${hour(pick.start)} → ${hour(pick.end)}</span><span class="chip">${duration(pick.end - pick.start)}</span>${pick.here ? '' : `<span class="chip">${esc(path.basename(pick.cwd))}</span>`}</div>
${timebar}<ol class="trail" data-k="trail">${steps}</ol>
<div class="hactions" data-k="act"><button class="btn primary" data-copy="${esc(toMarkdown(pick, o.lang))}">${esc(t.copy)}</button>${files.length ? `<details class="allfiles"><summary class="btn">${esc(t.allFiles(files.length))}</summary><div class="files">${files.map(fileButton).join('')}</div></details>` : ''}</div></section>`;
  }

  if (!wide) return pick ? detail : list;
  const week = entries.filter((e) => now - e.end < 7 * DAY);
  const summary = t.week(week.length, week.reduce((n, e) => n + e.done, 0), duration(week.reduce((n, e) => n + e.end - e.start, 0)));
  return `<div class="wide" data-k="wide"><header class="whead" data-k="whead"><div><h1>${esc(t.history)}</h1><span class="foot">${esc(summary)}</span></div>
<div class="filters">${scope}</div><div class="filters">${periods}</div></header><div class="cols" data-k="cols">${list}${detail}</div></div>`;
}

// View content (elements tagged data-k: the page only replaces what changed, and animates what arrives; inside an
// element, either every child has a key or none does).
// o.layout "tab": the history alone, wide (editor tab). Otherwise the panel: Now / History tabs (o.tab).
function renderApp(r, o = {}) {
  const t = T[o.lang] || T.en;
  if (o.layout === 'tab') return renderHistory(o, t, true);
  const { hour, date } = clock(t);
  const now = o.now ?? Date.now();
  const tab = o.tab === 'history' ? 'history' : 'now';
  const files = o.files || {};
  const cmdFiles = o.cmdFiles || {};
  const stats = o.stats || {};
  const sv = o.steer || { items: [] };
  const parts = [];

  if (tab === 'now' && o.pills?.length > 1) {
    parts.push(`<nav class="pills" data-k="pills">${o.pills.map((s) => `<button class="pill${s.sid === r?.sid ? ' on' : ''}" data-k="p-${esc(s.sid)}" data-sid="${esc(s.sid)}">${hour(s.mtime)} · ${s.done}/${s.total}</button>`).join('')}</nav>`);
  }
  if (o.signal) {
    const s = o.signal;
    parts.push(s.kind === 'waiting'
      ? `<div class="sticker blink" data-k="sig-w"><span>${esc(t.wait)}${s.message ? `<small>${esc(s.message)}</small>` : ''}</span></div>`
      : `<div class="sticker ok" data-k="sig-d"><span>${esc(t.finished)}</span></div>`);
  }

  let body;
  if (tab === 'history') {
    body = renderHistory(o, t, false);
  } else if (!r?.total) {
    body = `<div class="empty" data-k="empty">${STAMP}<h2 data-k="h">${esc(t.emptyT)}</h2><p data-k="p">${esc(t.emptyP)}</p></div>`;
  } else {
    const { tasks, done, total } = r;
    const complete = done === total;
    const stale = r.mtime && now - r.mtime > (o.staleHours ?? 2) * 3600e3;
    const review = sv.gate === 'waiting' || sv.gate === 'held'; // the plan waits for the user's go
    const open = sv.items.filter((i) => !i.sent);
    const cur = tasks.find((x) => x.status === 'in_progress');
    const pos = new Map(tasks.map((x, i) => [String(x.id), i + 1]));
    const fileChips = (id, inCard) => {
      const direct = [...(files[id] || [])].map((p) => [p, '']);
      const others = [...(cmdFiles[id] || [])].map((p) => [p, 'cmd']);
      const shown = [...direct.slice(-4), ...others].slice(0, 4);
      const count = direct.length + others.length;
      if (!count) return '';
      const chips = shown.map(([p, cls]) => `<button${cls ? ` class="${cls}"` : ''} data-open="${esc(p)}" data-step="${esc(id)}" title="${esc(p)}${cls ? ' · ' + esc(t.cmdFile) : ''}">${esc(path.basename(p))}</button>`).join('');
      return `<div class="files" data-k="f${inCard ? 'c' : ''}">${chips}${count > 4 ? `<span>+${count - 4}</span>` : ''}</div>`;
    };
    const delta = (id) => {
      const d = stats[id];
      if (!d) return '';
      if (!d.add && !d.del) return cmdFiles[id]?.size ? '' : `<span class="delta" data-k="dl">${esc(t.noChange)}</span>`;
      return `<span class="delta" data-k="dl"><span class="add">+${d.add}</span> <span class="del">−${d.del}</span></span>`;
    };
    const note = (i) => `<div class="note${i.sent ? ' sent' : ''}${i.step ? '' : ' plan'}" data-k="n-${esc(i.id)}"><small>${esc(i.step ? t.noteFor : t.planNote)} · ${esc(i.sent ? t.sent : t.queued)}${i.sent ? '' : `<button class="link" data-cancel="${esc(i.id)}">${esc(t.cancel)}</button>`}</small><span>${esc(i.text)}</span></div>`;
    const notesOf = (id) => sv.items.filter((i) => i.kind === 'note' && i.step === String(id)).map(note).join('');
    const composer = (id) => {
      if (o.composing !== String(id)) return '';
      const free = id === 'add' || id === 'plan';
      const ph = id === 'add' ? t.addPh : id === 'plan' ? t.planPh : t.notePh;
      return `<form class="composer${free ? ` ${id}` : ''}" data-k="c-${esc(id)}" data-kind="${id === 'add' ? 'add' : 'note'}" data-step="${free ? '' : esc(id)}"${review && id === 'plan' ? ' data-also-go="1"' : ''}><textarea name="text" maxlength="500" aria-label="${esc(ph)}" placeholder="${esc(ph)}"></textarea><div><button type="button" class="btn small" data-compose="">${esc(t.cancel)}</button><button type="submit" class="btn small primary">${esc(t.send)}</button></div></form>`;
    };
    const noteButton = (task, key) => `<button class="ic"${key ? ` data-k="${key}"` : ''} data-compose="${esc(task.id)}" title="${esc(t.note)}" aria-label="${esc(t.note)}: ${esc(task.subject)}">${NOTE_IC}</button>`;
    const steps = tasks.map((task) => {
      const k = `s${esc(task.id)}`;
      const tip = esc(task.description && task.description !== task.subject ? `${task.subject}\n\n${task.description}` : task.subject);
      if (task.status === 'completed') {
        const chips = fileChips(task.id);
        const desc = task.description && task.description !== task.subject ? `<p data-k="p">${esc(task.description)}</p>` : '';
        const head = `<span class="st-ic" data-k="ic">${TICK}</span><span class="t" data-k="t" title="${tip}">${esc(task.subject)}</span>${delta(task.id) || `<time data-k="tm">${hour(task.mtime)}</time>`}`;
        return chips || desc
          ? `<li class="done" data-k="${k}"><details class="drow" data-k="d"><summary class="row" data-k="row">${head}</summary><div class="more" data-k="more">${desc}${chips}</div></details></li>`
          : `<li class="done" data-k="${k}"><div class="row" data-k="row">${head}</div></li>`;
      }
      if (task.status === 'in_progress') {
        const min = task.mtime ? Math.floor((now - task.mtime) / 60000) : 0;
        return `<li class="cur" data-k="${k}"><div class="card" data-k="card"><div class="cardtop" data-k="top"><span class="tag" data-k="tag">${esc(t.cur)}</span><time data-k="since">${esc(t.since(hour(task.mtime), min))}</time></div><span class="ct" data-k="t" title="${tip}">${esc(task.subject)}</span>${task.activeForm ? `<span class="af" data-k="af">${esc(task.activeForm)}…</span>` : ''}<div class="cardfoot" data-k="cf">${fileChips(task.id, true) || '<span data-k="fc"></span>'}${delta(task.id)}${noteButton(task, 'nb')}</div></div>${notesOf(task.id)}${composer(task.id)}</li>`;
      }
      const gone = open.find((i) => i.kind === 'remove' && i.step === String(task.id));
      const acts = gone
        ? `<span class="acts" data-k="a"><button class="link" data-cancel="${esc(gone.id)}">${esc(t.undo)}</button></span>`
        : `<span class="acts" data-k="a">${noteButton(task)}<button class="ic" data-remove="${esc(task.id)}" title="${esc(t.remove)}" aria-label="${esc(t.remove)}: ${esc(task.subject)}">${X_IC}</button></span>`;
      const wait = task.blockedBy?.length ? `<span class="after" data-k="w">${esc(t.after)} #${task.blockedBy.map((b) => esc(pos.get(String(b)) ?? b)).join(', #')}</span>` : '';
      return `<li class="todo${gone ? ' gone' : ''}" data-k="${k}"><div class="row" data-k="row"><span class="st-ic" data-k="ic">${pos.get(String(task.id))}</span><span class="t" data-k="t" title="${tip}">${esc(task.subject)}</span>${wait}${acts}</div>${notesOf(task.id)}${composer(task.id)}</li>`;
    }).join('');
    const added = open.filter((i) => i.kind === 'add').map((i) => `<li class="todo added" data-k="ad-${esc(i.id)}"><div class="row" data-k="row"><span class="st-ic" data-k="ic">+</span><span class="t" data-k="t">${esc(i.text)}</span><span class="acts" data-k="a"><button class="link" data-cancel="${esc(i.id)}">${esc(t.undo)}</button></span></div></li>`).join('');
    const addRow = complete ? '' : `<li class="addli" data-k="add">${o.composing === 'add' ? composer('add') : `<button class="addrow" data-k="ab" data-compose="add">${esc(t.addStep)}</button>`}</li>`;

    const where = complete
      ? `<div class="summit" data-k="summit">${esc(t.summit)}</div><div class="chips" data-k="chips"><span class="chip">${esc(t.count(total))}</span><span class="chip fin">${esc(t.doneAt)} ${hour(Math.max(...tasks.map((x) => x.mtime || 0)))}</span></div>`
      : review ? '' : `<div class="where" data-k="where"><b>${esc(cur ? t.stepOf(tasks.indexOf(cur) + 1, total) : t.doneOf(done, total))}</b><span>${esc(o.eta ? t.eta(duration(o.eta)) : `${Math.round((done / total) * 100)} %`)}</span></div>`;
    const plan = review
      ? `<div class="sticker" data-k="gate"><span>${esc(t.planT(total))}</span></div><p class="lead" data-k="lead">${esc(t.planP)}</p>`
      : sv.gate === 'go'
        ? `<div class="sticker ok" data-k="gate"><span>${esc(t.approvedT)}</span></div><p class="lead" data-k="lead">${esc(t.approvedP)}</p>${o.canTerminal ? `<button class="btn small" data-k="term" data-terminal="1">${esc(t.openTerminal)}</button>` : ''}`
        : '';
    const planNotes = sv.items.filter((i) => i.kind === 'note' && !i.step && !i.sent).map(note).join('') + composer('plan');
    const gobar = review ? `<div class="gobar" data-k="go"><button class="btn primary" data-go="1">${esc(t.go)}</button><button class="btn" data-compose="plan">${esc(t.rethink)}</button></div>` : '';
    const left = tasks.filter((x) => x.status === 'pending').length;
    const foot = complete ? `${STACK}<span class="foot" data-k="foot" style="align-self:center">${esc(t.full)}</span>`
      : review ? '' : `<span class="foot" data-k="foot">${esc(left ? t.stonesLeft(left) : t.foot)}</span>`;
    const old = stale ? `<span class="chip oldchip" data-k="old">${esc(t.old)} · ${esc(t.ago(now - r.mtime, date(r.mtime)))}</span>` : '';
    body = `<div class="now${stale ? ' stale' : ''}${review ? ' gate' : ''}" data-k="now-${esc(r.sid)}">${old}${plan}<div class="hero" data-k="hero">${trail(tasks, t)}${where}</div>${planNotes}<ol class="steps" data-k="steps">${steps}${added}${addRow}</ol>${gobar}${foot}</div>`;
  }
  const project = r?.cwd || o.project;
  const proj = project ? `<span class="chip proj" title="${esc(project)}" data-k="proj">${esc(path.basename(project))}</span>` : '';
  const tabs = `<nav class="tabs" data-k="tabs" aria-label="Cairn"><button data-tab="now" aria-pressed="${tab === 'now'}">${esc(t.now)}${r?.total ? ` · ${r.done}/${r.total}` : ''}</button><button data-tab="history" aria-pressed="${tab === 'history'}">${esc(t.history)}</button></nav>`;
  parts.push(`<main class="sheet" data-k="sheet"><header class="top" data-k="top">${MINI}<span class="word" data-k="w">cairn</span>${proj}</header>${tabs}${body}</main>`);
  return parts.join('');
}

// Static page (tests, README screenshots): same content, no script.
function render(r, o = {}) {
  return `<!doctype html><html lang="${o.lang || 'en'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body><div id="app">${renderApp(r, o)}</div></body></html>`;
}

// View script: only replaces the elements that changed (and animates the ones that arrive), announces changes to
// screen readers, filters the history as you type, relays clicks. The transport differs between VS Code and the
// universal view.
const SCRIPT = `
const app = document.getElementById('app'); const live = document.getElementById('live'); let first = true;
let query = '', scope = 'here', period = 0, lastBox = null;
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
const filter = () => {
  app.dataset.scope = scope;
  for (const b of app.querySelectorAll('[data-scope]')) b.setAttribute('aria-pressed', String(b.dataset.scope === scope));
  for (const b of app.querySelectorAll('[data-period]')) b.setAttribute('aria-pressed', String(+b.dataset.period === period));
  const min = period === 1 ? new Date().setHours(0, 0, 0, 0) : period ? Date.now() - period * 864e5 : 0;
  for (const day of app.querySelectorAll('.day')) {
    let any = false;
    for (const c of day.querySelectorAll('.hcard')) {
      const ok = (scope === 'all' || c.dataset.here === '1') && +c.dataset.t >= min && (!query || c.dataset.text.includes(query));
      c.hidden = !ok;
      any = any || ok;
    }
    day.hidden = !any;
  }
};
const receive = (m) => {
  if (m.type !== 'state') return;
  for (const [k, v] of Object.entries(m.vars || {})) document.documentElement.style.setProperty(k, v);
  const tpl = document.createElement('template');
  tpl.innerHTML = m.html;
  patch(app, tpl.content);
  first = false;
  const search = app.querySelector('[data-filter=q]');
  if (search && search.value.trim().toLowerCase() !== query) search.value = query; // a list shown again keeps its search
  filter();
  const box = app.querySelector('.composer textarea'); // a note being written gets the focus once
  if (box && box !== lastBox) box.focus();
  lastBox = box;
  if (typeof m.announcement === 'string' && live.textContent !== m.announcement) live.textContent = m.announcement;
};
const flash = (el) => { el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 1200); };
addEventListener('input', (e) => { if (e.target.dataset.filter === 'q') { query = e.target.value.trim().toLowerCase(); filter(); } });
addEventListener('click', (e) => {
  const el = e.target.closest('[data-open],[data-sid],[data-tab],[data-pick],[data-scope],[data-period],[data-copy],[data-opentab],[data-compose],[data-go],[data-cancel],[data-remove],[data-terminal]');
  if (!el) return;
  e.preventDefault();
  const d = el.dataset;
  if (d.open) open(el);
  else if (d.tab) { first = true; send({ type: 'tab', tab: d.tab }); }
  else if (d.pick !== undefined) { first = true; send({ type: 'pick', id: d.pick || null }); }
  else if (d.scope) { scope = d.scope; filter(); }
  else if (d.period !== undefined) { period = +d.period; filter(); }
  else if (d.copy !== undefined) copy(el);
  else if (d.opentab) send({ type: 'opentab' });
  else if (d.compose !== undefined) send({ type: 'compose', step: d.compose || null });
  else if (d.go) send({ type: 'steer', kind: 'go' });
  else if (d.cancel) send({ type: 'steer', kind: 'cancel', id: d.cancel });
  else if (d.remove) send({ type: 'steer', kind: 'remove', step: d.remove });
  else if (d.terminal) send({ type: 'terminal' });
  else send({ type: 'select', sid: d.sid });
});
addEventListener('submit', (e) => {
  const f = e.target.closest('form.composer');
  if (!f) return;
  e.preventDefault();
  const text = f.elements.text.value.trim();
  if (text) send({ type: 'steer', kind: f.dataset.kind, step: f.dataset.step, text, go: f.dataset.alsoGo === '1' });
});
addEventListener('keydown', (e) => {
  if (!e.target.matches('.composer textarea')) return;
  if (e.key === 'Escape') send({ type: 'compose', step: null });
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.target.form.requestSubmit();
});`;
const TRANSPORT = {
  vscode: `
const vscode = acquireVsCodeApi();
const send = (m) => vscode.postMessage(m);
const open = (el) => send({ type: 'open', file: el.dataset.open, step: el.dataset.step });
const copy = (el) => { send({ type: 'copy', text: el.dataset.copy }); flash(el); };
addEventListener('message', (e) => receive(e.data));
send({ type: 'ready' });`,
  web: `
const send = (m) => fetch('/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) });
const open = (el) => navigator.clipboard?.writeText(el.dataset.open).then(() => flash(el));
const copy = (el) => navigator.clipboard?.writeText(el.dataset.copy).then(() => flash(el));
const dark = matchMedia('(prefers-color-scheme: dark)');
const theme = () => { document.body.className = dark.matches ? 'vscode-dark' : 'vscode-light'; };
theme(); dark.addEventListener('change', theme);
new EventSource('/events').onmessage = (e) => receive(JSON.parse(e.data));`,
};
const CSS_WEB = 'body{min-height:100vh;padding:24px 16px}body.vscode-light{background:#F3F3F3}body.vscode-dark{background:#181818}';
const CSS_TAB = '#app{max-width:1180px;padding:18px 18px 28px}';

// Brand fonts shipped with the extension (media/fonts, SIL OFL 1.1); url(f) gives the address of a font file.
const fontFaces = (url) =>
  `@font-face{font-family:'Bricolage Grotesque';font-weight:400 800;font-display:swap;src:url(${url('BricolageGrotesque.woff2')}) format('woff2')}` +
  `@font-face{font-family:'JetBrains Mono';font-weight:400 700;font-display:swap;src:url(${url('JetBrainsMono.woff2')}) format('woff2')}`;

// View page: only its own script (nonce) and the extension's fonts (source) are allowed;
// in web mode, the page also talks to its own server (connect-src 'self'). wide: the history editor tab.
function shell(nonce, source = '', fontsCss = '', web = false, lang = 'en', wide = false) {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';${source ? ` font-src ${source};` : ''}${web ? " connect-src 'self';" : ''}`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Cairn</title><style>${fontsCss}${CSS}${web ? CSS_WEB : ''}${wide ? CSS_TAB : ''}</style></head>
<body><div id="live" class="sr" role="status" aria-live="polite"></div><div id="app"></div>
<script nonce="${nonce}">${SCRIPT}${TRANSPORT[web ? 'web' : 'vscode']}</script></body></html>`;
}

// ---------- extension ----------

function activate(context) {
  const vscode = require('vscode');
  let view, panel, chosen = null, current = null, known = new Set(), sessions = [], history = [];
  const surfaces = new Set(); // what shows Cairn: the sidebar view, and the history editor tab when open
  const notified = new Set();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'cairn.roadmap.focus';
  const fonts = vscode.Uri.joinPath(context.extensionUri, 'media', 'fonts');

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

  // The plan gate setting goes to ~/.claude/cairn/config.json, where the hook reads it (only once the user has set it).
  const syncGate = () => {
    const set = vscode.workspace.getConfiguration('cairn').inspect('planGate');
    const on = set?.workspaceValue ?? set?.globalValue;
    if (typeof on !== 'boolean') return;
    const f = path.join(CLAUDE_DIR, 'cairn', 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { /* no config yet */ }
    if (cfg.planGate === on) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ ...cfg, planGate: on }, null, 2) + '\n');
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

  const post = (s, msg) => {
    const k = JSON.stringify(msg);
    if (!s.ready || k === s.last) return;
    s.last = k;
    s.web.postMessage(msg);
  };

  const refresh = () => {
    const c = settings();
    const t = T[c.lang];
    const now = Date.now();
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => real(f.uri.fsPath));
    sessions = loadSessions(folders);
    const latest = sessions[0];
    if (!sessions.some((s) => s.sid === chosen)) chosen = null;
    const r = sessions.find((s) => s.sid === chosen) || latest || null;
    current = r;
    const tr = r ? traceOf(r.sid) : emptyTrace();
    const cmdFiles = r ? filesByCommand(r.tasks, tr, gitChanges(), now) : {};
    known = new Set([...Object.values(tr.files), ...Object.values(cmdFiles)].flatMap((s) => [...s]));
    history = loadHistory(folders);
    const signal = readSignal(folders, CLAUDE_DIR, now);
    const active = sessions.filter((s) => now - s.mtime < c.staleHours * 3600e3);
    const shared = { files: tr.files, cmdFiles, signal, pills: active.length > 1 ? active : [], now, lang: c.lang,
      staleHours: c.staleHours, history, project: folders[0], stats: r ? stepStats(r.sid, r.tasks, tr) : {},
      eta: timeLeft(r, history), steer: r ? readSteer(r.sid) : { items: [] }, canTerminal: true };

    for (const s of surfaces) {
      if (s.pick && !history.some((e) => e.id === s.pick)) s.pick = null;
      const pick = s.pick || (s.layout === 'tab' ? (history.find((e) => e.here) || history[0])?.id : null);
      history.find((e) => e.id === pick)?.steps.forEach((st) => st.files.forEach((f) => known.add(f)));
      post(s, { type: 'state', html: renderApp(r, { ...shared, tab: s.tab, pick, layout: s.layout, canTab: s.layout === 'panel', composing: s.composing }),
        vars: { '--accent': c.accent, '--pop': c.pop }, announcement: s.layout === 'panel' ? announcement(r, signal, c.lang) : '' });
    }
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
  // A file from the history (no step) just opens.
  const BEFORE = 'cairn-before';
  const openFile = async (file, step) => {
    const right = vscode.Uri.file(file);
    if (!step) return vscode.commands.executeCommand('vscode.open', right);
    const tr = current ? traceOf(current.sid) : null;
    const backup = tr?.files[step]?.has(file) ? backupBefore(tr, file, tr.start[step] ?? 0) : undefined;
    if (backup) {
      const left = vscode.Uri.from({ scheme: BEFORE, path: `/${current.sid}/${backup.name || 'empty'}/${path.basename(file)}` });
      return vscode.commands.executeCommand('vscode.diff', left, right, T[settings().lang].diffTitle(path.basename(file), step));
    }
    try { await vscode.commands.executeCommand('git.openChange', right); } catch { await vscode.commands.executeCommand('vscode.open', right); }
  };

  // One webview (sidebar view or history tab): its page, and what its clicks do.
  const show = (web, layout, tab) => {
    const s = { web, layout, tab, pick: null, composing: null, ready: false, last: undefined };
    web.options = { enableScripts: true, localResourceRoots: [fonts] };
    const url = (f) => web.asWebviewUri(vscode.Uri.joinPath(fonts, f)).toString();
    web.html = shell(crypto.randomBytes(16).toString('base64'), web.cspSource, fontFaces(url), false, settings().lang, layout === 'tab');
    web.onDidReceiveMessage((m) => {
      if (m?.type === 'ready') { s.ready = true; s.last = undefined; refresh(); }
      else if (m?.type === 'select' && sessions.some((x) => x.sid === m.sid)) { chosen = m.sid; refresh(); }
      else if (m?.type === 'tab' && (m.tab === 'now' || m.tab === 'history')) { s.tab = m.tab; s.pick = null; refresh(); }
      else if (m?.type === 'pick') { s.pick = history.some((e) => e.id === m.id) ? m.id : null; refresh(); }
      else if (m?.type === 'compose') { s.composing = typeof m.step === 'string' && /^[\w-]{1,12}$/.test(m.step) ? m.step : null; refresh(); }
      else if (m?.type === 'steer' && current && steer(current.sid, m, current.tasks)) { s.composing = null; refresh(); }
      else if (m?.type === 'terminal') vscode.commands.executeCommand('workbench.action.terminal.focus');
      else if (m?.type === 'open' && known.has(m.file)) openFile(m.file, String(m.step ?? ''));
      else if (m?.type === 'copy' && typeof m.text === 'string') {
        vscode.env.clipboard.writeText(m.text.slice(0, 200000));
        vscode.window.setStatusBarMessage(T[settings().lang].copied, 2000);
      } else if (m?.type === 'opentab') openHistory();
    });
    surfaces.add(s);
    return s;
  };
  const openHistory = () => {
    if (panel) return panel.reveal();
    panel = vscode.window.createWebviewPanel('cairn.history', T[settings().lang].historyTitle, vscode.ViewColumn.Active);
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'cairn.svg');
    const s = show(panel.webview, 'tab', 'history');
    panel.onDidChangeViewState(() => { schedule(); plan(); });
    panel.onDidDispose(() => { surfaces.delete(s); panel = undefined; });
  };

  let timer, loop;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 150); };
  const watchers = {};
  const watch = () => {
    for (const dir of ['tasks', ...['state', 'history', 'steer'].map((d) => path.join('cairn', d))].map((d) => path.join(CLAUDE_DIR, d))) {
      if (watchers[dir]) continue;
      try {
        watchers[dir] = fs.watch(dir, { recursive: true }, schedule);
        watchers[dir].on('error', () => { watchers[dir].close(); delete watchers[dir]; });
      } catch { /* folder not created yet */ }
    }
  };
  // Transcripts and the "since … min" timer are re-read every 2 s in the foreground, every 15 s otherwise
  // (the task, state and history folders stay watched live).
  const plan = () => {
    clearTimeout(loop);
    const activeNow = vscode.window.state.focused && (view?.visible || panel?.visible);
    loop = setTimeout(() => { watch(); refresh(); plan(); }, activeNow ? 2000 : 15000);
  };
  try { syncGate(); } catch { /* config folder not writable: the env variable still works */ }
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
        const s = show(v.webview, 'panel', 'now');
        v.onDidChangeVisibility(() => { schedule(); plan(); });
        v.onDidDispose(() => { surfaces.delete(s); view = undefined; });
      },
    }),
    vscode.commands.registerCommand('cairn.open', () => vscode.commands.executeCommand('cairn.roadmap.focus')),
    vscode.commands.registerCommand('cairn.history', openHistory),
    vscode.commands.registerCommand('cairn.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'cairn')),
    vscode.commands.registerCommand('cairn.refresh', refresh),
    vscode.window.onDidChangeWindowState(() => { schedule(); plan(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(schedule),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('cairn')) return;
      try { syncGate(); } catch { /* see above */ }
      schedule();
    }),
    { dispose: () => { clearTimeout(loop); clearTimeout(timer); Object.values(watchers).forEach((w) => w.close()); panel?.dispose(); } },
  );
}

module.exports = {
  activate, deactivate() {}, loadRoadmap, loadSessions, loadHistory, filesByStep, traceOf, emptyTrace, backupBefore, filesByCommand,
  readSignal, readSteer, steer, stepStats, lineDiff, timeLeft, trail, announcement, toMarkdown, bar, render, renderApp, shell,
  fontFaces, CLAUDE_DIR,
};
