"""python3 check.py — checks the hooks against fake events, without running Claude."""
import json
import os
import subprocess
import sys
import tempfile
import threading
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

# history: a roadmap per request, titled by the request, with step times and files; it outlives the task list
hist = tmp / "claude" / "cairn" / "history" / "h1.json"
done = lambda sid, tool, **kw: hook("PostToolUse", session_id=sid, tool_name=tool, **kw)
hook("UserPromptSubmit", session_id="h1", prompt="Add a dark mode to the settings screen\nand more details")
done("h1", "TaskCreate", tool_input={"subject": "Read the code"}, tool_response={"task": {"id": "1", "subject": "Read the code"}})
done("h1", "TaskCreate", tool_input={"subject": "Write the screen"}, tool_response="Task #2 created successfully: Write the screen")
done("h1", "Write", tool_input={"file_path": "/p/early.ts"})  # no step in progress yet: not attached
done("h1", "TaskUpdate", tool_input={"taskId": "1", "status": "in_progress"})
done("h1", "Edit", tool_input={"file_path": "/p/a.ts"})
done("h1", "Edit", tool_input={"file_path": "/p/a.ts"})
done("h1", "TaskUpdate", tool_input={"taskId": "1", "status": "completed"})
done("h1", "Write", tool_input={"file_path": "/p/b.ts"}, agent_id="sub")  # subagents do not count
h = json.loads(hist.read_text())
r1 = h["roadmaps"][0]
assert r1["title"] == "Add a dark mode to the settings screen" and len(h["roadmaps"]) == 1
assert [s["status"] for s in r1["steps"]] == ["completed", "pending"] and r1["steps"][0]["files"] == ["/p/a.ts"]
assert r1["steps"][0]["started"] <= r1["steps"][0]["ended"] and "files" not in r1["steps"][1]
# all steps done (or dropped), short follow-up prompt: the next TaskCreate starts a new roadmap with the previous title
done("h1", "TaskUpdate", tool_input={"taskId": "2", "status": "deleted"})
hook("UserPromptSubmit", session_id="h1", prompt="ok go")
hook("UserPromptSubmit", session_id="h1", prompt="! brew install something")
hook("UserPromptSubmit", session_id="h1", prompt="/cairn:pause")
done("h1", "TaskCreate", tool_input={"subject": "Ship it"}, tool_response={"task": {"id": "3"}})
h = json.loads(hist.read_text())
assert len(h["roadmaps"]) == 2 and h["roadmaps"][1]["title"] == "Add a dark mode to the settings screen"
assert [s["id"] for s in h["roadmaps"][1]["steps"]] == ["3"]
if os.name != "nt":
    assert oct(hist.stat().st_mode & 0o777) == "0o600"
# a session without any roadmap leaves no history file
done("h2", "Write", tool_input={"file_path": "/p/x.ts"})
assert not (hist.parent / "h2.json").exists()
# old histories are removed at session start
old = hist.parent / "old.json"
old.write_text("{}")
os.utime(old, (time.time() - 200 * 86400,) * 2)
hook("SessionStart")
assert not old.exists() and hist.exists()

# steering: with the plan gate on, a new plan stops Claude before any change; the Stop hook waits for the user's go
# from the editor and hands Claude their changes; notes left while Claude works reach it without stopping it
gate = {"CAIRN_PLAN_GATE": "1", "CAIRN_GATE_WAIT": "15"}
steer_dir = tmp / "claude" / "cairn" / "steer"
steer = steer_dir / "g1.json"
created = lambda sid, i, env=gate: hook("PostToolUse", env=env, session_id=sid, tool_name="TaskCreate", tool_input={"subject": f"Step {i}"}, tool_response={"task": {"id": str(i)}})
hook("UserPromptSubmit", env=gate, session_id="g1", prompt="Build the settings screen please")
created("g1", 1)
created("g1", 2)
(tmp / "claude" / "tasks" / "g1").mkdir(parents=True)
(tmp / "claude" / "tasks" / "g1" / "1.json").write_text('{"id": "1", "status": "pending"}')  # Claude's roadmap exists
assert json.loads(steer.read_text())["gate"] == "waiting"
code, msg = hook("PreToolUse", env=gate, session_id="g1", tool_name="Write")
assert code == 2 and "plan review" in msg and json.loads(steer.read_text())["gate"] == "held"
assert hook("PreToolUse", env=gate, session_id="g1", tool_name="Bash", tool_input={"command": "ls src"})[0] == 0  # looking is fine


