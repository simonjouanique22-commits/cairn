---
description: Check and repair the Cairn installation (task tools, editor extensions)
allowed-tools: Bash(python3:*)
---

Check the Cairn installation for the user.

1. Run `python3 "${CLAUDE_PLUGIN_ROOT}/setup.py"`. If the variable is not substituted, the Cairn plugin folder is given
   in the session start context ("Cairn plugin installed in …").
2. Present the result in the user's language, one line per item, without jargon.
3. If any "✗" remain, list exactly what `--fix` will change (a variable added to `~/.claude/settings.json`, the editor
   extension installed) and ask for their consent.
4. Only after they agree, run the same command with `--fix`, then show the new result.
   If the variable was just added, remind them to restart Claude Code.

Do not change anything beyond what `setup.py --fix` changes.
