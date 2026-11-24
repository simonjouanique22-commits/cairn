# Changelog

## 1.3.0

- **English first.** Every view, message, command and doc is now in English by default; French stays as a translation
  (VS Code follows its display language, `cairn.language` forces one; `--lang fr` for the universal view; `v:lang` or
  `g:cairn_lang` in Vim). French README: `README.fr.md`.
- VS Code manifest translated through `package.nls.json` / `package.nls.fr.json`.
- `/cairn:resume` replaces `/cairn:reprise` (still accepted). `CAIRN_THRESHOLD` replaces `CAIRN_SEUIL` (still accepted).
- VS Code command ids are now `cairn.open`, `cairn.settings`, `cairn.refresh`.
- The hook writes its per-session state to `~/.claude/cairn/state/` (`waiting` / `done`); the views read it there.
- README visuals redrawn in English (`screen-light`, `screen-dark`, `screen-summit`); the animated demo's sticker
  animation fixed.

## 1.2.0

- **Before / after**: clicking a file opens the "before the step ↔ now" diff, from the backup Claude Code keeps before
  changing a file (read-only); otherwise the git diff.
- **Files changed by commands** (`sed -i`, scripts, code generation…): found through git and the step's time window,
  shown dashed next to Claude's direct writes.
- **`/cairn:pause`** and **`/cairn:reprise`** (now `/cairn:resume`): turn blocking off, then back on, for the current session.
- **VS Code palette**: "Cairn: Open the roadmap", "Cairn: Settings", "Cairn: Refresh".
- **Accessibility**: progress and "Claude is waiting for you" announced to screen readers; visible keyboard focus;
  color contrasts checked automatically (light and dark).
- **Lighter**: re-reads every 15 s instead of 2 s when VS Code is in the background or the view is hidden.
- **Other editors**:
  - VS Code forks (Cursor, Windsurf, VSCodium): the same extension, installed by `/cairn:setup`;
  - remote VS Code (SSH, WSL, containers): the extension runs where Claude Code runs;
  - **universal view** (`web/serve.js`): the same roadmap in the browser, next to any editor;
  - **JetBrains**: native plugin ("Cairn" tool window with an embedded browser), built by CI;
  - **Vim / Neovim**: `:Cairn` opens a side panel updated live;
  - **Zed**: a task that opens the universal view.
- **Windows and Linux**: paths, encoding and Python launch adapted; tests on Linux, macOS and Windows on every push.
- **Animated demo** in the README, taken from the real rendering; GitHub Actions pinned by commit hash.

## 1.1.1

- **Embedded brand fonts**: Bricolage Grotesque and JetBrains Mono (SIL Open Font License 1.1, Latin set, 108 KB) in
  the extension — the view only allows these local fonts — and in every README visual.
- The monospace font no longer falls back to the main font when the editor's is missing.
- README: font credits and licenses, updated limits.

## 1.1.0

- **Claude is waiting for you**: when Claude waits for a permission or an answer, a sticker blinks in the roadmap, the
  status bar goes on alert and VS Code shows a notification ("Open terminal" button). When it has finished its turn,
  "Claude is done — your turn".
- **Files per step**: under each step, the files Claude wrote while it was in progress, clickable.
- **Live view**: only the elements that change are updated; the new step in progress, "Summit reached" and new files
  arrive with an animation. The "since 14:17 · 12 min" timer ticks on its own.
- **Several sessions** in the same folder: pills to switch between them.
- **Log** of the project's past roadmaps; an old roadmap is greyed out and dated.
- **VS Code settings**: colors, delay before "old roadmap", notifications, language. **English version.**
- **`/cairn:setup`**: checks and repairs the installation (task tools variable, VS Code extension).
- **Finer blocking**: read-only commands (`ls`, `cat`, `git status`…) no longer count.
- **Safer**: an internal plugin error never blocks Claude; session id sanitized.
- The `.vsix` is no longer versioned: it is built by `setup.py` or attached to every GitHub release.

## 1.0.0

- Cairn identity: logo (stack of pills), stamp, light and dark "sticker" roadmap, "Summit reached" state.
- Plugin: rule given to Claude at startup, a single block when a request moves on without a roadmap.
