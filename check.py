"""python3 check.py — vérifie les hooks sur de faux événements, sans lancer Claude."""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "hooks"))
from cairn import lecture_seule  # noqa: E402

HOOK = Path(__file__).parent / "hooks" / "cairn.py"
tmp = Path(tempfile.mkdtemp())
base = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_ENABLE_TODO_TOOLS")}
base.update(CLAUDE_CONFIG_DIR=str(tmp / "claude"), TMPDIR=str(tmp / "etat"))
ECRIT = {"tool_name": "Bash", "tool_input": {"command": "npm test"}}


def hook(evt, env=None, **extra):
    r = subprocess.run([sys.executable, HOOK], input=json.dumps({"session_id": "s1", "hook_event_name": evt, **extra}),
                       capture_output=True, text=True, env={**base, "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1", **(env or {})})
    return r.returncode, r.stdout + r.stderr


assert "TaskCreate" in json.loads(hook("SessionStart")[1])["hookSpecificOutput"]["additionalContext"]

# demande sans roadmap : 2 actions passent, la 3e est bloquée une fois, la suite passe
hook("UserPromptSubmit")
assert [hook("PreToolUse", **ECRIT)[0] for _ in range(2)] == [0, 0]
code, msg = hook("PreToolUse", tool_name="Write")
assert code == 2 and "roadmap manquante" in msg
assert hook("PreToolUse", **ECRIT)[0] == 0

# les commandes de simple lecture ne comptent pas
hook("UserPromptSubmit")
lire = {"tool_name": "Bash", "tool_input": {"command": "ls -la && git status | head -5"}}
assert [hook("PreToolUse", **lire)[0] for _ in range(5)] == [0] * 5
assert lecture_seule("cat a.txt 2>/dev/null | grep x") and lecture_seule("git log --oneline")
assert not lecture_seule("echo x > fichier") and not lecture_seule("ls && rm -rf build")
assert not lecture_seule("find . -name '*.tmp' -delete") and not lecture_seule("sed -i s/a/b/ f")

# nouvelle demande, roadmap créée en cours de route : jamais bloquée
hook("UserPromptSubmit")
time.sleep(0.05)
taches = tmp / "claude" / "tasks" / "s1"
taches.mkdir(parents=True)
(taches / "1.json").write_text('{"id": "1", "status": "in_progress"}')
assert [hook("PreToolUse", **ECRIT)[0] for _ in range(4)] == [0] * 4

# les actions des sous-agents ne comptent pas
hook("UserPromptSubmit")
assert [hook("PreToolUse", agent_id="a1", **ECRIT)[0] for _ in range(4)] == [0] * 4

# Claude attend, puis finit son tour, puis l'utilisateur répond : l'état suit
signal = tmp / "claude" / "cairn" / "etat" / "s1.json"
hook("Notification", message="Claude needs your permission to use Bash")
assert json.loads(signal.read_text())["attente"] is True
hook("Stop")
assert json.loads(signal.read_text())["fini"] is True
hook("UserPromptSubmit")
assert not signal.exists()

# un identifiant de session farfelu reste dans le dossier d'état
hook("Notification", session_id="../../evil")
assert (tmp / "claude" / "cairn" / "etat" / "______evil.json").exists()

# une entrée illisible ne bloque jamais
r = subprocess.run([sys.executable, HOOK], input="pas du json", capture_output=True, text=True, env=base)
assert r.returncode == 0

# outils de tâches coupés : avertissement pour l'utilisateur, aucun blocage, mais l'attente marche
coupe = {"CLAUDE_CODE_ENABLE_TODO_TOOLS": ""}
assert "/cairn:setup" in json.loads(hook("SessionStart", env=coupe)[1])["systemMessage"]
hook("UserPromptSubmit", env=coupe)
assert [hook("PreToolUse", env=coupe, session_id="s2", **ECRIT)[0] for _ in range(4)] == [0] * 4
hook("Notification", env=coupe, session_id="s2", message="m")
assert (tmp / "claude" / "cairn" / "etat" / "s2.json").exists()

# app de bureau : le plugin ne fait rien
bureau = {"CLAUDE_CODE_ENTRYPOINT": "claude-desktop"}
assert hook("SessionStart", env=bureau) == (0, "")
hook("UserPromptSubmit", env=bureau, session_id="s3")
assert [hook("PreToolUse", env=bureau, session_id="s3", **ECRIT)[0] for _ in range(4)] == [0] * 4

print("ok")
