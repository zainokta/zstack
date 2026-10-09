# intent-gate

Stops the agent from editing code when you only asked a question, a plan or a review ("review it, don't execute", "I only want the docs").

- On each prompt you write (terminal, Remote Control or `claude -p`), Jev classifies the intent: question, plan, review, execute, ops or none. The previous turn's intent, prompt and reply tail go along as evidence, so "continue", "1. A 2. yes" and "ok go" follow the thread. Secrets (JWTs, bearer tokens, passwords, DSNs, cookies, API keys, private keys) are redacted first, because Jev is an external API.
- The status line shows `intent: <intent>`.
- On question, plan and review turns, Edit, Write, MultiEdit, NotebookEdit and git writes in Bash (add, commit, push, reset, stash, rebase, merge, checkout --, restore, clean and similar) are denied. The deny reason tells the model to answer or plan in text and ask you to say "go". Plan turns can still write to plan paths: `/plans/`, `/specs/`, `/adr/`, `docs/superpowers`, `~/.local/state/zstack` and `/tmp`.
- `/intent execute|question|plan|review` sets the intent for the running turn, or for your next prompt when no turn is running. `/intent off` turns the gate off for this session, and `/intent auto` turns it back on.

**Fails open.** If Jev is unavailable, times out (8 s) or answers with confidence below 0.6, nothing is blocked. The status line then shows `intent: ? (Jev unavailable)` or `intent: ? (unsure, …)`. If the guard throws, the call goes through. A wrong block costs you a turn, and a missed block costs no more than running without the mod. Jev needs `TYPESAFE_API_KEY` in the environment Claude Code starts with. Without it, a session the desktop app starts fails open.

**Limits.** Under `claude -p` nobody can say "go", so a denied edit stays denied and the model reports in text. It never waits for input. File writes through Bash (`sed -i`, `cat >`, scripts) are not gated. The classifier adds one Jev round trip (about 0.4 s) before each prompt enters.
