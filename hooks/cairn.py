#!/usr/bin/env python3
"""Cairn plugin hooks: Claude keeps its task list (the roadmap) on large requests, and the editor knows when Claude
is waiting for the user.

SessionStart     -> gives Claude the rule (or warns the user when the task tools are disabled).
UserPromptSubmit -> marks the start of a request and clears the "waiting" state.
PreToolUse       -> on the THRESHOLD-th action (a write, or a command that changes something) of a request with no
                    task list created or updated since, blocks that action once and asks for the roadmap first.
Notification     -> Claude is waiting for the user (permission, answer): writes ~/.claude/cairn/state/<session>.json.
Stop             -> Claude finished its turn: same file, so the editor can say so.
/cairn:pause     -> (seen in UserPromptSubmit) no more blocking for this session; /cairn:resume turns it back on.

On recent models, TaskCreate/TaskUpdate only exist when CLAUDE_CODE_ENABLE_TODO_TOOLS=1: without it, the plugin warns
and never blocks. An internal error never blocks either.
"""
import json
import os
import re
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
        out = ({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": RULE}} if ENABLED
               else {"systemMessage": WARNING})
        print(json.dumps(out, ensure_ascii=False))
        return 0

    session = re.sub(r"[^\w-]", "_", str(evt.get("session_id") or "unknown"))  # used as a file name
    state = CLAUDE_DIR / "cairn" / "state" / f"{session}.json"
    if name == "Notification":
        write(state, {"waiting": True, "message": str(evt.get("message", ""))[:200], "t": time.time()})
        return 0
    if name == "Stop":
        write(state, {"done": True, "t": time.time()})
        return 0

    paused = CLAUDE_DIR / "cairn" / "paused" / session
    if name == "UserPromptSubmit":
        state.unlink(missing_ok=True)
        prompt = str(evt.get("prompt", "")).strip()
        if prompt.startswith("/cairn:pause"):
            write(paused, {"t": time.time()})
        elif prompt.startswith(("/cairn:resume", "/cairn:reprise")):
            paused.unlink(missing_ok=True)
    if not ENABLED or paused.exists():  # nothing to require: tools disabled, or blocking paused for this session
        return 0

    counter_f = Path(tempfile.gettempdir()) / "cairn" / f"{session}.json"
    fresh = {"start": time.time(), "actions": 0, "nudged": False}
    if name == "UserPromptSubmit":
        write(counter_f, fresh)
        return 0
    if name != "PreToolUse" or evt.get("agent_id"):  # subagent actions do not count
        return 0
    if evt.get("tool_name") == "Bash" and read_only(str((evt.get("tool_input") or {}).get("command", ""))):
        return 0
    try:
        counter = json.loads(counter_f.read_text())
        counter["start"], counter["actions"], counter["nudged"]  # older format: start over
    except (OSError, ValueError, KeyError):
        counter = fresh
    counter["actions"] += 1
    if counter["actions"] >= THRESHOLD and not counter["nudged"] and last_task_update(session) < counter["start"]:
        counter["nudged"] = True  # one nudge per request: never a loop
        write(counter_f, counter)
        print(BLOCK, file=sys.stderr)
        return 2
    write(counter_f, counter)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # a Cairn bug must never block Claude
        sys.exit(0)
