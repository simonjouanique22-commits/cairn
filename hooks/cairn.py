#!/usr/bin/env python3
"""Cairn plugin hooks: Claude keeps its task list (the roadmap) on large requests, and the editor knows when Claude
is waiting for the user.

SessionStart     -> gives Claude the rule (or warns the user when the task tools are disabled).
UserPromptSubmit -> marks the start of a request and clears the "waiting" state.
PreToolUse       -> on the THRESHOLD-th action (a write, or a command that changes something) of a request with no
                    task list created or updated since, blocks that action once and asks for the roadmap first.
Notification     -> Claude is waiting for the user (permission, answer): writes ~/.claude/cairn/state/<session>.json.
Stop             -> Claude finished its turn: same file, so the editor can say so.
PostToolUse      -> history: each TaskCreate / TaskUpdate (and the files written during a step) goes into
                    ~/.claude/cairn/history/<session>.json, which outlives Claude Code's own task list. And +/−: at
                    each step change and after each action during a step, a git snapshot of the working tree, so
                    the lines each step changed are known whatever wrote them (see "+/− per step" below).
Steering         -> the editor view writes the user's notes and edits on the roadmap to ~/.claude/cairn/steer/
                    <session>.json. They reach Claude without stopping it: as context at its next action, before it
                    ends its turn (Stop hook), or with the next prompt. With the plan gate on (CAIRN_PLAN_GATE=1 or
                    "planGate" in ~/.claude/cairn/config.json), Claude stops after making its plan; the Stop hook then
                    waits for the user's go from the editor (CAIRN_GATE_WAIT seconds, 600 by default) and Claude
                    picks up at once with their changes. Typing in the terminal, or /cairn:go, works too.
/cairn:pause     -> (seen in UserPromptSubmit) no more blocking for this session; /cairn:resume turns it back on.

On recent models, TaskCreate/TaskUpdate only exist when CLAUDE_CODE_ENABLE_TODO_TOOLS=1: without it, the plugin warns
and never blocks. An internal error never blocks either.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# setting: actions allowed before the roadmap is required (CAIRN_SEUIL kept for older setups)
THRESHOLD = int(os.environ.get("CAIRN_THRESHOLD") or os.environ.get("CAIRN_SEUIL") or "3")
# ponytail: on older models (Opus 4.7, Sonnet 4.6…) the tools exist without the variable; that is not detected
ENABLED = os.environ.get("CLAUDE_CODE_ENABLE_TODO_TOOLS", "").lower() in ("1", "true", "yes")
DESKTOP_APP = os.environ.get("CLAUDE_CODE_ENTRYPOINT") == "claude-desktop"  # the app has its own task list
CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
ROOT = Path(__file__).resolve().parent.parent
HISTORY = CLAUDE_DIR / "cairn" / "history"
HISTORY_DAYS = float(os.environ.get("CAIRN_HISTORY_DAYS") or "90")  # setting: how long roadmaps are kept
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
STEER = CLAUDE_DIR / "cairn" / "steer"
GATE_WAIT = min(840.0, float(os.environ.get("CAIRN_GATE_WAIT") or "600"))  # below the Stop hook's timeout (900 s)
CONFIG = CLAUDE_DIR / "cairn" / "config.json"
SNAPS = CLAUDE_DIR / "cairn" / "snaps"
OBJECTS = CLAUDE_DIR / "cairn" / "objects"
SNAP_DAYS = 7  # snapshots (copies of the changed files) are deleted after a week without use
BIG = 2_000_000  # bytes: a changed file this large stays out of the snapshots, and of the counts
WARNING = (
    'Cairn is inactive: Claude Code task tools are disabled. Run /cairn:setup, or add '
    '"env": { "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" } to ~/.claude/settings.json, then restart Claude.'
)
LOAD = "if TaskCreate/TaskUpdate are deferred, load them first with ToolSearch (`select:TaskCreate,TaskUpdate`)"
RULE = (
    "Roadmap: as soon as a request has 3 steps or more, your first action is to create the list of steps with "
    f"TaskCreate ({LOAD}), then keep it up to date with TaskUpdate (in_progress when a step starts, completed as soon "
    "as it is done). Do not write \"Step N\" headings in your text instead: this list is shown to the user as the "
    f"roadmap. (Cairn plugin installed in {ROOT}; /cairn:setup runs setup.py there to check the installation.)"
)
BLOCK = (
    "Cairn — missing roadmap: this request already has several actions. Before going on, create the list of steps "
    f"with TaskCreate ({LOAD}): one task per step, including the ones already done (mark them completed), and the "
    "current step in_progress. Then run the blocked action again."
)
GATE = (
    "Cairn — plan review: the user wants to review your roadmap in their editor before anything changes. Stop here: "
    "end your turn with one short sentence saying your plan is ready to review in Cairn. When they say go, you will "
    "get their changes. Do not retry this action."
)
FOLLOW = ("Update your task list to match (TaskUpdate / TaskCreate) if needed, take the notes into account, "
          "then carry on with the plan.")
NOTED = ("Cairn — while you work, the user left these notes on your roadmap from their editor:\n{items}\n"
         "Take them into account and update your task list (TaskUpdate / TaskCreate) if they change the plan.")

# Commands that only read: they do not count as actions.
READ_ONLY = {"ls", "cat", "head", "tail", "grep", "rg", "find", "pwd", "echo", "wc", "which", "tree", "stat", "file",
             "less", "du", "df", "date", "whoami", "type", "printenv", "diff", "cd", "true"}
GIT_READ_ONLY = {"status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "blame", "describe"}


def read_only(cmd):
    """True when every part of the command only reads (and nothing is redirected to a file)."""
    if re.search(r"(^|[^0-9&])>(?!&)", cmd):
        return False
    for part in re.split(r"&&|\|\||;|\||\n", cmd):
        words = part.split()
        if not words:
            continue
        if words[0] == "git" and len(words) > 1 and words[1] in GIT_READ_ONLY:
            continue
        if words[0] == "find" and ("-delete" in words or "-exec" in words):
            return False
        if words[0] not in READ_ONLY:
            return False
    return True


def last_task_update(session):
    try:
        return max((f.stat().st_mtime for f in (CLAUDE_DIR / "tasks" / session).glob("*.json")), default=0.0)
    except OSError:
        return 0.0


def write(f, content):
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(content, ensure_ascii=False))


# ---------- history ----------
# One file per session: {"cwd", "roadmaps": [{"start", "end", "steps": [{"id", "subject", "status", "created",
# "started", "ended", "files"}]}]}. Times in seconds. Only step titles, statuses, times and file paths, never the
# conversation: a roadmap is named after its first step.


def record(h, kind, t, **d):
    """Applies one event (create, update, file) to a session's history. Shared by the hook and setup.py's import."""
    roadmaps = h.setdefault("roadmaps", [])
    cur = roadmaps[-1] if roadmaps else None
    if kind == "create":
        if cur is None or all(s["status"] in ("completed", "deleted") for s in cur["steps"]):
            cur = {"start": t, "steps": []}  # the previous one is over: a new roadmap
            roadmaps.append(cur)
        cur["steps"].append({"id": str(d["id"]), "subject": str(d["subject"])[:200], "status": "pending", "created": t})
        cur["end"] = t
    elif kind == "update":
        for r in reversed(roadmaps):
            s = next((s for s in r["steps"] if s["id"] == str(d["id"])), None)
            if s:
                if d.get("subject"):
                    s["subject"] = str(d["subject"])[:200]
                if d.get("status") in ("pending", "in_progress", "completed", "deleted"):
                    s["status"] = d["status"]
                    if d["status"] == "in_progress":
                        s.setdefault("started", t)
                    elif d["status"] == "completed":
                        s.setdefault("started", s["created"])
                        s["ended"] = t
                r["end"] = t
                return
    elif kind == "file" and cur:
        for s in cur["steps"]:
            if s["status"] == "in_progress" and d["path"] not in s.setdefault("files", []) and len(s["files"]) < 50:
                s["files"].append(d["path"])
        cur["end"] = t


def load_json(f, empty):
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else empty
    except (OSError, ValueError):
        return empty


def save_private(f, data):
    """Writes a file readable by the user only, atomically."""
    f.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, f)


def load_history(session):
    return load_json(HISTORY / f"{session}.json", {"roadmaps": []})


def save_history(session, h):
    save_private(HISTORY / f"{session}.json", h)


# ---------- steering ----------
# {"gate": "waiting" | "go" | null, "items": [{"id", "kind": "note" | "remove" | "add", "step", "subject", "text",
# "t", "sent"}]}: written by the editor view, read here; an item is marked sent once Claude has it.

def gate_enabled():
    if os.environ.get("CAIRN_PLAN_GATE", "").lower() in ("1", "true", "yes"):
        return True
    return load_json(CONFIG, {}).get("planGate") is True


def wait_for_go(f):
    """The plan gate stopped Claude: waits for the user's go from the editor (or anything else they do there)."""
    end = time.time() + GATE_WAIT
    while time.time() < end:
        steer = load_json(f, {})
        if steer.get("gate") != "held":
            return steer
        time.sleep(1)
    steer = load_json(f, {})
    if steer.get("gate") == "held":  # no answer: the next prompt (or /cairn:go) will carry the go
        steer["gate"] = "waiting"
        save_private(f, steer)
    return steer


