# stack-blast-radius

This mod pauses a risky infra or database command until you approve it. Each held command opens a "Blast Radius" pane that shows the command, where it would run, and a dry-run preview. Press **1 Proceed** to run it or **2 Cancel** to refuse it. Claude then gets the refusal with a reason. It is adapted from the Blast Radius mod in the Claude Code mods article, for this stack.

| Held | What the pane shows |
|---|---|
| `terraform`/`tofu apply\|destroy` | The workspace, plus the `Plan:` line and resources from `terraform plan -no-color -lock=false` (or `terraform show` for a plan file) |
| `pulumi up\|destroy` | The stack, plus a summary from `pulumi preview` (or `destroy --preview-only`) |
| `gcloud … deploy\|delete`, `gcloud sql … patch`; `aws … delete*\|terminate*`, `aws s3 rm --recursive\|rb` | The gcloud project and account, or the AWS profile and region (plus the object count from `aws s3 ls --summarize`) |
| `kubectl delete\|apply` | The context and namespace, plus `kubectl get -o name` (for delete) or `kubectl diff` (for apply) |
| `docker system prune`; `rm -rf` outside `/tmp` and build folders (`dist`, `node_modules`, `.next`, …) | `docker system df`; the file count and size |
| `DELETE/UPDATE/DROP/TRUNCATE/ALTER` through DB MCP tools (tool name contains mysql, postgres or sql) or `mysql`/`psql` (including `-e`, `-c`, heredocs, `< file.sql`) | Each statement, plus a warning when it has no WHERE or a range WHERE. For MCP tools only, it also shows a live row count from a derived `SELECT COUNT(*) … WHERE <same where>`. That count runs only when the tool is already allowed without a prompt. |

The pane times out after 5 minutes and refuses the command. Pressing Esc on the turn or closing the pane by hand also refuses it. In a `claude -p` session (or any session with no screen), the command is refused at once because nobody can press Proceed. When the pane can't be placed (a narrow terminal), the same view appears above the prompt. Passwords on the command line are masked in the pane.

**This is a safety net, not a permission system.** It reads the command text, so aliases, scripts, `bash -c`, `$(…)` and `xargs` get past it. Use permission rules for a hard block. Equality-WHERE statements are held too, because the brief asked for every destructive statement. The mod fails closed: if it breaks while holding a risky call, that call is refused.
