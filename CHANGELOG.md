# Journal des versions

## 1.2.0

- **Avant / après** : un clic sur un fichier ouvre la comparaison « avant l'étape ↔ maintenant », à partir de la copie
  que Claude Code garde avant de modifier un fichier (en lecture seule) ; sinon la comparaison avec git.
- **Fichiers modifiés par commande** (`sed -i`, scripts, génération…) : repérés via git et la fenêtre de temps de
  l'étape, affichés en pointillés à côté des écritures directes de Claude.
- **`/cairn:pause`** et **`/cairn:reprise`** : couper puis rétablir le blocage pour la session en cours.
- **Palette de VS Code** : « Cairn : Ouvrir la roadmap », « Cairn : Réglages », « Cairn : Rafraîchir ».
- **Accessibilité** : l'avancement et « Claude t'attend » sont annoncés aux lecteurs d'écran ; focus visible au clavier ;
  contrastes des couleurs vérifiés automatiquement (clair et sombre).
- **Sobriété** : relecture toutes les 15 s au lieu de 2 s quand VS Code est en arrière-plan ou la vue cachée.
- **Autres éditeurs** :
  - forks de VS Code (Cursor, Windsurf, VSCodium) : même extension, installée par `/cairn:setup` ;
  - VS Code à distance (SSH, WSL, conteneurs) : l'extension tourne là où tourne Claude Code ;
  - **vue universelle** (`web/serve.js`) : la même roadmap dans le navigateur, à côté de n'importe quel éditeur ;
  - **JetBrains** : plugin natif (fenêtre d'outils « Cairn » avec navigateur intégré), construit par la CI ;
  - **Vim / Neovim** : `:Cairn` ouvre un panneau latéral mis à jour en direct ;
  - **Zed** : tâche qui ouvre la vue universelle.
- **Windows et Linux** : chemins, encodage et lancement de Python adaptés ; tests sur Linux, macOS et Windows à chaque envoi.
- **Démo animée** dans le README, tirée du vrai rendu ; actions GitHub épinglées par empreinte de commit.

## 1.1.1

- **Polices de marque embarquées** : Bricolage Grotesque et JetBrains Mono (SIL Open Font License 1.1, jeu latin,
  108 Ko) dans l'extension — la vue autorise uniquement ces polices locales — et dans tous les visuels du README.
- La police à chasse fixe ne retombe plus sur la police principale quand celle de l'éditeur est absente.
- README : crédits et licences des polices, limites mises à jour.

## 1.1.0

- **Claude t'attend** : quand Claude attend une autorisation ou une réponse, un autocollant clignote dans la roadmap,
  la barre d'état passe en alerte et VS Code affiche une notification (bouton « Ouvrir le terminal »).
  Quand il a fini son tour, « Claude a fini, à toi ».
- **Fichiers par étape** : sous chaque étape, les fichiers que Claude a écrits pendant qu'elle était en cours, cliquables.
- **Vue vivante** : seuls les éléments qui changent sont mis à jour ; la nouvelle étape en cours, le « Sommet atteint »
  et les nouveaux fichiers arrivent en animation. Le chrono « depuis 14:17 · 12 min » avance tout seul.
- **Plusieurs sessions** dans le même dossier : des pastilles pour passer de l'une à l'autre.
- **Journal** des roadmaps passées du projet ; une roadmap ancienne est grisée et datée.
- **Réglages VS Code** : couleurs, délai avant « ancienne roadmap », notifications, langue. **Version anglaise.**
- **`/cairn:setup`** : vérifie et répare l'installation (variable des outils de tâches, extension VS Code).
- **Blocage plus fin** : les commandes de simple lecture (`ls`, `cat`, `git status`…) ne comptent plus.
- **Plus sûr** : une erreur interne du plugin ne bloque jamais Claude ; identifiant de session nettoyé.
- Le `.vsix` n'est plus versionné : il est construit par `setup.py` ou joint à chaque release GitHub.

## 1.0.0

- Identité Cairn : logo (pile de pastilles), tampon, roadmap « sticker » claire et sombre, état « Sommet atteint ».
- Plugin : règle donnée à Claude au démarrage, blocage unique si une demande avance sans roadmap.