def unsent(steer):
    return [i for i in steer.get("items") or [] if isinstance(i, dict) and not i.get("sent")][:10]


def describe(items):
    """The user's notes and edits, as lines for Claude (lengths capped, control characters removed)."""
    clean = lambda v, n: re.sub(r"[\x00-\x1f]+", " ", str(v or "")).strip()[:n]
    lines = []
    for i in items:
        step, subject, text = clean(i.get("step"), 12), clean(i.get("subject"), 200), clean(i.get("text"), 500)
        if i.get("kind") == "remove":
            lines.append(f'- Remove step {step} "{subject}".')
        elif i.get("kind") == "add" and text:
            lines.append(f'- Add a step: "{text}".')
        elif i.get("kind") == "note" and text:
            lines.append(f'- Note on step {step} "{subject}": {text}' if step else f"- Note on the whole plan: {text}")
    return "\n".join(lines)


def prune_history(now):
    try:
        for f in HISTORY.glob("*.json"):
            if now - f.stat().st_mtime > HISTORY_DAYS * 86400:
                f.unlink()
    except OSError:
        pass


# ---------- +/− per step ----------
# A snapshot is a git tree of the working tree (tracked and untracked files, .gitignore respected) written to Cairn's
# own object store, ~/.claude/cairn/objects/<repository>/, which reads the repository's objects through git
# "alternates": the repository itself is never written to. The lines a step added and removed are the diff between
# its first snapshot and its last one, whoever wrote the files (Claude's edits, scripts, commands, subagents).
# ~/.claude/cairn/snaps/<session>.json = {"cur": step in progress, "steps": {step: {"start", "end", "add", "del"}}}.

