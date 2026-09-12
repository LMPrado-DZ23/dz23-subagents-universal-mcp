# DZ23 Subagents Universal MCP

**One project. Multiple models. Shared mission memory.**

[Português / full guide](README.md) · [Installation](docs/INSTALL_ANY_HARNESS.md) · [Security](SECURITY.md)

Self-hosted MCP text-delegation router, shared filesystem mission memory, provider
failover and bounded parallel specialist model calls. Version 2.2.4 is an
**engineering preview**, licensed MIT, with Node.js 22+ and no runtime npm dependencies.

Workers return text/code. They do not automatically execute shell commands, edit
repositories, use browsers or run tests. The host harness owns those operations.
Handoff works through explicit persisted state, not invisible model thoughts or
unrecorded client conversations. Another harness must connect and resume explicitly.

## Setup

Run `bash scripts/install-local.sh` on Linux/macOS or
`./scripts/install-windows.ps1` in PowerShell. The installer creates a private `.env`
from `.env.example` only if absent, tests the source and generates reviewable
Claude/Codex snippets without changing existing host configuration. No `npm install`
is needed. Set the installed model ID, endpoint and credentials privately.

The sample rotation is local only. To add a cloud service, discover/configure an
entitled model, add a `provider:model` target, and set supplier-side spending limits.
`free-first` is a ranking policy, not free quota detection or a financial hard cap.
With `DZ23_ALLOW_PAID=false`, `paid` and `low-cost` categories are excluded even for
explicit targets. Mixed/free-tier services can still charge depending on the account.

Tools: `list_models`, `provider_inventory`, `discover_models`, `health_check`,
`project_init`, `mission_status`, `memory_checkpoint`, `delegate`, `consensus`, `swarm_run`.

## Boundaries

Use stdio locally or HTTP behind TLS with a private bearer token. Non-loopback binds
require at least 32 token characters; HTTP validates Host and Origin. There is no
per-user authorization, OAuth server or tenant isolation. Treat one instance as a
single trusted security domain. Vision, embeddings, provider tool calling and output
streaming are not exposed. Model IDs and declared capabilities are not live proof.

Run `npm run check`, `npm test` and `npm run check:release`. GitHub Actions is configured
for Linux/Windows and Node 22/24; configuring CI does not mean it has run remotely.
The included publication script requires authenticated local GitHub CLI and refuses
to overwrite repositories. See [publishing](docs/PUBLISH_GITHUB.md).

MIT copyright notice is retained. API credits and provider terms are separate.

## v2.2.4 correction

Swarm roles are assigned round-robin across eligible targets before reuse.
Concurrency tests hold calls behind promise barriers, observe simultaneous in-flight
work and queued calls, then release them. No passing assertion depends on a 30/40 ms
response window. Watchdogs still fail stuck/serialized execution.

Windows users may open `PUBLICAR_WINDOWS.cmd` from a fresh extracted folder to
run the existing guarded first-publication workflow. Local validation here is Linux
only; Windows/Node 24 and remote GitHub Actions are not claimed as passing.
