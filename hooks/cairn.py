#!/usr/bin/env python3
"""Hooks du plugin Cairn : Claude tient sa liste de tâches (la roadmap) sur les grosses demandes,
et l'extension VS Code sait quand il attend l'utilisateur.

SessionStart     -> rappelle la règle à Claude (ou prévient l'utilisateur si les outils de tâches sont coupés).
UserPromptSubmit -> note le début de la demande, efface l'état « attente ».
PreToolUse       -> à la SEUIL-ième action (écriture ou commande qui modifie) d'une demande sans liste de tâches
                    créée ou mise à jour depuis, bloque une seule fois l'action et demande la roadmap d'abord.
Notification     -> Claude attend l'utilisateur (autorisation, réponse) : écrit ~/.claude/cairn/etat/<session>.json.
Stop             -> Claude a fini son tour : même fichier, pour que VS Code le signale.
/cairn:pause     -> (repéré dans UserPromptSubmit) plus de blocage pour cette session ; /cairn:reprise le rétablit.

Sur les modèles récents, TaskCreate/TaskUpdate n'existent que si CLAUDE_CODE_ENABLE_TODO_TOOLS=1 :
sans cette variable, le plugin prévient et ne bloque jamais. Une erreur interne ne bloque jamais non plus.
"""
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

SEUIL = int(os.environ.get("CAIRN_SEUIL", "3"))  # réglage : actions tolérées avant d'exiger la roadmap
# ponytail: sur les anciens modèles (Opus 4.7, Sonnet 4.6…) les outils existent sans la variable ; ils ne sont pas détectés
ACTIF = os.environ.get("CLAUDE_CODE_ENABLE_TODO_TOOLS", "").lower() in ("1", "true", "yes")
APP_BUREAU = os.environ.get("CLAUDE_CODE_ENTRYPOINT") == "claude-desktop"  # l'app a sa propre liste de tâches
CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
RACINE = Path(__file__).resolve().parent.parent
AVERTISSEMENT = (
    'Cairn inactif : les outils de tâches de Claude Code sont coupés. Lance /cairn:setup, ou ajoute '
    '"env": { "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" } dans ~/.claude/settings.json, puis relance Claude.'
)
CHARGER = "si TaskCreate/TaskUpdate sont différés, charge-les d'abord avec ToolSearch (`select:TaskCreate,TaskUpdate`)"
REGLE = (
    "Roadmap : dès qu'une demande compte 3 étapes ou plus, ta première action est de créer la liste des étapes "
    f"avec TaskCreate ({CHARGER}), puis de la tenir à jour avec TaskUpdate (in_progress en démarrant une étape, "
    "completed dès qu'elle est finie). N'écris pas de titres « Étape N » dans le texte à la place : "
    "cette liste est affichée à l'utilisateur comme roadmap. "
    f"(Plugin Cairn installé dans {RACINE} ; /cairn:setup y lance setup.py pour vérifier l'installation.)"
)
BLOCAGE = (
    "Cairn — roadmap manquante : cette demande compte déjà plusieurs actions. Avant de continuer, crée la liste des "
    f"étapes avec TaskCreate ({CHARGER}) : une tâche par étape, y compris celles déjà faites (passe-les en "
    "completed), et l'étape en cours en in_progress. Relance ensuite l'action qui vient d'être bloquée."
)

# Commandes qui ne font que lire : elles ne comptent pas comme des actions.
LECTURE = {"ls", "cat", "head", "tail", "grep", "rg", "find", "pwd", "echo", "wc", "which", "tree", "stat", "file",
           "less", "du", "df", "date", "whoami", "type", "printenv", "diff", "cd", "true"}
GIT_LECTURE = {"status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "blame", "describe"}


def lecture_seule(cmd):
    """Vrai si chaque morceau de la commande ne fait que lire (pas de redirection vers un fichier)."""
    if re.search(r"(^|[^0-9&])>(?!&)", cmd):
        return False
    for morceau in re.split(r"&&|\|\||;|\||\n", cmd):
        mots = morceau.split()
        if not mots:
            continue
        if mots[0] == "git" and len(mots) > 1 and mots[1] in GIT_LECTURE:
            continue
        if mots[0] == "find" and ("-delete" in mots or "-exec" in mots):
            return False
        if mots[0] not in LECTURE:
            return False
    return True


def derniere_maj_taches(session):
    try:
        return max((f.stat().st_mtime for f in (CLAUDE_DIR / "tasks" / session).glob("*.json")), default=0.0)
    except OSError:
        return 0.0


def ecrire(f, contenu):
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(contenu, ensure_ascii=False))


def main():
    for flux in (sys.stdin, sys.stdout, sys.stderr):  # Windows : la console n'est pas forcément en UTF-8
        try:
            flux.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    evt = json.load(sys.stdin)
    nom = evt.get("hook_event_name")
    if APP_BUREAU:
        return 0
    if nom == "SessionStart":
        sortie = ({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": REGLE}} if ACTIF
                  else {"systemMessage": AVERTISSEMENT})
        print(json.dumps(sortie, ensure_ascii=False))
        return 0

    session = re.sub(r"[^\w-]", "_", str(evt.get("session_id") or "inconnue"))  # sert de nom de fichier
    signal = CLAUDE_DIR / "cairn" / "etat" / f"{session}.json"
    if nom == "Notification":
        ecrire(signal, {"attente": True, "message": str(evt.get("message", ""))[:200], "t": time.time()})
        return 0
    if nom == "Stop":
        ecrire(signal, {"fini": True, "t": time.time()})
        return 0
    pause = CLAUDE_DIR / "cairn" / "pause" / session
    if nom == "UserPromptSubmit":
        signal.unlink(missing_ok=True)
        demande = str(evt.get("prompt", "")).strip()
        if demande.startswith("/cairn:pause"):
            ecrire(pause, {"t": time.time()})
        elif demande.startswith("/cairn:reprise"):
            pause.unlink(missing_ok=True)
    if not ACTIF or pause.exists():  # rien à exiger : outils coupés, ou blocage mis en pause pour cette session
        return 0

    compteur_f = Path(tempfile.gettempdir()) / "cairn" / f"{session}.json"
    neuf = {"debut": time.time(), "actions": 0, "relance": False}
    if nom == "UserPromptSubmit":
        ecrire(compteur_f, neuf)
        return 0
    if nom != "PreToolUse" or evt.get("agent_id"):  # les sous-agents ne comptent pas
        return 0
    if evt.get("tool_name") == "Bash" and lecture_seule(str((evt.get("tool_input") or {}).get("command", ""))):
        return 0
    try:
        etat = json.loads(compteur_f.read_text())
    except (OSError, ValueError):
        etat = neuf
    etat["actions"] += 1
    if etat["actions"] >= SEUIL and not etat["relance"] and derniere_maj_taches(session) < etat["debut"]:
        etat["relance"] = True  # une seule relance par demande : jamais de boucle
        ecrire(compteur_f, etat)
        print(BLOCAGE, file=sys.stderr)
        return 2
    ecrire(compteur_f, etat)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # un bug de Cairn ne doit jamais bloquer Claude
        sys.exit(0)