def git(cwd, *args, env=None):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       env=env, timeout=15)
    if r.returncode:
        raise OSError(r.stderr.strip()[:200])
    return r.stdout


def snapshot(cwd):
    """(tree, top, env) of the working tree as it is now; None outside a git repository or when git fails."""
    try:
        top, gitdir = git(cwd, "rev-parse", "--show-toplevel", "--absolute-git-dir").splitlines()[:2]
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    store = OBJECTS / hashlib.sha1(top.encode("utf-8")).hexdigest()[:16]
    store.mkdir(parents=True, exist_ok=True)
    os.chmod(store.parent, 0o700)
    index = store / f"index-{os.getpid()}"
    env = {**os.environ, "GIT_INDEX_FILE": str(index), "GIT_OBJECT_DIRECTORY": str(store),
           "GIT_ALTERNATE_OBJECT_DIRECTORIES": os.path.join(gitdir, "objects")}
    try:
        real = Path(top) / git(top, "rev-parse", "--git-path", "index").strip()
        if real.exists():
            shutil.copyfile(real, index)  # a copy of the user's index: its stat cache, so only changed files are read
        changed = git(top, "status", "--porcelain", "-z", "--untracked-files=all", "--no-renames", env=env)
        big = [p for p in (e[3:] for e in changed.split("\0") if len(e) > 3)
               if os.path.isfile(os.path.join(top, p)) and os.path.getsize(os.path.join(top, p)) > BIG]
        if len(big) > 200:  # ponytail: a folder of large generated files, not counted at all
            return None
        git(top, "add", "-A", "--", ".", *(f":(exclude,literal){p}" for p in big), env=env)
        return git(top, "write-tree", env=env).strip(), top, env
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    finally:
        index.unlink(missing_ok=True)


