<p align="right"><b>English</b> · <a href="README.fr.md">Français</a></p>

<p align="center">
  <img src="assets/hero.svg" width="100%" alt="cairn — Claude's plan, stone by stone">
</p>

<p align="center">
  <img src="assets/stickers.svg" width="720" alt="zero network calls · no dependencies · automatic light and dark · made with Claude">
</p>

<p align="center">
  <b>On a big request, Claude Code makes itself a list of steps… and keeps it to itself.</b><br>
  Cairn makes it lay that list out, and shows it next to your code as a real roadmap:<br>
  what's done, what's happening, what's left — and when it's your turn.<br>
  And you steer from there: approve the plan, leave a note on a step, add or remove one.
</p>

<p align="center">
  <img src="assets/demo.svg" width="300" alt="Animated demo: a step finishes, the next one starts, Claude waits for a permission, then the summit is reached">
</p>

<table align="center">
  <tr>
    <td align="center"><img src="assets/screen-light.svg" width="200" alt="Roadmap in progress, light theme: the trail, the step in progress, the lines changed at each step"></td>
    <td align="center"><img src="assets/screen-dark.svg" width="200" alt="Roadmap in progress, dark theme, Claude is waiting for a permission"></td>
    <td align="center"><img src="assets/screen-steer.svg" width="200" alt="A plan waiting for your go: a note left on a step, a step removed"></td>
    <td align="center"><img src="assets/screen-history.svg" width="200" alt="History tab: past roadmaps by day, searchable"></td>
  </tr>
  <tr>
    <td align="center"><b>On the trail</b><br><sub>where Claude is, what each step changed</sub></td>
    <td align="center"><b>Claude is waiting for you</b><br><sub>sticker, status bar, notification</sub></td>
    <td align="center"><b>Steer it</b><br><sub>approve, edit, annotate the plan</sub></td>
    <td align="center"><b>History</b><br><sub>every roadmap, kept and searchable</sub></td>
  </tr>
</table>

## How it works

<p align="center">
  <img src="assets/flow.svg" width="100%" alt="1. Claude Code splits the request into steps. 2. The Cairn plugin makes it lay out its roadmap, then tracks it. 3. Your editor shows it live.">
</p>

- **Claude Code** can split work into steps (`TaskCreate`, `TaskUpdate`)… when it thinks of it.
- **The Cairn plugin** gives it the rule at the start of every session. If it chains 3 actions that change something without a roadmap, the 3rd one is blocked — once — while it lays one out. It also notes when Claude is waiting for a permission or has finished its turn.
- **Your editor** draws the roadmap of the session started in the open folder, live:

| | |
| --- | --- |
| **Claude is waiting for you** | Blinking sticker, status bar on alert, notification with "Open terminal". |
| **Before / after** | Under each step, the files it touched. One click opens the *before the step ↔ now* diff. Files changed by a command (`sed -i`, a script…) show up dashed. |
| **The trail** | One stone per step on the way to the summit, "you are here" on the current one, and a rough time left learnt from your past roadmaps. Only what changes moves. |
| **+/− per step** | Each finished step shows the lines Claude's edits changed (the time instead when a command or a subagent may have written files: those are not counted); open it for its files, one click for the *before the step ↔ now* diff. |
| **Steer Claude** | Leave a note on a step, remove a step, add one: Claude gets it at its next action, without being stopped. With the **plan gate** on, Claude stops after making its plan; you edit it, press **Let Claude go**, and it picks up at once with your changes. |
| **Several sessions** | Two Claudes in the same folder? Pills to switch between them. |
| **History** | Every roadmap is kept on your machine, after Claude Code has cleared its own list: search it, reopen it with the time and files of each step, copy it as Markdown for a pull request. A wide view opens in an editor tab. |

## In your editor

| Editor | How | Verified |
| --- | --- | --- |
| **VS Code** | Extension ("Cairn" in the activity bar, history in an editor tab) | Yes: installed and used for real; every release tested |
| **Cursor, Windsurf, VSCodium** | The same extension (`/cairn:setup` installs it in the ones it finds) | No: not tried in these editors yet |
| **Remote VS Code** (SSH, WSL, containers) | The extension runs where Claude Code runs | No |
| **JetBrains** (IntelliJ, PyCharm, WebStorm…) | Native plugin: "Cairn" tool window with an embedded browser | Built by GitHub CI; not run in an IDE yet |
| **Vim** | `:Cairn` opens a side panel updated live (no history yet) | Yes: tested with Vim 9.1 |
| **Neovim** | The same plugin (Vimscript) | No: same code, not tried yet |
| **Zed** | A task that opens the universal view (Zed has no panel for extensions) | No |
| **Everything else** (Sublime Text, Emacs, Xcode…) | **Universal view** in the browser | Yes: tested in a browser |

