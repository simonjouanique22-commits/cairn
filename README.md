# claude-roadmap

Plugin Claude Code : sur les grosses demandes, Claude découpe le travail en étapes (sa liste de tâches)
et la tient à jour. Une extension VS Code l'affiche en frise, avec l'avancement.

```
40 %                       2 / 5 étapes
▰▰▰▰▱▱▱▱▱▱
✓ 1. Lire le code existant
✓ 2. Concevoir le modèle de données
▶ 3. Implémenter l'écran        EN COURS
○ 4. Écrire les tests           attend #3
○ 5. Relecture et documentation
⚑ Arrivée
```

## Contenu

| Élément | Rôle |
| --- | --- |
| `hooks/` | Au démarrage, donne la règle à Claude. Si une demande atteint 3 actions (écriture ou commande) sans liste de tâches, bloque une seule fois l'action et demande la roadmap d'abord. |
| `vscode/` | Extension VS Code : frise dans la barre latérale (horizontale si la vue est large), avancement dans la barre d'état. Lit `~/.claude/tasks/<session>/*.json` pour la session lancée dans le dossier ouvert. |

Rien ne sort du poste : pas d'appel réseau, lecture seule des fichiers de tâches de Claude Code.

## Installation

Prérequis : Claude Code, `python3`, VS Code.

1. **Activer les outils de tâches.** Sur les modèles récents (constaté avec Opus 5.5), Claude Code ne
   fournit TaskCreate/TaskUpdate que si cette variable est définie. Dans `~/.claude/settings.json` :
   ```json
   "env": { "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" }
   ```
2. **Installer le plugin** (dossier local ou URL du dépôt) :
   ```bash
   claude plugin marketplace add <dossier-ou-url-du-dépôt>
   claude plugin install claude-roadmap@claude-roadmap-local
   ```
3. **Installer l'extension VS Code** :
   ```bash
   code --install-extension vscode/claude-roadmap.vsix
   ```
   (ou, dans VS Code : Extensions › … › Install from VSIX…)
4. Relancer Claude Code, puis ouvrir l'onglet « Roadmap Claude » dans VS Code.

Optionnel : [claude-hud](https://github.com/jarrodwatts/claude-hud) affiche aussi l'étape en cours sous la saisie
(`/hud`, puis « affiche la ligne des todos »).

## Réglages

- `CLAUDE_ROADMAP_SEUIL` (défaut `3`) : nombre d'actions tolérées avant d'exiger la roadmap.
- Sans `CLAUDE_CODE_ENABLE_TODO_TOOLS`, le plugin affiche un avertissement au démarrage et ne bloque rien.
- Dans l'app de bureau Claude (qui a sa propre liste de tâches), le plugin ne fait rien.

Désactiver : `claude plugin disable claude-roadmap@claude-roadmap-local`.

## Tests

```bash
python3 check.py          # hooks, sur de faux événements
node vscode/test.js       # lecture des tâches et rendu de la frise
```

Reconstruire l'extension : `cd vscode && npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license`.

## Limites connues

- Testé sur macOS ; sous Windows, la commande `python3` des hooks peut devoir devenir `python`.
- Une liste nommée (`CLAUDE_CODE_TASK_LIST_ID`) sans transcript associé n'est pas reliée au dossier ouvert.
- Sur les anciens modèles où les outils existent sans la variable, le blocage de secours reste inactif.

Code écrit avec l'assistance de Claude (IA).
