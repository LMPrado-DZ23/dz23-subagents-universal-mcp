# DZ23 Subagents Universal MCP

**One project. Multiple models. Shared mission memory.**

[Português / full guide](README.md) · [Install](docs/INSTALL_ANY_HARNESS.md) · [Tools](docs/TOOLS.md) · [Operations](docs/OPERATIONS.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md)

Self-hosted MCP router for delegating text/code tasks to AI models, running parallel
specialists and keeping explicit, versioned mission memory that another harness can resume.
Version 4.1.0 is an **engineering preview**, MIT licensed, Node.js 22+, no npm dependencies.
The linked guides are in Portuguese.

Workers return text/code. They do not execute shell commands, edit repositories, use browsers
or run tests; the host harness owns those operations. Handoff works through persisted state,
not hidden model thoughts or unrecorded client conversations.

## What 4.1.0 provides

- **Project and missions (4.1.0)**: read-only access to allowed folders (`DZ23_WORKSPACE_ROOTS`) with credential files blocked and secrets masked, hardened read-only Git, project context attached to prompts, asynchronous missions, leases between harnesses, MCP resources and prompts, hash-chained audit log.
- **MCP**: the 11 tools of 4.0.0 plus 11 new ones, protocol revisions 2025-11-25 and 2025-06-18, enforced closed schemas with
  bounded inputs, standard JSON-RPC errors, tool execution errors with `request_id`. stdio runs up to
  `DZ23_STDIO_MAX_INFLIGHT` requests concurrently and honors `notifications/cancelled`.
- **HTTP (opt-in)**: bearer token from env or file (required even on loopback), optional per-token
  scopes (SHA-256 digests), Host header/Origin and cross-site (`Sec-Fetch-Site`) checks, per-process
  rate limiting with 429 + Retry-After, auth-failure throttling that never locks out valid tokens,
  billable REST routes only via POST with confirmation, body/time/in-flight limits, graceful shutdown.
  No SSE, sessions or OAuth.
- **Providers**: OpenAI-compatible and Anthropic Messages adapters, classified provider errors
  (including `context_length_exceeded`, which fails over without cooldown), bounded retries only for
  rate limits/timeouts/unavailability, no failover for invalid requests, per-kind cooldowns optionally
  shared between processes, `verify_model` and `health_check` (both require `confirm_billable: true`).
- **Routing**: `first`, `round_robin`, `provider_diversity`, `model_diversity`, `cost_optimized`,
  `latency_optimized`; requested vs effective strategy and observed diversity are reported.
  `consensus` uses distinct targets and a labeled heuristic synthesis with `possible_divergences`.
  `delegate`, `consensus` and `swarm_run` share an overall deadline (`DZ23_DELEGATE_DEADLINE_MS`).
- **Budgets**: input tokens, mission calls/tokens, per-call/mission/project/daily cost limits,
  `allow_unknown_cost`/`deny_unknown_cost` (deny is the default once a cost limit is set), prices only
  from an explicit table, usage records with token and cost provenance.
- **Memory**: schema versions with read-time migrations, integrity errors instead of silent resets,
  owner-aware locks with safe orphan recovery, monotonic journal sequence, layered context with
  truncation report, bounded checkpoints, harness-owned `status`/`next_action`/`goal` that tools never
  overwrite, `memory repair`.
- **Operations**: redacted JSON Lines logs on stderr, process metrics (`GET /metrics`), CLI
  (`doctor`, `config validate`, `providers`, `health --yes`, `missions`, `memory repair`, `token hash`).

## Cost tiers