def say_go():  # what the view does when the user presses "Let Claude go" after editing the plan
    view = json.loads(steer.read_text())
    view.update(gate="go", items=[{"id": "a", "kind": "remove", "step": "2", "subject": "Step 2"},
                                  {"id": "b", "kind": "note", "step": "1", "subject": "Step 1", "text": "Start with api.ts\x07 " + "x" * 600},
                                  {"id": "c", "kind": "add", "text": "Update the docs"}])
    steer.write_text(json.dumps(view))


threading.Timer(1.5, say_go).start()
t0 = time.time()
code, out = hook("Stop", env=gate, session_id="g1")
answer = json.loads(out)
assert 1 < time.time() - t0 < 10 and answer["decision"] == "block"
reason = answer["reason"]
assert "said go" in reason and '- Remove step 2 "Step 2".' in reason and '- Add a step: "Update the docs".' in reason
assert 'Note on step 1 "Step 1": Start with api.ts' in reason and "\x07" not in reason and "x" * 501 not in reason
after = json.loads(steer.read_text())
assert after["gate"] is None and all(i["sent"] for i in after["items"])
assert hook("PreToolUse", env=gate, session_id="g1", tool_name="Write") == (0, "")


def note(text):
    view = json.loads(steer.read_text())
    view["items"].append({"id": text[:4], "kind": "note", "step": "", "text": text})
    steer.write_text(json.dumps(view))


# a note left while Claude works: context at its next action, nothing blocked, given once
note("Keep the old file readable")
code, out = hook("PreToolUse", env=gate, session_id="g1", tool_name="Edit")
assert code == 0 and "Note on the whole plan: Keep the old file readable" in json.loads(out)["hookSpecificOutput"]["additionalContext"]
assert hook("PreToolUse", env=gate, session_id="g1", tool_name="Edit") == (0, "")
# ...or right after a tool, or before Claude ends its turn (it then carries on)
note("Use vitest")
assert "Use vitest" in json.loads(hook("PostToolUse", env=gate, session_id="g1", tool_name="TaskUpdate", tool_input={"taskId": "1", "status": "completed"})[1])["hookSpecificOutput"]["additionalContext"]
note("Mind the docs")
answer = json.loads(hook("Stop", env=gate, session_id="g1")[1])
assert answer["decision"] == "block" and "Mind the docs" in answer["reason"]
assert hook("Stop", env=gate, session_id="g1") == (0, "")
# nobody answers: the wait gives up, and the next prompt (or /cairn:go) carries the go
quick = {"CAIRN_PLAN_GATE": "1", "CAIRN_GATE_WAIT": "1"}
hook("UserPromptSubmit", env=quick, session_id="g3", prompt="Another plan to review")
created("g3", 1, quick)
assert hook("PreToolUse", env=quick, session_id="g3", tool_name="Write")[0] == 2
assert hook("Stop", env=quick, session_id="g3") == (0, "") and json.loads((steer_dir / "g3.json").read_text())["gate"] == "waiting"
assert "said go" in json.loads(hook("UserPromptSubmit", env=quick, session_id="g3", prompt="/cairn:go")[1])["hookSpecificOutput"]["additionalContext"]
# without the gate, a new plan does not stop Claude; /cairn:go alone says go
hook("UserPromptSubmit", session_id="g2", prompt="Another request with steps")
hook("PostToolUse", session_id="g2", tool_name="TaskCreate", tool_input={"subject": "A"}, tool_response={"task": {"id": "1"}})
assert not (steer.parent / "g2.json").exists()
assert "said go" in json.loads(hook("UserPromptSubmit", session_id="g2", prompt="/cairn:go")[1])["hookSpecificOutput"]["additionalContext"]

# the old threshold variable still works
hook("UserPromptSubmit", env={"CAIRN_SEUIL": "1"}, session_id="s4")
assert hook("PreToolUse", env={"CAIRN_SEUIL": "1"}, session_id="s4", **WRITE)[0] == 2

print("ok")
