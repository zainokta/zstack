#!/usr/bin/env bash
# Link zstack into PATH and the shared skills dir. Never overwrites existing files.
#   ./install.sh                 bin + skills
#   ./install.sh --codex-agents  also generate ~/.codex/agents/zstack-<role>.toml
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)

link() { # link <target> <name>
  if [ -e "$2" ] || [ -L "$2" ]; then echo "skip  $2 (exists)"; else ln -s "$1" "$2"; echo "link  $2"; fi
}

mkdir -p "$HOME/.local/bin" "$HOME/.agents/skills"
link "$root/bin/zstack" "$HOME/.local/bin/zstack"
for d in "$root"/skills/*/; do
  link "${d%/}" "$HOME/.agents/skills/$(basename "$d")"
done

if [ "${1:-}" = "--codex-agents" ]; then
  mkdir -p "$HOME/.codex/agents"
  python3 - "$root" <<'EOF'
import json, re, sys, tomllib
from pathlib import Path
root = Path(sys.argv[1])
cfg = tomllib.loads((root / "config/zstack.toml").read_text())
for f in sorted((root / "agents").glob("*.md")):
    role = f.stem
    if role == "manager":
        continue
    text = f.read_text()
    desc = re.search(r"^description: (.*)$", text, re.M).group(1)
    body = re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.S).strip()
    model = cfg["hosts"]["codex"]["roles"][role]["model"]
    out = Path.home() / f".codex/agents/zstack-{role}.toml"
    if out.exists():
        print(f"skip  {out} (exists)")
        continue
    body += "\n\nFollow the zstack-bus skill. Your brief gives the run id and your agent id."
    out.write_text(f'name = "zstack_{role}"\ndescription = {json.dumps(desc)}\nmodel = "{model}"\n'
                   f'developer_instructions = """\n{body.replace(chr(34)*3, chr(39)*3)}\n"""\n')
    print(f"write {out}")
EOF
fi
echo "done. start the manager with: zstack   (or: zstack --host codex|omp|pi|opencode)"
