---
name: zstack-debug
description: Root-cause diagnosis loop for zstack debuggers and operators. Use when a bug, failing test, error log or slow path resists a first fix, when the same property failed twice, or when an ops loop keeps hitting the same error.
---

# zstack debug loop

Patching a third time without a diagnosis is the failure mode this exists to stop.

1. **Reproduce.** Get a command that shows the failure, with a timeout, on demand. Use real inputs from the report or logs. If you can't reproduce it, say so and list what you tried. Don't fix blind.
2. **Collect evidence before theorizing.**
   - the full error and stack
   - the relevant logs (CloudWatch, Cloud Run, container)
   - the DB state via MCP with a timeout
   - `git log -p` on the touched area
   - the previous attempts and their outputs (from the bus: `$Z msg log --kind findings` / `test-result`)
3. **List 2–4 hypotheses**, each with a cheap discriminating check. If choosing which to test first is a real fork, use the Jev `loop` or a `choice` question.
4. **Bisect.** Run the checks and narrow down: add a log line, a debugger breakpoint, a minimal input, or `git bisect` when a known-good revision exists. Remove temporary instrumentation afterwards.
5. **Root cause.** State it in one sentence with file:line and the evidence that proves it.
6. **Fix the cause** in the owner's paths, or hand the diagnosis to the owning worker if you are not the owner. No suppression, special-casing or skip.
7. **Prove it.** The reproduction command now passes and the related tests still pass. For performance work, show before/after numbers.
8. **Prevent recurrence.** Add a regression test when practical. If the bug came from a non-obvious repo rule, propose a one-line rule for `zstack rule add --project`; the manager decides.

Report:
```
root cause: <one sentence> (file:line)
evidence: <command/output proving it>
fix: <what changed> · proof: <repro now passes + suite>
ruled out: <hypotheses and the check that killed each>
```
