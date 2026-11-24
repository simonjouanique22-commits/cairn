"""python3 check.py — vérifie les hooks sur de faux événements, sans lancer Claude."""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HOOK = Path(__file__).parent / "hooks" / "cairn.py"
tmp = Path(tempfile.mkdtemp())
base = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_ENABLE_TODO_TOOLS")}
base.update(CLAUDE_CONFIG_DIR=str(tmp / "claude"), TMPDIR=str(tmp / "etat"))


def hook(evt, env=None, **extra):
    r = subprocess.run([sys.executable, HOOK], input=json.dumps({"session_id": "s1", "hook_event_name": evt, **extra}),
                       capture_output=True, text=True, env={**base, "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1", **(env or {})})
    return r.returncode, r.stdout + r.stderr


assert "TaskCreate" in json.loads(hook("SessionStart")[1])["hookSpecificOutput"]["additionalContext"]

# demande sans roadmap : 2 actions passent, la 3e est bloquée une fois, la suite passe
hook("UserPromptSubmit")
assert [hook("PreToolUse", tool_name="Bash")[0] for _ in range(2)] == [0, 0]
code, msg = hook("PreToolUse", tool_name="Write")
assert code == 2 and "roadmap manquante" in msg
assert hook("PreToolUse", tool_name="Bash")[0] == 0

# nouvelle demande, roadmap créée en cours de route : jamais bloquée
hook("UserPromptSubmit")
time.sleep(0.05)
taches = tmp / "claude" / "tasks" / "s1"
taches.mkdir(parents=True)
(taches / "1.json").write_text('{"id": "1", "status": "in_progress"}')
assert [hook("PreToolUse", tool_name="Bash")[0] for _ in range(4)] == [0, 0, 0, 0]

# les actions des sous-agents ne comptent pas
hook("UserPromptSubmit")
assert [hook("PreToolUse", tool_name="Bash", agent_id="a1")[0] for _ in range(4)] == [0, 0, 0, 0]

# outils de tâches coupés : avertissement pour l'utilisateur, aucun blocage
coupe = {"CLAUDE_CODE_ENABLE_TODO_TOOLS": ""}
assert "CLAUDE_CODE_ENABLE_TODO_TOOLS" in json.loads(hook("SessionStart", env=coupe)[1])["systemMessage"]
hook("UserPromptSubmit", env=coupe)
assert [hook("PreToolUse", env=coupe, tool_name="Bash", session_id="s2")[0] for _ in range(4)] == [0, 0, 0, 0]

# app de bureau : le plugin ne fait rien
bureau = {"CLAUDE_CODE_ENTRYPOINT": "claude-desktop"}
assert hook("SessionStart", env=bureau) == (0, "")
hook("UserPromptSubmit", env=bureau, session_id="s3")
assert [hook("PreToolUse", env=bureau, tool_name="Bash", session_id="s3")[0] for _ in range(4)] == [0, 0, 0, 0]

print("ok")
