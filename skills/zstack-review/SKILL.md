---
name: zstack-review
description: Review rubric for zstack reviewers and verifiers covering correctness, scope/minimal surface, contracts and breaking changes, security, reuse, and test honesty. Use when reviewing a worker's diff, auditing code, or doing the final verification pass.
---

# zstack review rubric

Review the **diff against the task contract and the original request**, not against your taste. Read the changed code and enough of its callers to judge it. Run what you can (tests, type check, a curl, a query) instead of guessing.

## How to get the diff
- `git diff` for unstaged changes, `git diff --staged`, or `git diff <base>...HEAD` when the worker committed.
- Add untracked files: `git ls-files --others --exclude-standard`.
- Limit yourself to the task's owned paths. Flag any change outside them as a scope finding.

## Check, in this order

1. **Scope and surface** (the user's top complaint):
   - Does the diff add a method, endpoint, Lambda, table, mode, DB, infra or config that wasn't requested?
   - "Optimize X" has to change X, not add `X_v2` or skip X.
   - Was existing code, UI or files deleted or replaced without being asked?
   - Was a compat shim, `reserved` field or legacy alias added on in-development work?
2. **Correctness.** Does it do what the acceptance criteria say? Check edge cases, error paths, concurrency, nil/empty handling, time zones, off-by-one.
3. **Cause vs. symptom.** Is an error suppressed, a warning silenced, a flag special-cased or a test skipped instead of fixed?
4. **Contracts.** Look for a changed response shape, status code, query semantics or migration. If there is one, the task must say so. If it doesn't, that's a blocking finding. Note what FE/mobile would need to change.
5. **Reuse.** Does it duplicate an existing utility, component, middleware or stdlib function? Hand-rolled code where a library or stdlib call exists?
6. **Security.**
   - injection (SQL, shell, path)
   - authz checks on new or changed routes
   - secrets in code, logs or committed text
   - unsafe deserialization
   - SSRF
   - over-broad IAM
7. **Data and migrations.**
   - Was an existing migration edited after it has run? It needs a new migration instead.
   - Data-changing SQL must be scoped.
   - Postgres 18 has native `uuidv7()`, so no custom function.
8. **Tests and evidence.**
   - Do the tests exercise real behavior (real containers, real DB), or only mocks?
   - Are the claimed check outputs actually reproducible?
   - Hardcoded or mock data in shipped code?
   - Tests without timeouts?
9. **House rules.** Check every rule in the brief: no Alpine, nothing under `cmd/`, no committed docs, no co-author line, and so on.

## Findings format (send to the task owner, cc manager)

```
F1 [blocking|major|minor] path/to/file.go:88 — <what is wrong, concretely>
   evidence: <code excerpt, command output or query result>
   fix: <the required change, in one line>
```

- Blocking means wrong behavior, broken contract, a security issue, out-of-scope surface or a fake test. Anything blocking keeps the task out of `done`.
- No style nits unless they break a repo convention the code clearly follows.
- Run the Jev `finding` question (zstack-jev) on the batch. Drop findings whose `real` score is below 0.65.
- When clean, send `approved` with the checks you ran. "LGTM" without checks is not a review.

## Personas (the manager sets one with `--persona`)

| persona | extra focus |
|---|---|
| code | correctness, reuse, tests |
| architecture | boundaries (no cross-domain tables, e.g. user_profile in league), coupling, ADR fit |
| security | §6 in depth, authn/z, secret handling, input validation |
| contract | response parity with the previous version or the master branch, FE/mobile impact list |
| scope | §1 only, very strict; also checks nothing was committed or pushed against policy |
| infra/SRE | IAM least privilege, cost, timeouts vs. platform limits (Lambda 30s via API GW), image base |
