# turn-done-alert

Tells you when Claude needs you, for when you walk away during a long run.

- A turn of at least `thresholdSeconds` (userConfig, default 60) raises a toast on finish: `Turn done in 3m 12s · 14 tools` (or `Turn ended (error) after ...`). Interrupted turns stay quiet.
- An AskUserQuestion call, or a permission prompt (the classic `Notification` event with `permission_prompt`), toasts `waiting for you: ...`.
- Past 2 minutes, a status-line heartbeat `working 3m · 14 tools` updates every 15 s and clears when the turn ends. Tool counts include subagents' calls.
- Fail-open: it only observes; nothing it does can block a tool call or a prompt.

Limits: no sound. `$.audio.play` needs an asset, URL or bytes and plays nothing on a Linux terminal; `$.audio.speak` needs a platform synthesizer. Toasts stay 30 s but only show on screen. A hot reload mid-turn loses that turn's heartbeat and toast.
