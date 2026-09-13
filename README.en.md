# DZ23 Subagents Universal MCP

**One project. Multiple models. Shared mission memory.**

[Português / full guide](README.md) · [Tools](docs/TOOLS.md) · [Operations](docs/OPERATIONS.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md)

Self-hosted MCP router for delegating text/code tasks to AI models, running parallel
specialists and keeping explicit, versioned mission memory that another harness can resume.
Version 2.3.0 is an **engineering preview**, MIT licensed, Node.js 22+, no npm dependencies.

Workers return text/code. They do not execute shell commands, edit repositories, use browsers
or run tests; the host harness owns those operations. Handoff works through persisted state,
not hidden model thoughts or unrecorded client conversations.

## What 2.3.0 provides

- **MCP**: 11 tools, protocol revisions 2025-11-25 and 2025-06-18, enforced closed schemas with
  bounded inputs, standard JSON-RPC errors, tool execution errors with `request_id`.
- **HTTP (opt-in)**: bearer token from env or file, optional per-token scopes (SHA-256 digests),
  Host/Origin checks, per-process rate limiting with 429 + Retry-After, body/time/in-flight limits,
  graceful shutdown. No SSE, sessions or OAuth.
- **Providers**: OpenAI-compatible and Anthropic Messages adapters, 13-kind error taxonomy, bounded
  retries only for rate limits/timeouts/unavailability, no failover for invalid requests,
  per-kind cooldowns, `verify_model` (requires `confirm_billable: true`), catalog capabilities
  reported as `unknown` when undeclared.
- **Routing**: `first`, `round_robin`, `provider_diversity`, `model_diversity`, `cost_optimized`,
  `latency_optimized`; requested vs effective strategy and observed diversity are reported.
  `consensus` uses distinct targets and a labeled heuristic synthesis.
- **Budgets**: input tokens, mission calls/tokens, per-call/mission/project/daily cost limits,
  `allow_unknown_cost`/`deny_unknown_cost`, prices only from an explicit table, usage records with
  token and cost provenance.
- **Memory**: schema versions with read-time migrations, integrity errors instead of silent resets,
  owner-aware locks with safe orphan recovery, monotonic journal sequence, layered context with
  truncation report, `memory repair`.
- **Operations**: redacted JSON Lines logs on stderr, process metrics (`GET /metrics`), CLI
  (`doctor`, `config validate`, `providers`, `health --yes`, `missions`, `memory repair`, `token hash`).

## Setup

Run `bash scripts/install-local.sh` on Linux/macOS or `./scripts/install-windows.ps1` in PowerShell.
The installer creates a private `.env` from `.env.example` only if absent, runs the tests and
generates reviewable Claude/Codex snippets without changing existing host configuration.
Then run `node src/index.js doctor`.

The sample rotation is local only. For cloud services: configure the key privately, discover models,
verify inference explicitly, then add `provider:model` to the rotation, set a price table, a cost
policy and budget limits, and configure supplier-side spending limits.

## Boundaries

One instance is one trust domain; `project_id` is never authentication. Rate limits, budgets,
cooldowns and metrics are per process. Memory writes are atomic per file but not transactional
across files. Vision, embeddings, provider tool calling and output streaming are not exposed.
Model IDs, catalog entries and declared capabilities are not live proof.

Run `npm run check`, `npm test`, `npm run check:release` and `npm run check:public`. CI runs lint,
Linux/Windows tests on Node 22/24, MCP contract fixtures, a coverage report and a public-file audit.
See [publishing](docs/PUBLISH_GITHUB.md) and [validation](docs/VALIDATION.md).

MIT copyright notice is retained. API credits and provider terms are separate.
