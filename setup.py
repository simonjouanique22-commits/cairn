"""python3 setup.py [--fix] — checks the Cairn installation; with --fix, repairs what it can.

Checks: the task tools variable in ~/.claude/settings.json, the plugin copy Claude Code runs (same version as this
folder), the extension in every VS Code family editor found (VS Code, Cursor, Windsurf, VSCodium), the roadmap
history (--fix imports past roadmaps from Claude Code's transcripts), claude-hud's task line (duplicate) and links
left over by the rename. Reminds how to open Cairn in other editors. Exit code: 0 when everything is fine, 1 otherwise.
"""
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "hooks"))
from cairn import HISTORY, WRITE_TOOLS, record, save_history  # noqa: E402
CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
SETTINGS = CLAUDE_DIR / "settings.json"
VERSION = json.loads((ROOT / "vscode" / "package.json").read_text(encoding="utf-8"))["version"]
VSIX = ROOT / "vscode" / "cairn.vsix"
PLUGIN_VERSION = json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))["version"]
LOCAL = os.environ.get("LOCALAPPDATA", "")
# VS Code family editors: command, then usual locations (macOS, Windows).
EDITORS = {
    "VS Code": ["code", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
                rf"{LOCAL}\Programs\Microsoft VS Code\bin\code.cmd"],
    "Cursor": ["cursor", "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
               rf"{LOCAL}\Programs\cursor\resources\app\bin\cursor.cmd"],
    "Windsurf": ["windsurf", "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf",
                 rf"{LOCAL}\Programs\Windsurf\bin\windsurf.cmd"],
    "VSCodium": ["codium", "/Applications/VSCodium.app/Contents/Resources/app/bin/codium",
                 rf"{LOCAL}\Programs\VSCodium\bin\codium.cmd"],
}


def find(candidates):
    for c in candidates:
        found = shutil.which(c) if os.sep not in c and "/" not in c else (c if Path(c).exists() else None)
        if found:
            return found
    return None


def variable_ok():
    try:
        return json.loads(SETTINGS.read_text(encoding="utf-8")).get("env", {}).get("CLAUDE_CODE_ENABLE_TODO_TOOLS") == "1"
    except (OSError, ValueError):
        return False


