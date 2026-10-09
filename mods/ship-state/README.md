# ship-state

One line above the prompt: `main ↑2 ↓0 · +1 ~3 ?2 · ✓ go test ./... 4m ago`.

Why: answers "already pushed to main?", "udah commit push belom?" and "did the tests pass?" at a glance instead of asking.

- Branch, ahead/behind its upstream (`no upstream` when none; amber while unpushed), staged `+` / modified `~` / untracked `?` / conflicted `!` counts, or `clean`.
- Git is read with `git --no-optional-locks status --porcelain=v2 --branch` at session start, after each main turn, and after any Bash call that runs `git`.
- Last test result: Bash calls whose command (any `&&`/`;`/`|` segment, after wrappers like `rtk`, `npx`, `uv run`, `FOO=1`) starts with go test, pytest, unittest, npm/pnpm/yarn/bun test, vitest, jest, cargo test, make test, mvn/gradle test, deno test.
- Narrow terminals drop the test command first, then the test part; the branch part stays.
- Fail-open: it only observes; any error leaves the tool call and band untouched.

Limits: pass/fail is the Bash call's exit status, so `go test | tail` reports tail's. Git commands you run yourself outside Claude refresh only at the next turn end. Remote state (CI, deploys) is not checked.
