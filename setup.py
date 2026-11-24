"""python3 setup.py [--fix] — checks the Cairn installation; with --fix, repairs what it can.

Checks: the task tools variable in ~/.claude/settings.json, the extension in every VS Code family editor found
(VS Code, Cursor, Windsurf, VSCodium), claude-hud's task line (duplicate) and links left over by the rename.
Reminds how to open Cairn in other editors. Exit code: 0 when everything is fine, 1 otherwise.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
SETTINGS = CLAUDE_DIR / "settings.json"
VERSION = json.loads((ROOT / "vscode" / "package.json").read_text(encoding="utf-8"))["version"]
VSIX = ROOT / "vscode" / "cairn.vsix"
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
