# secret-vault

Live secrets pasted into prompts (cookies, JWTs, bearer tokens, `ghp_` tokens, root passwords, DSN passwords, AWS keys) used to land in transcripts, briefs and commits. This mod swaps each one for a stable `⟨secret:N⟩` placeholder at `prompt.submit`, before the prompt is queued or stored. The mapping lives only in `$.state` for this session. It is never put in `$.store`, written to disk, logged or toasted.

- **Model:** while the vault is not empty, a short system-prompt section (`prompt.compose`) explains the placeholders. Each prompt that had secrets replaced also gets a one-line context note.
- **Tools:** `tool.call` puts the real values back into tool inputs (Bash, WebFetch, MCP and the rest) just before they run. Inputs of Write/Edit/MultiEdit/NotebookEdit/Agent/Task/SendMessage stay literal, so a brief, a file or a subagent transcript keeps the placeholder. To put a secret in a file, use Bash.
- **Output:** the tool result is masked back to placeholders. The tool's stored record is masked by returning a new `{ result }`, and every stored row is masked by a `session.append` backstop.
- **Transcript:** the assistant's `tool_use` block is stored before `tool.call` runs, so it keeps the placeholder. The rewrite only changes what runs.
- `/vault list` shows each placeholder with its type and a hint: the first 4 characters for values of 12+ characters, otherwise only the length. Note that the model reads command output too. `/vault clear` empties the vault. The status line shows `vault: N secrets`.
- **Fails open:** if detection throws, the prompt goes through unredacted, which is the same as running without the mod. A dropped prompt could lose the user's typed text.

**Limits:** a `.env` file the model Reads is not vaulted. Its values are masked only once they are already in the vault. Secrets typed outside the prompt (permission dialogs, `!` shell, files) are missed, and so are secrets the model generates or prints in encoded form (URL-encoded, base64). The permission dialog and settings PreToolUse hooks see the real, substituted input. Another plugin in the same session can read `$.state`. An errored tool result is answered as `{ isError, result, text }` without `ref`; if the engine refuses that shape, the hook is skipped, and only the `session.append` backstop masks it.
