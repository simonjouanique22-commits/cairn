#!/usr/bin/env python3
"""Hooks du plugin claude-roadmap : Claude tient sa liste de tâches (la roadmap) sur les grosses demandes.

SessionStart     -> rappelle la règle à Claude (ou prévient l'utilisateur si les outils de tâches sont coupés).
UserPromptSubmit -> note le début de la demande.
PreToolUse       -> à la SEUIL-ième action (écriture ou commande) d'une demande sans liste de tâches créée
                    ou mise à jour depuis, bloque une seule fois l'action et demande la roadmap d'abord.

Sur les modèles récents, TaskCreate/TaskUpdate n'existent que si CLAUDE_CODE_ENABLE_TODO_TOOLS=1 :
sans cette variable, le plugin prévient et ne bloque jamais.
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path

SEUIL = int(os.environ.get("CLAUDE_ROADMAP_SEUIL", "3"))  # réglage : actions tolérées avant d'exiger la roadmap
# ponytail: sur les anciens modèles (Opus 4.7, Sonnet 4.6…) les outils existent sans la variable ; ils ne sont pas détectés
ACTIF = os.environ.get("CLAUDE_CODE_ENABLE_TODO_TOOLS", "").lower() in ("1", "true", "yes")
APP_BUREAU = os.environ.get("CLAUDE_CODE_ENTRYPOINT") == "claude-desktop"  # l'app a sa propre liste de tâches
AVERTISSEMENT = (
    'Roadmap inactive : les outils de tâches de Claude Code sont coupés. Ajoute '
    '"env": { "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" } dans ~/.claude/settings.json, puis relance Claude.'
)
CHARGER = "si TaskCreate/TaskUpdate sont différés, charge-les d'abord avec ToolSearch (`select:TaskCreate,TaskUpdate`)"
REGLE = (
    "Roadmap : dès qu'une demande compte 3 étapes ou plus, ta première action est de créer la liste des étapes "
    f"avec TaskCreate ({CHARGER}), puis de la tenir à jour avec TaskUpdate (in_progress en démarrant une étape, "
    "completed dès qu'elle est finie). N'écris pas de titres « Étape N » dans le texte à la place : "
    "cette liste est affichée à l'utilisateur comme roadmap."
)
BLOCAGE = (
    "Roadmap manquante : cette demande compte déjà plusieurs actions. Avant de continuer, crée la liste des "
    f"étapes avec TaskCreate ({CHARGER}) : une tâche par étape, y compris celles déjà faites (passe-les en "
    "completed), et l'étape en cours en in_progress. Relance ensuite l'action qui vient d'être bloquée."
)


def derniere_maj_taches(session):
    claude_dir = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    try:
        return max((f.stat().st_mtime for f in (claude_dir / "tasks" / session).glob("*.json")), default=0.0)
    except OSError:
        return 0.0


def main():
    evt = json.load(sys.stdin)
    nom = evt.get("hook_event_name")
    if APP_BUREAU:
        return 0
    if nom == "SessionStart":
        sortie = ({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": REGLE}} if ACTIF
                  else {"systemMessage": AVERTISSEMENT})
        print(json.dumps(sortie, ensure_ascii=False))
        return 0
    if not ACTIF:  # Claude ne peut pas créer la roadmap : inutile de le bloquer
        return 0

    session = evt.get("session_id", "inconnue")
    etat_f = Path(tempfile.gettempdir()) / "claude-roadmap" / f"{session}.json"
    neuf = {"debut": time.time(), "actions": 0, "relance": False}

    if nom == "UserPromptSubmit":
        etat = neuf
    elif nom == "PreToolUse" and not evt.get("agent_id"):  # les sous-agents ne comptent pas
        try:
            etat = json.loads(etat_f.read_text())
        except (OSError, ValueError):
            etat = neuf
        etat["actions"] += 1
        if etat["actions"] >= SEUIL and not etat["relance"] and derniere_maj_taches(session) < etat["debut"]:
            etat["relance"] = True  # une seule relance par demande : jamais de boucle
            ecrire(etat_f, etat)
            print(BLOCAGE, file=sys.stderr)
            return 2
    else:
        return 0
    ecrire(etat_f, etat)
    return 0


def ecrire(f, etat):
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(etat))


if __name__ == "__main__":
    sys.exit(main())
