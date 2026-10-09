# loop-breaker

Sessions kept getting stuck on one failed fix, repeated 5+ times ("still same ahh", "oof, same", about 40 pasted logs in one session) with no diagnosis. This mod notices when the same failure comes back and tells Claude to stop patching and diagnose.

**Bash failures (`tool.call`).** When a call fails, the mod builds a signature: the command head (`pnpm test`, `python pytest`) plus the first error line, with paths, numbers, hashes and long tokens stripped. It counts each signature in `$.state`.
- 2nd time: a toast, plus a hidden user-role row (`$.session.append`, into the subagent's loop when a subagent made the call). The row tells Claude to reproduce, list hypotheses with discriminating checks, find the root cause with evidence, and only then fix.
- 3rd time and after: the status line reads `loop: same failure Nx — diagnose, don't patch`.
- When the same command head succeeds later, its signatures reset.
- Runs the user interrupted or refused do not count.

**Pasted errors (`prompt.submit`).** Error lines in a prompt are compared with the last pasted error. If at least half of them recur, or the prompt is a short "still same" or "oof, same", the prompt gets the same diagnosis note as `context`.

**Fails open.** It only adds advice, so a broken hook just lets the call or prompt through.

**Limits:** exit-0 commands that print errors (for example `cmd | tail`) are not counted. The same bug can still escape a signature if the failing command or its first error line changes. Only the last pasted error is remembered. The `session.append` row is written before the engine stores that call's tool result. The types do not document how the two rows are ordered, so this needs checking in a live session; the result's `context` would be the ordering-safe alternative.
