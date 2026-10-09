---
name: zstack-jev
description: Canonical Jev question sets for zstack agents (sizing, routing, loop control, finding triage, delegated approval, completion). Use when a zstack agent reaches a fork with two or more plausible options, or must judge completion, scope or whether a review finding is real.
---

# Jev in zstack

Jev (`~/.local/bin/jev`) makes bounded judgments. You do the reasoning. Tools settle facts. Follow the global Jev rules in CLAUDE.md / AGENTS.md. This file only fixes the **exact questions** so every agent asks them the same way and the run log can be compared.

Rules recap:
- Put researched evidence in `state`, mark your own conclusions as `proposal`, and redact secrets.
- One judgment per question. Batch independent questions in one call.
- Act thresholds:
  - local and reversible: ≥ 0.6
  - outward-facing: ≥ 0.9, and confirmation rules still apply
  - below 0.6, or the top two options within 0.15: gather evidence once, then ask the user
  - a `noul` between 0.35 and 0.65 is unresolved
- If Jev errors, it is not approval. Say `Jev unavailable` and take the stricter path. Headless Codex agents get network access for Jev through the zstack launch template.
- Log every decision that changed what you did: `$Z decide --question <id> --choice <x> --confidence <c>`.

## size: manager, start of a run
Use `$Z size` (it builds the payload, maps tier to counts, and logs the decision). Its questions are `intent` (choice), `tier` (choice), and the nouls `risky`, `ambiguous` and `ui`.

## route: manager, per task when the default role model may not fit
```json
{"state":{"task":"<title + acceptance>","evidence":{"files":12,"languages":["go"],"security_sensitive":false,"prior_attempts":0},
  "candidates":{"sonnet":"claude sonnet in-session, mid-tier","opus":"claude opus, strongest, expensive"},
  "policy":"only models on this run's host harness (here: Claude); lowest model that is enough; escalate only on evidence; user pins override"},
 "questions":{"route":{"type":"choice","instructions":"Which candidate is the lowest one likely to complete `task` correctly given `evidence`?","criteria":{"sonnet":"...","opus":"...","none":"Not enough evidence"}}}}
```

## loop: manager after each wave, or any agent after a failed attempt
```json
{"state":{"task":"...","attempts":2,"last_checks":"go test ./league/... FAIL: TestPromotion (expected 3 got 2)","diff_summary":"...","review_open":["F2 high: race in cache"]},
 "questions":{"next":{"type":"choice","instructions":"What should happen next for `task`?","criteria":{
   "continue":"Progress is real and the next step is clear; keep going",
   "retry":"A specific, different fix is evident from `last_checks`; retry once with it",
   "debug":"The cause is unknown; hand to a debugger agent for root-cause diagnosis",
   "escalate":"Repeated failure or a security/architecture concern; move to a stronger model",
   "ask_user":"Blocked on a decision or access only the user has",
   "complete":"Acceptance criteria are met with evidence"}}}}
```

## finding: reviewer before sending, or worker before rejecting
Ask once per finding batch, with one noul per finding:
```json
{"state":{"diff_excerpt":"...","finding":"F3: handler drops ctx cancellation","evidence":"handler.go:88 uses context.Background()"},
 "questions":{"real":{"type":"noul","instructions":"Is `finding` a real defect in `diff_excerpt` (not style, not speculation) given `evidence`?"},
              "in_scope":{"type":"noul","instructions":"Is fixing `finding` within the task's requested scope?"}}}
```
Send only findings with `real` ≥ 0.65. Mark `in_scope` < 0.35 as "out of scope, reported only".

## approve: manager in delegated-approval mode
Use one `choice` per planner question. The criteria are the planner's lettered options, plus `none`. Put the planner's recommendation in state as `proposal`, along with the evidence it cites. Log each answer and include them in the final decisions table.

## scope: reviewer/verifier
```json
{"questions":{"surface":{"type":"noul","instructions":"Does the diff add a new method, endpoint, table, mode, infra resource or file the request did not ask for?"},
              "removal":{"type":"noul","instructions":"Does the diff delete or replace existing code or UI the request did not ask to remove?"},
              "contract":{"type":"noul","instructions":"Does the diff change an API response shape, query result or other external contract?"}}}
```

## complete: manager before the final report, and every agent before `done`
```json
{"state":{"request":"<original user request>","result":"<summary>","evidence":"<checks + outputs>","diff_stat":"..."},
 "questions":{"answers":{"type":"noul","instructions":"Does `result` do what `request` asked?"},
              "backed":{"type":"noul","instructions":"Is every claim in `result` backed by `evidence` (tests, command output, code read)?"},
              "scoped":{"type":"noul","instructions":"Does `result` stay within what `request` asked, with no unrequested changes?"}}}
```
All three must be ≥ 0.65 to report done. Otherwise fix it, or report it with the gap labeled.
