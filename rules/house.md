# House rules

These rules come from 10,000+ of the user's prompts across five harnesses. They apply to every agent, every run.

## Scope
- Do only what the task asks. A question gets an answer, a plan request gets a plan, a review request gets findings. None of them gets code edits.
- "Optimize X" means improve the existing X. Do not add a parallel method, endpoint, Lambda, table, mode, database, infra resource or naming scheme. Do not skip or remove X either.
- Reuse what exists (utilities, components, word lists, middleware, stdlib) before writing new code. Search first.
- Never delete or rewrite code, UI elements or files outside your task. If you think something should go, report it.
- Fix the cause. Do not suppress an error, swallow a warning, special-case a flag (`is_live = 1`) or leave a TODO hack.
- Keep response shapes and existing query behavior unless the task says to change them. If you change a contract, say so explicitly.
- In-development work needs no backward-compatibility shims (`reserved` fields, legacy aliases) unless asked.

## Evidence
- Never state a fact a tool can check without checking it. Use DB MCP (with a timeout), curl, logs, `git`, tests, the docs or a web search. Never ask the user for something you can fetch.
- Claims like "dead code", "unused", "passes", "fixed" or "no breaking change" need proof: a file:line, a command and its output, or a query result.
- Run it for real: tests with timeouts, the real dev server or e2e against real containers, a browser check for UI. Mocks and hardcoded data are not evidence and must not ship.
- If you could not verify something, label it `unverified` and say why.

## Git and files
- Never commit docs, plans, specs, ADR drafts or agent notes unless told to. Plans live in the zstack run directory, not the repo.
- Never commit, push, rebase, amend, tag or open a PR unless the run's git policy or the user says so. When committing: small commits per concern, `type(scope): msg`, only this run's changes, no co-author line.
- Work on the current branch. No worktree unless the run policy says `per-writer`.
- Do not touch files the user is editing or has staged. If the tree is dirty with unrelated changes, leave them alone and report them.
- No local paths, brand names or secrets in committed text.

## Safety
- Secrets, cookies, JWTs, DSNs and passwords the user pasted may be used at runtime but never copied into messages, briefs, logs, commits or Jev state.
- Deploys, production or console changes, data deletion, external messages and paid resources need explicit user authorization for this run. Prepare the exact command and stop.
- SQL that changes data starts with a scoped `SELECT` dry run and targets only the rows in question.

## Stack defaults (unless the repo says otherwise)
- Containers: Debian or distroless, never Alpine. Dev shells via `nix develop` when a flake exists.
- Postgres 18: use native `uuidv7()`. Do not add an SQL function for it.
- Migrations: edit a migration in place only if it has never run anywhere; otherwise add a new one.
- Go: no code under `cmd/`; `main.go` at the repo root; flat packages, no interface abuse; testify + testcontainers for tests.
- Frontend: avoid `useEffect` when a derived value or event handler works; no new dependency for something small enough to write.
- Don't `go install` or globally install tools without asking.

## Output
- Terse. Lead with the result. Tables for comparisons and change lists. Full endpoint paths and ready-to-run commands with real values, no placeholders.
- Reply in the user's language for chat (English or Indonesian). Code, identifiers, docs and ADRs stay in English. Never summarize in the data's language (Dutch, German).
