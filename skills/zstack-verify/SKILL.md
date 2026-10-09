---
name: zstack-verify
description: Verification ladder and evidence rules for zstack testers, workers and verifiers, covering tests with timeouts, real e2e, browser checks, benchmarks, output parity and live checks. Use when proving that a change works before reporting it done.
---

# zstack verification ladder

"It passes" counts only when you ran it and show the output. Climb as high as the change requires. Report the highest rung you reached, and label everything above it `unverified`.

| rung | what | when |
|---|---|---|
| 1. static | build, type check, lint, `go vet`, `cargo check`, `tsc --noEmit` | always |
| 2. unit | the package's tests, **with a timeout** (`go test -timeout 120s ./pkg/...`, `timeout 300 pnpm test`) | always when tests exist |
| 3. integration / e2e | real containers (testcontainers, docker compose), real DB; no mocks for the thing being tested | DB, API, queue or cross-service changes |
| 4. run it | start the dev server or binary (`nix develop -c …` when a flake exists), hit the endpoint with curl, use real request values from the task | any runtime behavior change |
| 5. browser | Playwright (MCP or script): load the page, click the changed controls, check the console for errors, take a screenshot | any UI change |
| 6. parity / benchmark | old vs. new response diff on the same input; latency table over N runs; compare against the budget (e.g. Lambda behind API GW = 30s) | performance or contract-sensitive work |
| 7. live | staging/dev endpoint, DB row check via MCP, job completion check | only when the run's deploy policy allows it, or the user deployed and asked you to check |

## Rules

- **Timeouts everywhere.** Tests, DB MCP queries and curls (`--max-time`). A hung check is a failure to report, not a reason to wait forever.
- **Separate harness failures from product failures.** A broken test setup (port in use, container pull, missing env) is reported as such. Don't "fix" product code to make a broken harness pass.
- **Don't weaken a test to make it pass.** No skipping, loosening assertions or mocking the unit under test. If a test is wrong, say why with evidence and get the manager's OK.
- **Parity means the same input and a recorded diff.** Save both outputs under the run's `artifacts/` and show the diff summary.
- **Async jobs.** Trigger the job, poll its status with a timeout, then check the stored result (DB row, S3 object). "Triggered" is not "worked".
- **Data safety.** Use a copy or a local emulator (floci, testcontainers) for destructive tests. Never run tests against a production DB.
- **No placeholders.** Commands in reports use real URLs and IDs from the task. Secrets are referred to, never printed.

## Test result format (tester → worker + manager)

```
result: PASS | FAIL (<n> failing)
| rung | command | result | key output |
|---|---|---|---|
| 2 | `go test -timeout 120s ./league/...` | FAIL | TestPromotion: expected 3 got 2 (league_test.go:144) |
harness issues: <none | description>
unverified: <rungs not reached and why>
```
