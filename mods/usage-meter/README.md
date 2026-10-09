# usage-meter

A status line under the prompt: `ctx 42% 84k/200k · 5h 63% · 7d 12%`.

Why: to see how full the context is and how much of the 5-hour and weekly rate limits is gone before starting an expensive run.

- All percentages are **used**, not remaining. `ctx` is the last response's input tokens over the model's window.
- Rate-limit windows come from `$.session.usage()` and appear only on a subscription after the first API response (`spend` for a gateway spend limit).
- Updated at session start and after every turn (subagent turns included).
- Fail-open: a failed usage read is logged to the debug log and the line keeps its last value.

Limits: no figures until the first response (`ctx -- --/200k`); session cost is not shown.
