<p align="center"><img src="assets/logo.svg" width="240" alt="Cairn — le plan de Claude, pierre après pierre"></p>

<h1 align="center">cairn</h1>

<p align="center"><b>Le plan de Claude, pierre après pierre.</b><br>
Sur les grosses demandes, Claude Code découpe le travail en étapes. Cairn l'y oblige et affiche cette roadmap dans VS Code, en direct.</p>

## Ce que ça fait

| Élément | Rôle |
| --- | --- |
| `hooks/` (plugin Claude Code) | Au démarrage, donne la règle à Claude. Si une demande atteint 3 actions (écriture ou commande) sans liste de tâches, bloque une seule fois l'action et demande la roadmap d'abord. |
| `vscode/` (extension) | La roadmap en planche « sticker » dans la barre latérale : avancement, étape en cours, étapes faites barrées, puis « Sommet atteint ». Clair ou sombre selon le thème de VS Code. Résumé dans la barre d'état. |

Rien ne sort du poste : pas d'appel réseau, lecture seule des fichiers de tâches de Claude Code (`~/.claude/tasks/`).

## Installation

Prérequis : Claude Code, `python3`, VS Code.

1. **Activer les outils de tâches.** Sur les modèles récents (constaté avec Opus 5.5), Claude Code ne fournit
   TaskCreate/TaskUpdate que si cette variable est définie. Dans `~/.claude/settings.json` :
   ```json
   "env": { "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" }
   ```
2. **Installer le plugin** (dossier local ou dépôt) :
   ```bash
   claude plugin marketplace add <dossier-ou-dépôt>
   claude plugin install cairn@cairn-local
   ```
3. **Installer l'extension VS Code** :
   ```bash
   code --install-extension vscode/cairn.vsix
   ```
   (ou, dans VS Code : Extensions › … › Install from VSIX…)
4. Relancer Claude Code, puis ouvrir l'onglet **Cairn** dans la barre d'activité de VS Code.

Le thème suit celui de VS Code ; pour qu'il suive le système, activer `window.autoDetectColorScheme` dans VS Code.
La liste de tâches native du terminal se replie avec **Ctrl+T**.

## Réglages

- `CAIRN_SEUIL` (défaut `3`) : nombre d'actions tolérées avant d'exiger la roadmap.
- Sans `CLAUDE_CODE_ENABLE_TODO_TOOLS`, le plugin affiche un avertissement au démarrage et ne bloque rien.
- Dans l'app de bureau Claude (qui a sa propre liste de tâches), le plugin ne fait rien.

Désactiver : `claude plugin disable cairn@cairn-local`.

## Tests

```bash
python3 check.py          # hooks, sur de faux événements
node vscode/test.js       # lecture des tâches et rendu de la roadmap
```

Reconstruire l'extension : `cd vscode && npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license -o cairn.vsix`.
Les sources du logo sont dans `assets/` (`icon.svg` : icône, `logo.svg` : tampon).

## Limites connues

- Testé sur macOS ; sous Windows, la commande `python3` des hooks peut devoir devenir `python`.
- Une liste nommée (`CLAUDE_CODE_TASK_LIST_ID`) sans transcript associé n'est pas reliée au dossier ouvert.
- Sur les anciens modèles où les outils existent sans la variable, le blocage de secours reste inactif.
- Les polices de marque (Bricolage Grotesque, JetBrains Mono) ne sont pas embarquées : la vue utilise les polices du système et celle de l'éditeur.

Code écrit avec l'assistance de Claude (IA).
