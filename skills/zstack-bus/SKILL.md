---
name: zstack-bus
description: Message bus and task ledger protocol for zstack agents. Use whenever you are a zstack agent (your brief names a run id and an agent id) and need to talk to the manager or a peer, claim or finish a task, hand off to a reviewer or tester, or wait for a reply.
---

# zstack bus protocol

Agents never share conversation history. They share the run ledger: tasks, messages, decisions and artifacts under `$ZSTACK_HOME/runs/<run>/` (default `~/.local/state/zstack`). This state is outside the repo, so it can never be committed.

Your brief gives you a command prefix. Use it for every call, because shell state does not persist between tool calls:

```bash
Z="~/Project/zstack/bin/zstack --run <run> --as <your-id>"
```

## Commands

| Need | Command |
|---|---|
| Read new messages | `$Z msg inbox` (marks read; `--peek` to keep unread) |
| Wait for a reply | `$Z msg wait --timeout 600 --kind findings,answer` (exit 2 on timeout) |
| Message a peer | `$Z msg send --to reviewer-2 --kind review-request --ref t3 --body '...'` |
| Message every agent in a role | `--to role:tester` |
| Message the manager | `--to manager` |
| Long body | `--file /path/to/file.md` (put the file in the run's `artifacts/`) |
| See tasks | `$Z task list` / `$Z task list --ready` |
| Claim a task | `$Z task claim t3` (fails if a dependency is unfinished or another active task owns overlapping paths) |
| Move a task | `$Z task set t3 --state review --reviewer reviewer-2` |
| Finish a task | `$Z task set t3 --state done --evidence '<commands and results>'` (refused without evidence) |
| Log a Jev decision | `$Z decide --question route --choice B --confidence 0.82` |

Read your inbox when you start, after each major step, and before you finish. The manager steers with `kind=steer` messages, and they override your earlier plan.

## Message kinds

| kind | from → to | body |
|---|---|---|
| `task` | manager → agent | the task contract, or a change to it |
| `steer` | manager → agent/role/all | mid-flight correction; obey it |
| `question` | any → manager | a blocking question with options; continue on other work if you can |
| `answer` | manager → agent | the reply |
| `review-request` | worker → reviewer | task id, changed files, how to see the diff, checks already run |
| `findings` | reviewer → worker (cc manager) | numbered findings: severity, file:line, problem, required fix |
| `fix-done` | worker → reviewer | which findings were fixed, how, with new check output |
| `approved` | reviewer → worker + manager | review is clean for this round |
| `test-request` | worker/manager → tester | what to run, against what environment |
| `test-result` | tester → worker + manager | pass/fail table with commands and output excerpts |
| `blocker` | any → manager | what stopped you, the evidence, and what you need |
| `done` | any → manager | your final report |

## Handoff rules

- **Fixes go back to the original executor.** A reviewer sends `findings` to the worker who owns the task, not to a new agent. The worker has the context.
- Address findings by number. For each one you reject, give the evidence. Do not stay silent.
- **Rounds are capped.** If the same property fails review or test twice, stop and send a `blocker` to the manager with both attempts. Do not patch a third time.
- Never edit a file outside your task's owned paths. If you need to, ask the manager with `question`.
- Never paste secrets into a message body. Refer to them as "the token from the user's message".

## Evidence format

Every `done`, `fix-done`, `test-result` and `--evidence` uses this shape:

```
result: <one line>
changed: path:line-range, ...            (or "none")
checks:
  - `<exact command>` -> <pass/fail + key output line>
unverified: <what you could not check and why, or "none">
jev: <question -> choice (confidence), or "none" / "Jev unavailable">
```