def count_lines(evt, session):
    """Snapshot at a step's start, then after each action and at its end: its +/− so far."""
    tool, inp = evt.get("tool_name"), evt.get("tool_input") or {}
    f = SNAPS / f"{session}.json"
    s = load_json(f, {})
    status = inp.get("status") if tool == "TaskUpdate" else None
    tid = str(inp.get("taskId")) if tool == "TaskUpdate" else s.get("cur")
    if tool == "TaskUpdate" and status not in ("in_progress", "completed") or not tid:
        return
    step = s.setdefault("steps", {}).setdefault(tid, {})
    if status != "in_progress" and "start" not in step:  # not followed since it started
        return
    snap = snapshot(evt.get("cwd") or os.getcwd())
    if not snap:
        return
    tree, top, env = snap
    if status == "in_progress":
        step.setdefault("start", tree)
        s["cur"] = tid
    else:
        add = rem = 0
        for line in git(top, "diff-tree", "-r", "--numstat", step["start"], tree, env=env).splitlines():
            a, d = (line.split("\t") + ["", ""])[:2]
            if a.isdigit() and d.isdigit():  # "-" for binary files
                add, rem = add + int(a), rem + int(d)
        step.update(end=tree, add=add, **{"del": rem})
        if status == "completed" and s.get("cur") == tid:
            s["cur"] = None
    save_private(f, s)


def prune_snapshots(now):
    try:
        for d in [*OBJECTS.glob("*"), *SNAPS.glob("*.json")]:
            if now - d.stat().st_mtime > SNAP_DAYS * 86400:
                shutil.rmtree(d) if d.is_dir() else d.unlink()
    except OSError:
        pass


def created_id(response, session):
    """Id of the task TaskCreate just made: from its result, else the highest task file of the session."""
    if isinstance(response, dict) and isinstance(response.get("task"), dict) and response["task"].get("id"):
        return response["task"]["id"]
    m = re.search(r"#(\d+)", json.dumps(response))
    if m:
        return m.group(1)
    ids = [int(f.stem) for f in (CLAUDE_DIR / "tasks" / session).glob("*.json") if f.stem.isdigit()]
    return str(max(ids)) if ids else None


