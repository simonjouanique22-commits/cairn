"""python3 setup.py [--fix] — vérifie l'installation de Cairn ; avec --fix, corrige ce qui peut l'être.

Vérifie : la variable des outils de tâches dans ~/.claude/settings.json, l'extension VS Code (installée et à jour),
la ligne des tâches de claude-hud (doublon) et les anciens liens laissés par le renommage.
Code de sortie : 0 si tout est en ordre, 1 sinon.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parent
CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
SETTINGS = CLAUDE_DIR / "settings.json"
VERSION = json.loads((RACINE / "vscode" / "package.json").read_text())["version"]
VSIX = RACINE / "vscode" / "cairn.vsix"
CODE_MAC = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"


def code_cli():
    return shutil.which("code") or (CODE_MAC if Path(CODE_MAC).exists() else None)


def variable_ok():
    try:
        return json.loads(SETTINGS.read_text()).get("env", {}).get("CLAUDE_CODE_ENABLE_TODO_TOOLS") == "1"
    except (OSError, ValueError):
        return False


def poser_variable():
    reglages = json.loads(SETTINGS.read_text()) if SETTINGS.exists() else {}
    reglages.setdefault("env", {})["CLAUDE_CODE_ENABLE_TODO_TOOLS"] = "1"
    SETTINGS.write_text(json.dumps(reglages, indent=2, ensure_ascii=False) + "\n")


def extension_installee(code):
    sortie = subprocess.run([code, "--list-extensions", "--show-versions"], capture_output=True, text=True).stdout
    return next((l.split("@")[1] for l in sortie.splitlines() if l.lower().startswith("local.cairn@")), None)


def installer_extension(code):
    if not VSIX.exists():  # dépôt cloné sans le paquet : on le construit
        subprocess.run(["npx", "--yes", "@vscode/vsce@3", "package", "--no-dependencies", "--allow-missing-repository",
                        "--skip-license", "-o", VSIX.name], cwd=VSIX.parent, check=True, capture_output=True)
    subprocess.run([code, "--install-extension", str(VSIX), "--force"], check=True, capture_output=True)


def main(fix):
    ok = True

    def ligne(bon, texte, conseil=""):
        nonlocal ok
        ok &= bon
        print(("✓ " if bon else "✗ ") + texte + ("" if bon or not conseil else f"  →  {conseil}"))

    if not variable_ok() and fix:
        poser_variable()
    ligne(variable_ok(), "outils de tâches activés (CLAUDE_CODE_ENABLE_TODO_TOOLS=1)",
          "--fix l'ajoute dans ~/.claude/settings.json, puis relancer Claude")

    code = code_cli()
    if not code:
        ligne(False, "VS Code introuvable", "installer VS Code, ou mettre la commande « code » dans le PATH")
    else:
        version = extension_installee(code)
        if version != VERSION and fix:
            installer_extension(code)
            version = extension_installee(code)
        ligne(version == VERSION, f"extension VS Code Cairn {VERSION}" + (f" (installée : {version})" if version and version != VERSION else ""),
              "--fix l'installe (VS Code la charge sans redémarrer)")

    hud = CLAUDE_DIR / "plugins" / "claude-hud" / "config.json"
    try:
        doublon = json.loads(hud.read_text()).get("display", {}).get("showTodos") is True
    except (OSError, ValueError):
        doublon = False
    print("· claude-hud affiche aussi les tâches : `/hud` puis « masque la ligne des todos »" if doublon
          else "✓ pas de doublon dans la ligne de statut")

    ancien = CLAUDE_DIR / "plugins" / "local" / "claude-roadmap"
    if ancien.is_symlink():
        print(f"· ancien lien {ancien} : à supprimer une fois les sessions Claude relancées")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main("--fix" in sys.argv))
