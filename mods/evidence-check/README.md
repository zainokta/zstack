# evidence-check

Catches replies that claim success when nothing was run ("you said it pass?", "are you lying or hallucinate?").

- During each turn it records which tool calls ran, subagents' calls included. A call counts as a check if it is a test, build, type check, lint, `curl`/`wget` or DB client in Bash (go test, pytest, python -m unittest, npm/pnpm/bun/yarn test, vitest, jest, cargo test/check/build, tsc, ruff, eslint, make test, mvn/gradle test, playwright and more), or an MCP tool whose name looks like a DB, browser, playwright, logging or test tool. A call that was denied does not count.
- When the turn ends, the mod reads the final reply. It skips code blocks, inline code, `>` quotes, quoted strings and hedged sentences ("should pass", "not verified", "belum berhasil"). If the reply still claims success ("tests pass", "passed", "all green", "fixed", "verified", "works now", "no breaking change", "sudah jalan", "berhasil") and no check ran, the mod asks Jev whether the reply really states verified success. If Jev agrees, the mod adds a `system` row to the transcript (the model never reads it) and shows a toast: `evidence-check: the reply claims "<phrase>" but no test or check ran this turn`.
- Turns with no tool calls are checked too, because "fixed, works now" with nothing run is the exact complaint. Jev's question drops recaps of a check from an earlier turn. This was Jev's choice: `check_all` (0.67) over `since_last_change` and `skip`.

**Fails toward showing.** If Jev is unavailable or times out (8 s), the phrase match alone decides. The notice then ends with `(Jev unavailable: phrase match only)`. If the hook throws, nothing is shown and the turn is not affected. Secrets are redacted before the reply goes to Jev.

**Limits.** The mod only checks that a check ran, not that it passed. Only the main loop's final reply is read, and subagent reports are not. A check in a hand-written script (`./run.sh`) is not recognised, so a correct claim after one can still be flagged.