def on_tool_done(evt, session):
    tool, inp = evt.get("tool_name"), evt.get("tool_input") or {}
    h, t = load_history(session), time.time()
    if tool == "TaskCreate":
        tid = created_id(evt.get("tool_response"), session)
        if tid is None:
            return
        count = len(h.get("roadmaps", []))
        record(h, "create", t, id=tid, subject=inp.get("subject", ""))
        if len(h["roadmaps"]) > count and gate_enabled():  # a new plan: the user reviews it before Claude acts
            steer = load_json(STEER / f"{session}.json", {})
            steer["gate"] = "waiting"
            save_private(STEER / f"{session}.json", steer)
    elif tool == "TaskUpdate":
        record(h, "update", t, id=inp.get("taskId"), status=inp.get("status"), subject=inp.get("subject"))
    elif tool in WRITE_TOOLS and h["roadmaps"]:
        p = inp.get("file_path") or inp.get("notebook_path")
        if not isinstance(p, str):
            return
        record(h, "file", t, path=p)
    else:
        return
    h["cwd"] = evt.get("cwd") or h.get("cwd")
    save_history(session, h)


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):  # Windows: the console is not always UTF-8
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    evt = json.load(sys.stdin)
    name = evt.get("hook_event_name")
    if DESKTOP_APP:
        return 0
    if name == "SessionStart":
        prune_history(time.time())
        prune_snapshots(time.time())
        out = ({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": RULE}} if ENABLED
               else {"systemMessage": WARNING})
        print(json.dumps(out, ensure_ascii=False))
        return 0

    session = re.sub(r"[^\w-]", "_", str(evt.get("session_id") or "unknown"))  # used as a file name
    state = CLAUDE_DIR / "cairn" / "state" / f"{session}.json"
    if name == "Notification":
        write(state, {"waiting": True, "message": str(evt.get("message", ""))[:200], "t": time.time()})
        return 0
    if evt.get("agent_id"):  # subagents: their tasks and actions are not the session's roadmap
        return 0
    if name == "PostToolUse":
        on_tool_done(evt, session)
        try:
            count_lines(evt, session)
        except (OSError, ValueError, subprocess.SubprocessError):
            pass

    steer_f = STEER / f"{session}.json"
    steer = load_json(steer_f, {})
    items = unsent(steer)
    notes = ""

    def hand_over():
        """Marks the waiting items sent and returns them for Claude, as lines."""
        text = describe(items)
        for i in items:
            i["sent"] = True
        save_private(steer_f, steer)
        return text

    if name == "Stop":
        write(state, {"done": True, "t": time.time()})
        if steer.get("gate") == "held" and not evt.get("stop_hook_active"):
            steer = wait_for_go(steer_f)
            items = unsent(steer)
        went = steer.get("gate") == "go"
        if went or items:  # Claude does not stop: it gets the go and the notes, and carries on
            if went:
                steer["gate"] = None
            text = hand_over()
            head = ("The user reviewed your roadmap in their editor and said go." if went
                    else "While you were working, the user left these notes on your roadmap:")
            reason = f"(From the Cairn plugin, not an error.) {head}" + (f"\n{text}" if text else "") + f"\n{FOLLOW}"
            print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
        return 0
    if name == "PostToolUse":
        if items:
            context = NOTED.format(items=hand_over())
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": context}}, ensure_ascii=False))
        return 0

    prompt = str(evt.get("prompt", "")).strip()
    if name == "UserPromptSubmit" and (steer.get("gate") or items or prompt.startswith("/cairn:go")):
        went = steer.get("gate") == "go" or prompt.startswith("/cairn:go")
        context = ("Cairn — the user reviewed your roadmap and said go." if went
                   else "Cairn — the user has seen your roadmap in their editor.")
        steer["gate"] = None
        text = hand_over()
        if text:
            context += f" Their changes:\n{text}\n{FOLLOW}"
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": context}}, ensure_ascii=False))
    if name == "PreToolUse":
        looking = evt.get("tool_name") == "Bash" and read_only(str((evt.get("tool_input") or {}).get("command", "")))
        if steer.get("gate") in ("waiting", "held") and not looking:
            steer["gate"] = "held"  # Claude is stopping for the review: the Stop hook will wait for the go
            save_private(steer_f, steer)
            print(GATE, file=sys.stderr)
            return 2
        if steer.get("gate") == "go":  # go while Claude is still acting: nothing to wait for
            steer["gate"] = None
            save_private(steer_f, steer)
        if items:
            notes = hand_over()

    def finish(code):
        """Notes reach Claude without stopping it: as context, or in the message of a block that happens anyway."""
        if code == 2:
            print(BLOCK + (f"\n\n{NOTED.format(items=notes)}" if notes else ""), file=sys.stderr)
        elif notes:
            context = NOTED.format(items=notes)
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": context}}, ensure_ascii=False))
        return code

    paused = CLAUDE_DIR / "cairn" / "paused" / session
    if name == "UserPromptSubmit":
        state.unlink(missing_ok=True)
        if prompt.startswith("/cairn:pause"):
            write(paused, {"t": time.time()})
        elif prompt.startswith(("/cairn:resume", "/cairn:reprise")):
            paused.unlink(missing_ok=True)
    if not ENABLED or paused.exists():  # nothing to require: tools disabled, or blocking paused for this session
        return finish(0)

    counter_f = Path(tempfile.gettempdir()) / "cairn" / f"{session}.json"
    fresh = {"start": time.time(), "actions": 0, "nudged": False}
    if name == "UserPromptSubmit":
        write(counter_f, fresh)
        return 0
    if name != "PreToolUse":
        return 0
    if evt.get("tool_name") == "Bash" and read_only(str((evt.get("tool_input") or {}).get("command", ""))):
        return finish(0)
    try:
        counter = json.loads(counter_f.read_text())
        counter["start"], counter["actions"], counter["nudged"]  # older format: start over
    except (OSError, ValueError, KeyError):
        counter = fresh
    counter["actions"] += 1
    if counter["actions"] >= THRESHOLD and not counter["nudged"] and last_task_update(session) < counter["start"]:
        counter["nudged"] = True  # one nudge per request: never a loop
        write(counter_f, counter)
        return finish(2)
    write(counter_f, counter)
    return finish(0)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # a Cairn bug must never block Claude
        sys.exit(0)