def set_variable():
    settings = json.loads(SETTINGS.read_text(encoding="utf-8")) if SETTINGS.exists() else {}
    settings.setdefault("env", {})["CLAUDE_CODE_ENABLE_TODO_TOOLS"] = "1"
    SETTINGS.write_text(json.dumps(settings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def plugin_version():
    """Version of the Cairn copy Claude Code runs (it copies plugins when installing them)."""
    try:
        d = json.loads((CLAUDE_DIR / "plugins" / "installed_plugins.json").read_text(encoding="utf-8"))
        entries = (d.get("plugins") or d).get("cairn@cairn-local") or []
        return entries[0].get("version") if entries else None
    except (OSError, ValueError, AttributeError, IndexError):
        return None


def update_plugin():
    claude = shutil.which("claude")
    if claude:
        subprocess.run([claude, "plugin", "marketplace", "update", "cairn-local"], capture_output=True)
        subprocess.run([claude, "plugin", "update", "cairn@cairn-local"], capture_output=True)


def stamp(ts):
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def import_history(dry=False):
    """Rebuilds the roadmaps of past sessions from Claude Code's transcripts (it keeps them about 30 days), once per
    session, with the hook's own logic. Returns how many sessions were (or, dry, would be) imported."""
    n = 0
    for f in (CLAUDE_DIR / "projects").glob("*/*.jsonl"):
        if (HISTORY / f"{f.stem}.json").exists():
            continue
        raw = f.read_bytes()
        if b'"TaskCreate"' not in raw:
            continue
        h, pending, cwd = {"roadmaps": []}, {}, None
        for line in raw.decode("utf-8", "replace").splitlines():
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if not isinstance(m, dict) or m.get("isSidechain"):
                continue
            cwd = cwd or m.get("cwd")
            content = (m.get("message") or {}).get("content")
            blocks = [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []
            t = stamp(m.get("timestamp"))
            if t is None:
                continue
            for b in blocks:
                if b.get("type") == "tool_use":
                    name, inp = b.get("name"), b.get("input") or {}
                    if name == "TaskCreate":
                        pending[b.get("id")] = inp
                    elif name == "TaskUpdate":
                        record(h, "update", t, id=inp.get("taskId"), status=inp.get("status"), subject=inp.get("subject"))
                    elif name in WRITE_TOOLS and h["roadmaps"] and isinstance(inp.get("file_path") or inp.get("notebook_path"), str):
                        record(h, "file", t, path=inp.get("file_path") or inp.get("notebook_path"))
                elif b.get("type") == "tool_result" and b.get("tool_use_id") in pending:
                    inp, res = pending.pop(b["tool_use_id"]), m.get("toolUseResult")
                    tid = res["task"].get("id") if isinstance(res, dict) and isinstance(res.get("task"), dict) else None
                    found = re.search(r"#(\d+)", json.dumps(b.get("content")))
                    tid = tid or (found and found.group(1))
                    if tid:
                        record(h, "create", t, id=tid, subject=inp.get("subject", ""))
        if h["roadmaps"]:
            n += 1
            if not dry:
                h["cwd"] = cwd
                save_history(f.stem, h)
                os.utime(HISTORY / f"{f.stem}.json", (f.stat().st_mtime,) * 2)  # ages like the session it comes from
    return n


def installed_version(cli):
    out = subprocess.run([cli, "--list-extensions", "--show-versions"], capture_output=True, text=True).stdout
    return next((l.split("@")[1] for l in out.splitlines() if l.lower().startswith("local.cairn@")), None)


def build_vsix():
    sources = [ROOT / "vscode" / f for f in ("extension.js", "package.json")]
    if VSIX.exists() and VSIX.stat().st_mtime >= max(f.stat().st_mtime for f in sources):
        return  # package up to date
    npx = shutil.which("npx")
    if not npx:
        raise RuntimeError("npx not found: install Node.js, or use the .vsix attached to the GitHub release")
    subprocess.run([npx, "--yes", "@vscode/vsce@3", "package", "--no-dependencies", "--allow-missing-repository",
                    "--skip-license", "-o", VSIX.name], cwd=VSIX.parent, check=True, capture_output=True)


def main(fix):
    ok = True

    def line(good, text, advice=""):
        nonlocal ok
        ok &= good
        print(("✓ " if good else "✗ ") + text + ("" if good or not advice else f"  →  {advice}"))

    if not variable_ok() and fix:
        set_variable()
    line(variable_ok(), "task tools enabled (CLAUDE_CODE_ENABLE_TODO_TOOLS=1)",
         "--fix adds it to ~/.claude/settings.json, then restart Claude")

    installed = plugin_version()
    if installed and installed != PLUGIN_VERSION and fix:
        update_plugin()
        installed = plugin_version()
    if installed:
        line(installed == PLUGIN_VERSION, f"Cairn {PLUGIN_VERSION} plugin in Claude Code" + (f" (running: {installed})" if installed != PLUGIN_VERSION else ""),
             "--fix updates it (claude plugin update cairn@cairn-local), then restart your Claude sessions")
    else:
        line(False, "Cairn plugin not installed in Claude Code",
             f"claude plugin marketplace add \"{ROOT}\" then claude plugin install cairn@cairn-local")

    found = {name: cli for name, cands in EDITORS.items() if (cli := find(cands))}
    for name, cli in found.items():
        version = installed_version(cli)
        if version != VERSION and fix:
            build_vsix()
            subprocess.run([cli, "--install-extension", str(VSIX), "--force"], check=True, capture_output=True)
            version = installed_version(cli)
        line(version == VERSION, f"Cairn {VERSION} extension in {name}" + (f" (installed: {version})" if version and version != VERSION else ""),
             "--fix installs it (then reload the window)")
    if not found:
        print("· no VS Code family editor found (VS Code, Cursor, Windsurf, VSCodium)")

    print(f"· other editors (JetBrains, Zed, Sublime…): node \"{ROOT / 'web' / 'serve.js'}\" <project folder> --open")
    print(f"· Vim / Neovim: add \"{ROOT / 'vim'}\" to the runtimepath, then :Cairn")

    todo = import_history(dry=not fix)
    kept = sum(1 for _ in HISTORY.glob("*.json")) if HISTORY.exists() else 0
    print(f"· history: {kept} session(s) kept in {HISTORY}" + (f"; {todo} past session(s) to import (--fix)" if todo and not fix else ""))

    hud = CLAUDE_DIR / "plugins" / "claude-hud" / "config.json"
    try:
        duplicate = json.loads(hud.read_text(encoding="utf-8")).get("display", {}).get("showTodos") is True
    except (OSError, ValueError):
        duplicate = False
    print("· claude-hud also shows the tasks: `/hud`, then ask it to hide the todos line" if duplicate
          else "✓ no duplicate in the status line")

    old = CLAUDE_DIR / "plugins" / "local" / "claude-roadmap"
    if old.is_symlink():
        print(f"· old link {old}: remove it once your Claude sessions have been restarted")
    return 0 if ok else 1


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    sys.exit(main("--fix" in sys.argv))
