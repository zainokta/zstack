# zstack design

## Shape

```
              you
               │  (only talks to the manager)
               ▼
        ┌─────────────┐   jev (size, route, loop, approve, complete)
        │   manager   │◄────────────────────────────────────────────
        └──────┬──────┘
               │ zstack CLI: run ledger · task graph · message bus · caps · briefs · spawn
   ┌───────────┼──────────────┬──────────────┬─────────────┬──────────────┐
 scouts     planner        workers ◄──────► reviewers   testers      verifier / scribe
 (read)     (plan.md)      (own paths)  findings/fix   (ladder)     (final gate / docs)
                               ▲            ▲              │
                               └─ debugger / operator ◄────┘  (reserve slots)
```

- **Host.** By default the manager runs as a Claude Code session agent (`zstack` → `claude --plugin-dir ~/Project/zstack --agent zstack:manager`). Jev chose this hybrid (0.97) over plugin-only or CLI-only. `zstack --host codex|omp|pi|opencode` runs the same manager prompt (agent body + playbook + bus + Jev + git skills + a host note) in another harness, with that host's role profile.
- **Workers run anywhere.** They are either in-session Claude subagents (Agent tool, `zstack:<role>`), or headless processes on codex/omp/pi/opencode/`claude -p` started by `zstack spawn`. Both kinds share the same bus. That is how a Codex reviewer checks a Claude worker.
- **State lives outside the repo** in `~/.local/state/zstack/runs/<run>/`: `meta.json`, `agents.json`, `tasks.json`, `bus.jsonl`, `decisions.jsonl`, `briefs/`, `logs/`, `artifacts/` (plan, last answers, report). Nothing zstack writes can be committed by accident. A crashed session resumes from the ledger.

## Caps

| cap | where | default |
|---|---|---|
| 100 agents per run (manager excluded) | `zstack agent add`, hard-coded ceiling | 100 |
| parallel agents | `agent add` / `agent set running` / `spawn` | 8 (`--max-parallel`) |
| reserve for repair/debug agents | `zstack size` allocation | 10 |
| review rounds per task | `task set --state review` warns past the limit | 3 |
| same property failing | protocol: 2 strikes → blocker → debugger | 2 |

## Sizing: Jev judges, code counts

`zstack size` sends one batched Jev call:
- `intent` (choice): question / plan_only / review_only / execute / ops_loop
- `tier` (choice): solo / pair / squad / team / swarm
- `risky`, `ambiguous`, `ui` (nouls)

Code turns the tier and the manager's count of independent units into role counts:

| tier | workers | reviewers | testers | others |
|---|---|---|---|---|
| solo | 0 (manager inline) | – | – | – |
| pair | 1 | 1 (+1 risky) | – | – |
| squad | ≤4 | 2 (+1) | 1 | ≤2 scouts, verifier |
| team | ≤12 | max(2, w/3) (+1) | max(1, w/4) | ≤4 scouts, planner, verifier, scribe |
| swarm | ≤60 | w/3 (+1) | w/5 | ≤10 scouts, planner, verifier, scribe |

Workers shrink until the total fits `max_agents − reserve`. A user override (`"agents": 5`) drops support roles in this order: scribe → scout → planner → tester → verifier, keeping ≥1 worker and ≥1 reviewer.

Flow comes out of the same call:
- question → `answer`
- plan_only → `plan`
- review_only → `review`
- ops_loop → `ops`
- execute → `plan-gate` when risky, ambiguous or team/swarm; otherwise `direct`
- if Jev is unavailable or unresolved → `ask-user` with `needs_more_evidence`

## Agent-to-agent communication

The bus is an append-only JSONL log with per-agent read cursors and file locking:
- Addresses: an agent id, `role:<role>`, `all`, `manager`.
- Kinds: `task, steer, question, answer, review-request, findings, fix-done, approved, test-request, test-result, blocker, done`.

Peers talk directly. A reviewer sends findings to the worker, and a tester sends results to the worker and cc's the manager. The manager listens on everything and steers. `msg wait` blocks until a matching message arrives, so a reviewer or tester can sit waiting for work, as you asked.

Resuming the original executor for fix rounds:
- in-session Claude agent: the manager SendMessages its recorded agent id ("check inbox")
- headless agent: `zstack spawn <id>` again; the brief is re-rendered with the pending findings

## Task graph

`task add` takes deps, owned paths and acceptance criteria.
- `task claim` refuses unfinished deps and **overlapping paths** among active tasks in the same repo, so parallel writers can't collide.
- `task set --state done` refuses without evidence.
- Multi-repo runs set `--repo` per task.

## Routing defaults (config/zstack.toml)

| role | harness / model | why |
|---|---|---|
| scout | claude / haiku | cheap fan-out reads |
| planner | claude / opus | plan quality matters most |
| worker | claude / sonnet | mid-tier implementer |
| reviewer | **codex / gpt-6-sol** | different family from the workers = real cross-model review |
| tester | claude / sonnet | needs tools, MCPs, Playwright |
| debugger | claude / opus | hard diagnosis |
| operator | claude / sonnet | long tool loops |
| verifier | claude / opus (or `claude-review`) | final independent gate |
| scribe | claude / haiku | docs |

Override per machine in `~/.local/state/zstack/zstack.toml`, or per agent with `agent add --harness/--model`. User pins win. Models are never silently substituted.

To use your Command Code budget, set `worker` to `harness = "omp"`, `model = "commandcode/deepseek/deepseek-v4.1-flash"` (see the agent-stack notes: price it against real usage first).

## Where your existing pieces fit

| existing | in zstack |
|---|---|
| zen-workflow (graph, handoffs, isolated review) | the task graph + evidence-gated handoffs, in a CLI instead of `.agent/` files in the repo |
| herdr-orchestrator | optional: run headless agents inside herdr panes for visibility (not wired by default) |
| Codex luna/sol/astra lanes | `--harness codex --model gpt-6-luna|gpt-6-sol` per agent; the Jev `route` question picks the lowest that is enough |
| `claude-review` | the verifier's final gate |
| pi `worker`/`reviewer` alternation | the worker ↔ reviewer loop, now with peer messaging and round caps |

## Known limits

- Read-only enforcement is real for `claude` (disallowed edit tools) and `codex`. Read-only Codex roles start in the run dir with a `workspace-write` sandbox, so only the bus and Jev log are writable and the repo is not. This was verified live. The exception is repos under `/tmp`, which Codex always allows writing. For omp/pi/opencode, read-only relies on tool allowlists and the prompt.
- Codex sandboxes get `network_access=true` so Jev works inside them (verified: noul 0.96 from a sandboxed reviewer).
- A headless agent gets a fresh context on each re-spawn. Its brief carries the task contract, dependency handoffs and pending findings, but not its previous reasoning.
- `max_parallel` protects rate limits but doesn't know them. Lower it when a provider throttles.