## Install

**1 · The Claude Code plugin**, from a copy of this repository:

```bash
claude plugin marketplace add ./cairn
claude plugin install cairn@cairn-local
```

**2 · The rest, in one command.** In Claude Code:

```
/cairn:setup
```

It checks that the task tools are enabled (on recent models, Claude Code only provides `TaskCreate` and `TaskUpdate` with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`), that the copy of the plugin Claude Code runs is up to date (it copies plugins when installing them), installs the extension in VS Code, Cursor, Windsurf or VSCodium if they are there, and imports the roadmaps still in Claude Code's transcripts into the history. It changes nothing without your consent. Then restart Claude Code.

<details>
<summary><b>Other editors</b></summary>

- **Universal view** (any editor): `node cairn/web/serve.js <project folder> --open` opens the roadmap on `http://127.0.0.1:4823`. Read-only, reachable from your machine only; clicking a file copies its path. `--lang fr` for French.
- **JetBrains**: *Settings › Plugins › ⚙ › Install Plugin from Disk…* with the release's `cairn-jetbrains-vX.Y.Z.zip`, then the **Cairn** tool window. Needs Node.js; Cairn is looked up in `~/.claude/plugins/local/cairn` (or `CAIRN_HOME`).
- **Vim**: `set runtimepath+=~/.claude/plugins/local/cairn/vim` in your `.vimrc`, then `:Cairn`. The panel is in French when `v:lang` is (or with `let g:cairn_lang = 'fr'`).
- **Neovim**: `vim.opt.runtimepath:append(vim.fn.expand('~/.claude/plugins/local/cairn/vim'))`, then `:Cairn`.
- **Zed**: copy `zed/tasks.json` to `~/.config/zed/tasks.json`, then run the task "Cairn: Claude's roadmap".
- **Without `/cairn:setup`**: `python3 cairn/setup.py` (check), `python3 cairn/setup.py --fix` (repair). The `.vsix` is also attached to every release.

</details>

## Commands

| Where | Command | Effect |
| --- | --- | --- |
| Claude Code | `/cairn:setup` | Checks and repairs the installation. |
| Claude Code | `/cairn:pause` · `/cairn:resume` | Turns blocking off, then back on, for the current session. |
| Claude Code | `/cairn:go` | Says go to a plan waiting for your review, with the changes left in the view. |
| VS Code (palette) | "Cairn: Open the roadmap" · "Open the history" · "Settings" · "Refresh" | The history also opens from the ⟲ button of the view. |
| Vim / Neovim | `:Cairn` | Opens or closes the panel. |

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `cairn.accent` · `cairn.pop` (VS Code) | blue · pink | Colors of the step in progress and of the stickers. |
| `cairn.staleHours` (VS Code) | `2` | Past this, a roadmap is greyed out as old. |
| `cairn.notifications` (VS Code) | on | Notification when Claude is waiting for you. |
| `cairn.language` (VS Code) | `auto` | English or French, following VS Code. |
| `CAIRN_THRESHOLD` (Claude's environment) | `3` | Actions allowed before the roadmap is required. |
| `CAIRN_HISTORY_DAYS` (Claude's environment) | `90` | How long past roadmaps are kept. |
| `cairn.planGate` (VS Code) · `CAIRN_PLAN_GATE=1` (Claude's environment) | off | Claude stops after making its plan, until you say go. |
| `CAIRN_GATE_WAIT` (Claude's environment) | `600` | Seconds Claude waits for your go before simply ending its turn (then any message, or `/cairn:go`, carries it). |
| `window.autoDetectColorScheme` (VS Code) | off | On, VS Code's theme — and so Cairn's — follows the system. |
| <kbd>Ctrl</kbd>+<kbd>T</kbd> in Claude Code | — | Folds the terminal's task list: the roadmap lives in the editor. |

Turn the plugin off: `claude plugin disable cairn@cairn-local`.

## Under the hood

- **Nothing leaves your machine.** No network calls, no dependencies: plain Python and Node. The universal view only listens on `127.0.0.1` and refuses requests addressed to any other name.
- **Reads the minimum.** Claude Code's task files; in transcripts, only the launch folder, step changes, the *paths* of written files, how many lines each edit added and removed (counted, never kept) and the references of the "before" backups. The backups themselves are only read for the diff you open, read-only.
- **Keeps the minimum.** For each roadmap: step titles, statuses, times and file paths — never the conversation. (Versions 1.4 to 1.5.0 also kept the first line of your request; it is no longer shown and goes with the 90-day cleanup.) In `~/.claude/cairn/history/`, readable by you only, deleted after 90 days; delete the folder to forget everything.
- **Writes the minimum.** That history, a small state file per session in `~/.claude/cairn/` ("waiting", "done", "paused"), your notes and edits for Claude in `~/.claude/cairn/steer/` (readable by you only), and a counter in the temp folder.
- **Steering stays yours.** A note reaches Claude as context, capped at 500 characters, cleaned of control characters, and clearly labelled as coming from you through Cairn; step titles are taken from the roadmap, never from the page. Nothing is sent anywhere else.
- **Locked-down view.** One script, its own, allowed by nonce; no external resource — the brand fonts are embedded; task text is escaped; only files found in the transcript or by git can be opened with a click.
- **Accessible.** Progress and "Claude is waiting for you" are announced to screen readers; visible keyboard focus; contrasts checked automatically; animations off when the system asks.
- **Light.** Re-reads every 2 s in the foreground, every 15 s in the background.
- **Never blocks by mistake.** If the plugin crashes, Claude carries on. In the Claude desktop app, which has its own task list, it stays idle.

<details>
<summary><b>What's in the repository</b></summary>

```
hooks/        Claude Code plugin: cairn.py, hooks.json
commands/     /cairn:setup, /cairn:pause, /cairn:resume, /cairn:go
setup.py      checks and repairs the installation
vscode/       VS Code extension (and forks): extension.js, icons, fonts (media/fonts, OFL licenses), English + French
web/          universal view: serve.js
jetbrains/    JetBrains plugin (Kotlin, built by CI)
vim/          Vim / Neovim plugin
zed/          Zed task
assets/       logo, stamp and README visuals (screens.js regenerates screenshots and demo, and embeds the fonts)
check.py      checks the hooks against fake events
.github/      tests on Linux, macOS and Windows on every push; release on every vX.Y.Z tag
```

</details>

## Tests

```bash
python3 check.py                      # hooks
node vscode/test.js                   # sessions, steps, before/after, signals, rendering, contrasts
node web/test.js                      # universal view
vim -Nu NONE -Es -S vim/test.vim      # Vim plugin
python3 setup.py                      # installation (changes nothing without --fix)
node assets/screens.js                # README screenshots and demo, from the real rendering
```

Releasing: update `CHANGELOG.md` and the version numbers, then push a `vX.Y.Z` tag. GitHub runs the tests, builds the `.vsix` and the JetBrains plugin, and creates the release.

## Known limits

- Used for real on macOS with VS Code. Windows and Linux are covered by automated tests, not by real use yet; on Windows, the hooks look for `python3`, then `python`.
- A named list (`CLAUDE_CODE_TASK_LIST_ID`) with no transcript is not linked to the open folder.
- On older models, where the tools exist without the variable, the fallback blocking stays inactive.
- The "before the step" diff relies on Claude Code's backups; without one, it falls back to the git diff (since the last commit).
- The embedded fonts cover the Latin alphabet; other scripts use the system fonts.
- The history starts with version 1.4; `/cairn:setup` brings back what Claude Code's transcripts still hold (about 30 days). A roadmap is named after its first step.
- The plan gate waits for your go at most `CAIRN_GATE_WAIT` seconds (10 min by default); <kbd>Esc</kbd> in Claude Code stops the wait. A note arrives at Claude's next action: an action already running is not interrupted. Steps cannot be reordered yet.
- The Vim panel shows the roadmap, not the history or the steering.
- Interface languages: English and French. Adding one takes a `T` entry in `vscode/extension.js`, a `package.nls.<lang>.json` file and an `s:T` entry in the Vim plugin.

## Credits

- **Bricolage Grotesque** — © The Bricolage Grotesque Project Authors · **JetBrains Mono** — © The JetBrains Mono Project Authors.
  Both under the [SIL Open Font License 1.1](https://openfontlicense.org), embedded in the extension and in this README's visuals; the license texts are in `vscode/media/fonts/`.

<br>

<p align="center">
  <img src="assets/logo.svg" width="150" alt="Cairn stamp: Claude Code's plan, stone by stone"><br>
  <sub>Code written with the help of Claude (AI).</sub>
</p>

<br>

<p align="center">
  <sub>made by</sub><br>
  <img src="assets/jouanique-industries.webp" width="280" alt="Jouanique Industries — creator's stamp">
</p>
