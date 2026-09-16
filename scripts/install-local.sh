#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo 'Node.js 22+ not found in PATH.' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo 'npm not found in PATH.' >&2; exit 1; }
MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$MAJOR" -lt 22 ]; then echo 'Node.js 22+ is required.' >&2; exit 1; fi
if [ ! -f "$ROOT/.env" ]; then cp "$ROOT/.env.example" "$ROOT/.env"; fi
chmod 600 "$ROOT/.env"
(cd "$ROOT" && npm run check && npm test)
node "$ROOT/scripts/install-harness.mjs" all
printf 'Prepared DZ23 Subagents at %s\nEdit .env privately and review config/generated before merging the snippets.\nClaude Code: run the command in config/generated/claude_code_add_command.txt (remove the old user-scope entry first when upgrading).\nCodex: replace the existing [mcp_servers.dz23-subagents] table; never add a second one.\nUpgrading: see docs/OPERATIONS.md.\nExisting harness configurations were not modified.\n' "$ROOT"
