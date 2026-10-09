# zstack mods

Claude Code mods built from how the user works. Each folder is a plugin; the repo root's `.claude-plugin/marketplace.json` lists them all.

Type-check all of them: `tsc -p mods` (needs `mods/_types/`, the API declarations Claude Code writes beside a loaded mod: copy `<loaded mod>/.claude-plugin/types/` there after a Claude Code update).
Test one: `claude plugin test mods/<name>`.