Without `DZ23_ALLOW_PAID=true`, `paid` and `low-cost` targets are blocked, and so are `mixed` targets
(OpenRouter, Gemini, Mistral, Together, Fireworks, Novita, Upstage, Ollama cloud, Hyperbolic, Alibaba,
and local adapters pointed at a non-private host), because those providers bill some models. A mixed
model runs only when its exact `provider:model` is listed in `DZ23_FREE_MODELS` or it is an OpenRouter
`:free` model; list only models that are really free for your account. `:cloud` models served through a
local Ollama count as mixed. Private endpoints are loopback/private IPs, `localhost`,
`host.docker.internal` and hosts listed in `DZ23_PRIVATE_HOSTS`. `doctor` shows every target as
`eligible` or `skipped(reason)`. Tiers are static labels, not proof that usage is free: free-tier
providers can bill beyond the free quota.

## Setup

Run `bash scripts/install-local.sh` on Linux/macOS or
`powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1` on Windows.
The installer creates a private `.env` from `.env.example` only if absent, runs the tests and
generates reviewable snippets in `config/generated/` without changing existing host configuration.
Then run `node src/index.js config validate` and `node src/index.js doctor` (no provider calls).

The sample rotation is local only. For cloud services: configure the key privately, discover models,
verify inference explicitly, then add `provider:model` to the rotation, set a price table, a cost
policy and budget limits, and configure supplier-side spending limits.

## Connect a harness

- **Claude Code** (user scope): run the command from `config/generated/claude_code_add_command.txt`,
  `claude mcp add -s user dz23-subagents -- "<node>" "<folder>/src/index.js" --stdio`, then check with
  `claude mcp get dz23-subagents`. When upgrading, run `claude mcp remove -s user dz23-subagents` first.
- **Codex**: in `~/.codex/config.toml`, replace the existing `[mcp_servers.dz23-subagents]` table
  with `config/generated/codex_config.snippet.toml` (never add a second table). It sets
  `startup_timeout_sec = 30` and `tool_timeout_sec = 900`, because `swarm_run` and `consensus` can take
  minutes.
- **Other stdio clients**: command = Node, args = `["<folder>/src/index.js", "--stdio"]`; map these to
  the client's own format.

Point every harness at the same `DZ23_STATE_DIR` and reuse the same `project_id`/`mission_id` to hand
work over.

## Upgrading

From 2.2.x or 3.0.0 (Windows runbook in [docs/OPERATIONS.md](docs/OPERATIONS.md#atualizando-de-22x300-para-400)):
record each harness's environment (`claude mcp get`, the Codex table) and effective state directory;
close all harnesses and stop only the DZ23 server processes; back up every state directory, the `.env`
files, `~/.codex/config.toml` and `~/.claude.json`; extract 4.0.0 to a new folder and copy the old `.env`
(`.env.example` lists every provider key and supported variable); choose one `DZ23_STATE_DIR`; review
the variable changes (`DZ23_ROUTING_POLICY=ordered` → `rotation-order`, `DZ23_FREE_MODELS` for mixed
rotation entries, `GITHUB_TOKEN` → `GITHUB_MODELS_TOKEN`, `CLOUDFLARE_API_TOKEN` →
`CLOUDFLARE_WORKERS_AI_TOKEN`, `DZ23_<PROVIDER>_BASE_URL`/`_MODEL` for cloud providers, `DZ23_PRIVATE_HOSTS`
for plain-HTTP LAN hosts, an HTTP token); run `config validate` and `doctor` with the harness's
environment; replace both harness entries, re-adding harness env with `claude mcp add -e`; restart and
run a cheap check (`list_models`, `mission_status`). Do not run old and new servers side by side on
the same state directory.

## Boundaries

One instance is one trust domain; `project_id` is never authentication. Rate limits, budgets and
metrics are per process. Memory writes are atomic per file but not transactional across files.
Vision, embeddings, provider tool calling and output streaming are not exposed. Model IDs, catalog
entries and declared capabilities are not live proof.

Run `npm run check`, `npm test`, `npm run check:release` and `npm run check:public`. CI runs lint,
Linux/Windows tests on Node 22/24, MCP contract fixtures, a coverage report and a public-file audit.
See [publishing](docs/PUBLISH_GITHUB.md) and [validation](docs/VALIDATION.md).

MIT copyright notice is retained. API credits and provider terms are separate.
