"""python3 setup.py [--fix] — vérifie l'installation de Cairn ; avec --fix, corrige ce qui peut l'être.

Vérifie : la variable des outils de tâches dans ~/.claude/settings.json, l'extension dans chaque éditeur de la famille
VS Code présent (VS Code, Cursor, Windsurf, VSCodium), la ligne des tâches de claude-hud (doublon) et les anciens liens
laissés par le renommage. Rappelle comment ouvrir Cairn dans les autres éditeurs.
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
VERSION = json.loads((RACINE / "vscode" / "package.json").read_text(encoding="utf-8"))["version"]
VSIX = RACINE / "vscode" / "cairn.vsix"
LOCAL = os.environ.get("LOCALAPPDATA", "")
# Éditeurs de la famille VS Code : commande, puis emplacements habituels (macOS, Windows).
EDITEURS = {
    "VS Code": ["code", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
                rf"{LOCAL}\Programs\Microsoft VS Code\bin\code.cmd"],
    "Cursor": ["cursor", "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
               rf"{LOCAL}\Programs\cursor\resources\app\bin\cursor.cmd"],
    "Windsurf": ["windsurf", "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf",
                 rf"{LOCAL}\Programs\Windsurf\bin\windsurf.cmd"],
    "VSCodium": ["codium", "/Applications/VSCodium.app/Contents/Resources/app/bin/codium",
                 rf"{LOCAL}\Programs\VSCodium\bin\codium.cmd"],
}


def trouver(candidats):
    for c in candidats:
        chemin = shutil.which(c) if os.sep not in c and "/" not in c else (c if Path(c).exists() else None)
        if chemin:
            return chemin
    return None


def variable_ok():
    try:
        return json.loads(SETTINGS.read_text(encoding="utf-8")).get("env", {}).get("CLAUDE_CODE_ENABLE_TODO_TOOLS") == "1"
    except (OSError, ValueError):
        return False


def poser_variable():
    reglages = json.loads(SETTINGS.read_text(encoding="utf-8")) if SETTINGS.exists() else {}
    reglages.setdefault("env", {})["CLAUDE_CODE_ENABLE_TODO_TOOLS"] = "1"
    SETTINGS.write_text(json.dumps(reglages, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def extension_installee(cli):
    sortie = subprocess.run([cli, "--list-extensions", "--show-versions"], capture_output=True, text=True).stdout
    return next((l.split("@")[1] for l in sortie.splitlines() if l.lower().startswith("local.cairn@")), None)


def construire_vsix():
    sources = [RACINE / "vscode" / f for f in ("extension.js", "package.json")]
    if VSIX.exists() and VSIX.stat().st_mtime >= max(f.stat().st_mtime for f in sources):
        return  # paquet à jour
    npx = shutil.which("npx")
    if not npx:
        raise RuntimeError("npx introuvable : installer Node.js, ou prendre le .vsix joint à la release GitHub")
    subprocess.run([npx, "--yes", "@vscode/vsce@3", "package", "--no-dependencies", "--allow-missing-repository",
                    "--skip-license", "-o", VSIX.name], cwd=VSIX.parent, check=True, capture_output=True)


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

    trouves = {nom: cli for nom, cands in EDITEURS.items() if (cli := trouver(cands))}
    for nom, cli in trouves.items():
        version = extension_installee(cli)
        if version != VERSION and fix:
            construire_vsix()
            subprocess.run([cli, "--install-extension", str(VSIX), "--force"], check=True, capture_output=True)
            version = extension_installee(cli)
        ligne(version == VERSION, f"extension Cairn {VERSION} dans {nom}" + (f" (installée : {version})" if version and version != VERSION else ""),
              "--fix l'installe (rechargez ensuite la fenêtre)")
    if not trouves:
        print("· aucun éditeur de la famille VS Code trouvé (VS Code, Cursor, Windsurf, VSCodium)")

    print(f"· autres éditeurs (JetBrains, Zed, Sublime…) : node \"{RACINE / 'web' / 'serve.js'}\" <dossier du projet> --open")
    print(f"· Vim / Neovim : ajouter \"{RACINE / 'vim'}\" au runtimepath, puis :Cairn")

    hud = CLAUDE_DIR / "plugins" / "claude-hud" / "config.json"
    try:
        doublon = json.loads(hud.read_text(encoding="utf-8")).get("display", {}).get("showTodos") is True
    except (OSError, ValueError):
        doublon = False
    print("· claude-hud affiche aussi les tâches : `/hud` puis « masque la ligne des todos »" if doublon
          else "✓ pas de doublon dans la ligne de statut")

    ancien = CLAUDE_DIR / "plugins" / "local" / "claude-roadmap"
    if ancien.is_symlink():
        print(f"· ancien lien {ancien} : à supprimer une fois les sessions Claude relancées")
    return 0 if ok else 1


if __name__ == "__main__":
    for flux in (sys.stdout, sys.stderr):
        try:
            flux.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    sys.exit(main("--fix" in sys.argv))
