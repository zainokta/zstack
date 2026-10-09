# git-guard

Stops Claude from running git operations you didn't ask for in your latest prompt. It exists because of complaints like "stop committing the docs", "just push, why rebase", "commit all, I said all" and "don't add yourself as co-author".

- `git push` runs only if your latest prompt says push, ship or deploy. A force push needs "force". A rebase (including `pull --rebase`), `commit --amend`, `reset --hard`, `clean -f` and `checkout -- .`/`restore .` each need their own words.
- `git add -A`/`.`/`--all` and `git commit -a` need "all" or "semua". Otherwise Claude is told to stage explicit paths.
- `git commit` checks the index, plus anything the same command line stages first. If it would commit `docs/**`, `plans/` or `specs/` Markdown, ADRs, `*handover*`, `CLAUDE.md` or `AGENTS.md`, it is refused unless the prompt mentions docs, readme or ADR, or names the file.
- "don't do any git command" refuses every git write for that turn. Reads such as `git status` still run.
- It strips Claude's `Co-Authored-By` trailer and the "Generated with Claude Code" line from commit and PR messages. It also empties the engine's commit and PR attribution text. This stays on even while the guard is paused.
- `/git-guard off` pauses the guard for the session. `/git-guard on` turns it back on.

Your latest prompt is the last one you typed or sent from your phone. Scripts (`claude -p`), notifications and other sessions don't count. Negations are read only roughly: "why rebase" and "don't push" don't count as asking, but other phrasings can.

The guard fails closed: if its own check breaks, the git command is refused (other commands still run). It reads the command text only, so aliases, scripts and `bash -c` get past it. It is a safety net, not a permission system.
