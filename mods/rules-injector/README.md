# rules-injector

Puts your zstack standing rules into the system prompt of every request in the session. It exists because rules like "never put anything inside cmd/", "use postgres 18 for uuidv7" and "never commit docs" kept getting forgotten and repeated.

- On `prompt.compose` it adds one `session`-scoped section, `rules-injector:rules`, built from `zstack rule list --repo <session cwd>`. The order is project rules, then global rules, then house rules. Rule-file comments are removed.
- The text is cached. Before each request the mod checks the mtime and size of the files in `$ZSTACK_HOME/rules` and of `house.md`. It runs zstack again only when one of them changes, the cwd changes, or `/rules` changed something. The prompt cache is kept until a rule changes.
- The section is limited to 12,000 characters. When it is longer, the end is cut, so generic house rules go before your own rules. A note says how much was cut.
- `/rules` lists the rules. `/rules add <text>` adds a global rule. `/rules add-project <text>` adds a rule for this cwd. `/rules forget <pattern>` removes rules.

Fail-open: if the hook fails, the prompt is sent as the engine composed it. If a later read fails, the last good rules stay. If `zstack` is not on PATH, nothing is injected and the status line says so once.

Limits: `forget` removes every line that contains the pattern, in every project's file. For that reason, patterns shorter than 4 characters are refused. `house.md` is edited by hand.
