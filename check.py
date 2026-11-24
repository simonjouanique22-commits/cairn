"""python3 check.py — checks the hooks against fake events, without running Claude."""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "hooks"))
from cairn import read_only  # noqa: E402

HOOK = Path(__file__).parent / "hooks" / "cairn.py"
tmp = Path(tempfile.mkdtemp())
base = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_ENABLE_TODO_TOOLS")}
base.update(CLAUDE_CONFIG_DIR=str(tmp / "claude"), TMPDIR=str(tmp / "tmp"), TMP=str(tmp / "tmp"), TEMP=str(tmp / "tmp"))
WRITE = {"tool_name": "Bash", "tool_input": {"command": "npm test"}}


def hook(evt, env=None, command=None, **extra):
    r = subprocess.run(command or [sys.executable, HOOK], input=json.dumps({"session_id": "s1", "hook_event_name": evt, **extra}),
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       env={**base, "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1", **(env or {})})
    return r.returncode, r.stdout + r.stderr


assert "TaskCreate" in json.loads(hook("SessionStart")[1])["hookSpecificOutput"]["additionalContext"]

# request without a roadmap: 2 actions pass, the 3rd is blocked once, the rest pass
hook("UserPromptSubmit")
assert [hook("PreToolUse", **WRITE)[0] for _ in range(2)] == [0, 0]
code, msg = hook("PreToolUse", tool_name="Write")
assert code == 2 and "missing roadmap" in msg
assert hook("PreToolUse", **WRITE)[0] == 0

# read-only commands do not count
hook("UserPromptSubmit")
look = {"tool_name": "Bash", "tool_input": {"command": "ls -la && git status | head -5"}}
assert [hook("PreToolUse", **look)[0] for _ in range(5)] == [0] * 5
assert read_only("cat a.txt 2>/dev/null | grep x") and read_only("git log --oneline")
assert not read_only("echo x > file") and not read_only("ls && rm -rf build")
assert not read_only("find . -name '*.tmp' -delete") and not read_only("sed -i s/a/b/ f")

# new request, roadmap created along the way: never blocked
hook("UserPromptSubmit")
time.sleep(0.05)
tasks = tmp / "claude" / "tasks" / "s1"
tasks.mkdir(parents=True)
(tasks / "1.json").write_text('{"id": "1", "status": "in_progress"}')
assert [hook("PreToolUse", **WRITE)[0] for _ in range(4)] == [0] * 4

# /cairn:pause turns blocking off for this session only; /cairn:resume (or the older /cairn:reprise) turns it back on
hook("UserPromptSubmit", prompt="/cairn:pause")
assert [hook("PreToolUse", **WRITE)[0] for _ in range(4)] == [0] * 4
hook("UserPromptSubmit", session_id="other")
assert [hook("PreToolUse", session_id="other", **WRITE)[0] for _ in range(3)] == [0, 0, 2]
hook("UserPromptSubmit", prompt="/cairn:resume")
assert [hook("PreToolUse", **WRITE)[0] for _ in range(3)] == [0, 0, 2]
hook("UserPromptSubmit", prompt="/cairn:pause")
hook("UserPromptSubmit", prompt="/cairn:reprise")
assert [hook("PreToolUse", **WRITE)[0] for _ in range(3)] == [0, 0, 2]

# the real hooks.json command (python3, else python) passes the blocking code through
if os.name != "nt":
    cmd = json.loads((HOOK.parent / "hooks.json").read_text())["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
    shell = ["sh", "-c", cmd.replace("${CLAUDE_PLUGIN_ROOT}", str(HOOK.parent.parent))]
    hook("UserPromptSubmit", command=shell, session_id="sh")
    assert [hook("PreToolUse", command=shell, session_id="sh", **WRITE)[0] for _ in range(3)] == [0, 0, 2]

# subagent actions do not count
hook("UserPromptSubmit")
assert [hook("PreToolUse", agent_id="a1", **WRITE)[0] for _ in range(4)] == [0] * 4

# Claude waits, then finishes its turn, then the user answers: the state follows
state = tmp / "claude" / "cairn" / "state" / "s1.json"
hook("Notification", message="Claude needs your permission to use Bash")
assert json.loads(state.read_text())["waiting"] is True
hook("Stop")
assert json.loads(state.read_text())["done"] is True
hook("UserPromptSubmit")
assert not state.exists()

# an odd session id stays inside the state folder
hook("Notification", session_id="../../evil")
assert (tmp / "claude" / "cairn" / "state" / "______evil.json").exists()

# unreadable input never blocks
r = subprocess.run([sys.executable, HOOK], input="not json", capture_output=True, text=True, env=base)
assert r.returncode == 0

# task tools disabled: a warning for the user, no blocking, but "waiting" still works
off = {"CLAUDE_CODE_ENABLE_TODO_TOOLS": ""}
assert "/cairn:setup" in json.loads(hook("SessionStart", env=off)[1])["systemMessage"]
hook("UserPromptSubmit", env=off)
assert [hook("PreToolUse", env=off, session_id="s2", **WRITE)[0] for _ in range(4)] == [0] * 4
hook("Notification", env=off, session_id="s2", message="m")
assert (tmp / "claude" / "cairn" / "state" / "s2.json").exists()

# desktop app: the plugin does nothing
desktop = {"CLAUDE_CODE_ENTRYPOINT": "claude-desktop"}
assert hook("SessionStart", env=desktop) == (0, "")
hook("UserPromptSubmit", env=desktop, session_id="s3")
assert [hook("PreToolUse", env=desktop, session_id="s3", **WRITE)[0] for _ in range(4)] == [0] * 4

# the old threshold variable still works
hook("UserPromptSubmit", env={"CAIRN_SEUIL": "1"}, session_id="s4")
assert hook("PreToolUse", env={"CAIRN_SEUIL": "1"}, session_id="s4", **WRITE)[0] == 2

print("ok")
