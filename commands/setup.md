---
description: Vérifie et répare l'installation de Cairn (outils de tâches, extension VS Code)
allowed-tools: Bash(python3:*)
---

Vérifie l'installation de Cairn pour l'utilisateur.

1. Lance `python3 "${CLAUDE_PLUGIN_ROOT}/setup.py"`. Si la variable n'est pas remplacée, le dossier du plugin Cairn
   est indiqué dans le contexte de démarrage de la session (« Plugin Cairn installé dans … »).
2. Présente le résultat en français, une ligne par point, sans jargon.
3. S'il reste des « ✗ », liste précisément ce que `--fix` va changer (ajout d'une variable dans
   `~/.claude/settings.json`, installation de l'extension VS Code) et demande son accord.
4. Seulement après son accord, lance la même commande avec `--fix`, puis montre le nouveau résultat.
   Si la variable vient d'être ajoutée, rappelle qu'il faut relancer Claude Code.

Ne modifie rien d'autre que ce que `setup.py --fix` modifie.
