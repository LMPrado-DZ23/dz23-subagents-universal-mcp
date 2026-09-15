import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseArgs} from 'node:util';
import {config} from './config.js';
import {ConfigError, ToolError} from './errors.js';
import {ProjectMemory} from './memory.js';
import {Router} from './core.js';
import {inspectMemory, repairMemory} from './memory-repair.js';
import {SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS, ID_PATTERN} from './constants.js';
import {httpSecurityProblem} from './http.js';
import {sha256Hex} from './auth.js';
import {providerRegistry, parseTarget} from './providers.js';
import {targetReport} from './targets.js';

export const EXIT = Object.freeze({OK: 0, PROBLEMS: 1, USAGE: 2, CONFIG: 78});
const ID = new RegExp(ID_PATTERN);
const COST_REASONS = new Set(['paid_not_allowed', 'mixed_not_allowed']);

export const USAGE = `dz23-subagents ${SERVER_VERSION}

Usage:
  dz23-subagents [--stdio]                    Start the MCP server on stdio (default)
  dz23-subagents --http                       Start the HTTP MCP server (requires DZ23_ALLOW_HTTP=true and a token)
  dz23-subagents doctor [--json]              Local diagnostics (targets, cost policy, HTTP auth); never calls providers
  dz23-subagents config validate [--json]     Validate configuration; never prints secret values
  dz23-subagents providers [--json]           Provider inventory with persisted catalog/verification status
  dz23-subagents health --yes [--json]        One real generation per eligible target (may be billed)
  dz23-subagents missions list [--project <id>] [--json]
  dz23-subagents missions show <project_id> <mission_id> [--json]
  dz23-subagents memory repair [--project <id>] [--apply --yes] [--json]
  dz23-subagents token hash [--json]          SHA-256 of a token read from stdin (scoped token files)
  dz23-subagents version | help

Exit codes: 0 ok, 1 problems found, 2 usage error, 78 configuration error.`;

class UsageError extends Error {}

/** Errors go to stderr; with --json the same error is also a JSON object on stdout. */
function failure(io, json, code, label, message, exit) {
  io.stderr.write(`${label}: ${message}\n`);
  if (json) io.stdout.write(`${JSON.stringify({error: {code, message}}, null, 2)}\n`);
  return exit;
}

function print(io, value, json, human) {
  io.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${human(value)}\n`);
}

function table(rows, headers) {
  if (!rows.length) return '(none)';
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map(row => String(row[i]).length)));
  const line = cells => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

function validId(value, label = 'identifier') {
  if (typeof value !== 'string' || !ID.test(value)) throw new UsageError(`invalid ${label}: use 1-120 letters, digits, dots, underscores or hyphens`);
  return value;
}

/** --http refuses to start without any token unless the operator explicitly allows unauthenticated loopback HTTP. */
function unauthenticatedHttpProblem(cfg) {
  if (!cfg.allowHttp || cfg.token || cfg.scopedTokens.length || cfg.allowUnauthenticatedLocalHttp) return null;
  return '--http refuses to start without authentication, even on loopback: set DZ23_MCP_TOKEN_FILE (or DZ23_MCP_TOKEN, 32+ characters) or scoped tokens; only for local testing set DZ23_ALLOW_UNAUTHENTICATED_LOCAL_HTTP=true';
}

/** Provider registry errors (invalid base URL, unreadable secret file) are configuration errors. */
function services(cfg) {
  let registry;
  try { registry = providerRegistry(); } catch (error) { throw new ConfigError(error.message); }
  const memory = new ProjectMemory(cfg.stateDir, cfg);
  return {memory, router: new Router(cfg, memory, {registry})};
}

async function doctor(opts, io) {
  const checks = [];
  const add = (name, status, detail) => checks.push({name, status, detail});
  const finish = () => {
    const ok = !checks.some(check => check.status === 'fail');
    print(io, {ok, checks}, opts.json, result => [...result.checks.map(c => `${c.status.toUpperCase().padEnd(4)}  ${c.name}: ${c.detail}`), result.ok ? 'Doctor: no failing checks.' : 'Doctor: failing checks found.'].join('\n'));
    return ok ? EXIT.OK : EXIT.PROBLEMS;
  };
  const major = Number(process.versions.node.split('.')[0]);
  add('node_version', major >= 22 ? 'pass' : 'fail', `Node.js ${process.versions.node}; 22+ required`);
  let cfg;
  let router;
  let memory;
  try {
    cfg = config(io.env);
    ({router, memory} = services(cfg));
    add('configuration', 'pass', 'configuration parsed');
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    add('configuration', 'fail', error.message);
    return finish();
  }
  for (const issue of cfg.configIssues) add(`config:${issue.variable}`, issue.level === 'error' ? 'fail' : 'warn', issue.message);
  try {
    fs.mkdirSync(cfg.stateDir, {recursive: true, mode: 0o700});
    const probe = path.join(cfg.stateDir, `.doctor-${crypto.randomUUID()}`);
    fs.writeFileSync(probe, 'ok', {mode: 0o600});
    fs.rmSync(probe, {force: true});
    add('state_dir_writable', 'pass', cfg.stateDir);
  } catch {
    add('state_dir_writable', 'fail', `cannot write ${cfg.stateDir}`);
  }
  const unknown = cfg.rotation.filter(entry => { try { parseTarget(entry, router.registry); return false; } catch { return true; } });
  if (unknown.length) add('rotation', 'fail', `${unknown.length} DZ23_ROTATION entr${unknown.length === 1 ? 'y has' : 'ies have'} an unknown provider`);
  const targets = unknown.length ? [] : router.targets();
  add('providers', targets.length ? 'pass' : 'fail',`${targets.length} eligible routing target(s), ${router.inventory().filter(p => p.enabled).length} enabled provider(s); no network calls made`);
  if (!unknown.length) {
    const report = targetReport(cfg, router.registry);
    add('targets', report.some(entry => entry.eligible) ? 'pass' : 'fail', report.length
      ? report.map(entry => `${entry.target} ${entry.tier} ${entry.eligible ? 'eligible' : `skipped(${entry.reason})`}`).join('; ')
      : 'no configured targets: set DZ23_ROTATION or a provider credential');
    const blocked = report.filter(entry => COST_REASONS.has(entry.reason));
    add('cost_policy', blocked.length ? 'warn' : 'pass', blocked.length
      ? `skipped by cost policy: ${blocked.map(entry => `${entry.target} (${entry.reason})`).join(', ')}; add a model to DZ23_FREE_MODELS only if it is really free for your account, or set DZ23_ALLOW_PAID=true to allow billed targets`
      : cfg.allowPaid ? 'DZ23_ALLOW_PAID=true; paid, low-cost and mixed targets may be billed' : 'DZ23_ALLOW_PAID=false; no configured target skipped by cost policy');
  }
  const ignored = Object.values(router.registry).filter(entry => entry.ignoredCredentialSource);
  add('generic_credentials', ignored.length ? 'warn' : 'pass', ignored.length
    ? `ignored generic credential(s): ${ignored.map(entry => `${entry.name} (${entry.ignoredCredentialSource})`).join(', ')}; set the specific variable (${ignored.map(entry => entry.keyName).join(', ')}), name the provider in DZ23_ROTATION or set DZ23_ALLOW_GENERIC_CREDENTIALS=true`
    : 'no generic credential ignored');
  if (cfg.allowHttp) {
    const problem = httpSecurityProblem(cfg) || (cfg.token && cfg.token.length < 32 ? 'DZ23_MCP_TOKEN has fewer than 32 characters; --http refuses to start' : null) || unauthenticatedHttpProblem(cfg);
    const open = !problem && !cfg.token && !cfg.scopedTokens.length;
    add('http', problem ? 'fail' : open ? 'warn' : 'pass', problem || (open
      ? `enabled on ${cfg.host}:${cfg.port} without authentication (DZ23_ALLOW_UNAUTHENTICATED_LOCAL_HTTP=true)`
      : `enabled on ${cfg.host}:${cfg.port}, auth ${cfg.authMode}, token source ${cfg.tokenSource}`));
  } else {
    add('http', 'pass', 'disabled (stdio only)');
  }
  const budget = cfg.budget;
  const costLimits = [budget.missionCostUsd, budget.projectCostUsd, budget.dailyCostUsd, budget.callCostUsd].some(value => value !== null);
  const bypass = costLimits && budget.policy === 'allow_unknown_cost';
  add('budget', bypass ? 'warn' : 'pass', `${costLimits ? 'cost limits set' : 'no cost limits'}; policy ${budget.policy}; ${Object.keys(budget.prices).length} price entr${Object.keys(budget.prices).length === 1 ? 'y' : 'ies'}${bypass ? '; unpriced targets are not bound by cost limits' : ''}`);
  try {
    const report = await inspectMemory(memory);
    const unreadable = report.issues.filter(issue => ['corrupt_project', 'corrupt_mission_state'].includes(issue.type));
    const repairable = report.issues.filter(issue => issue.repairable);
    add('memory', unreadable.length ? 'fail' : repairable.length ? 'warn' : 'pass',
      `${report.projects_scanned} project(s), ${report.missions_scanned} mission(s), ${report.issues.length} issue(s)${repairable.length ? '; run: dz23-subagents memory repair' : ''}`);
  } catch (error) {
    add('memory', 'fail', error instanceof ToolError ? error.message : 'memory inspection failed');
  }
  return finish();
}

async function configCommand(positionals, opts, io) {
  if (positionals[0] !== 'validate') throw new UsageError('config requires the validate action');
  const cfg = config(io.env);
  const issues = [...cfg.configIssues];
  const {router} = services(cfg);
  if (cfg.rotation.some(entry => { try { parseTarget(entry, router.registry); return false; } catch { return true; } })) {
    issues.push({level: 'error', variable: 'DZ23_ROTATION', message: 'contains an unknown provider'});
  }
  const httpProblem = cfg.allowHttp ? httpSecurityProblem(cfg) : null;
  if (httpProblem) issues.push({level: 'error', variable: 'DZ23_HTTP_HOST', message: httpProblem});
  const openHttp = httpProblem ? null : unauthenticatedHttpProblem(cfg);
  if (openHttp) issues.push({level: 'error', variable: 'DZ23_MCP_TOKEN', message: openHttp});
  const result = {
    valid: !issues.some(issue => issue.level === 'error'), issues,
    summary: {state_dir: cfg.stateDir, http_enabled: cfg.allowHttp, http_host: cfg.host, auth_mode: cfg.authMode, token_source: cfg.tokenSource,
      scoped_tokens: cfg.scopedTokens.length, rotation: cfg.rotation, allow_paid: cfg.allowPaid, free_models: cfg.freeModels,
      allow_generic_credentials: cfg.allowGenericCredentials, cost_policy: cfg.budget.policy, price_entries: Object.keys(cfg.budget.prices).length,
      rate_limit_enabled: cfg.rateLimit.enabled, shared_cooldowns: cfg.sharedCooldowns, delegate_deadline_ms: cfg.delegateDeadlineMs,
      stdio_max_inflight: cfg.stdioMaxInflight, log_level: cfg.logLevel}
  };
  print(io, result, opts.json, r => [r.valid ? 'Configuration valid.' : 'Configuration has errors.', ...r.issues.map(i => `${i.level.toUpperCase()}  ${i.variable}: ${i.message}`)].join('\n'));
  return result.valid ? EXIT.OK : EXIT.PROBLEMS;
}

async function providers(opts, io) {
  const {router} = services(config(io.env));
  await router.loadProviderStatus();
  const inventory = router.inventory();
  const yes = (value, label) => (value ? label : '-');
  print(io, inventory, opts.json, rows => table(rows.map(p => [p.provider, p.status, p.tier, p.enabled ? 'yes' : 'no', yes(p.status_flags.credential_present, 'present'),
    yes(p.status_flags.catalog_discovered, 'discovered'), yes(p.status_flags.inference_verified, 'verified'), p.default_model || '-']),
  ['PROVIDER', 'STATUS', 'TIER', 'ENABLED', 'CREDENTIAL', 'CATALOG', 'INFERENCE', 'DEFAULT_MODEL']));
  return EXIT.OK;
}

async function health(opts, io) {
  if (!opts.yes) throw new UsageError('health runs one real generation per eligible target and may be billed; re-run with --yes');
  const {router} = services(config(io.env));
  let results;
  try { results = await router.healthCheck(); } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ConfigError('routing targets could not be resolved; run: dz23-subagents config validate');
  }
  print(io, results, opts.json, rows => (rows.length
    ? table(rows.map(r => [`${r.provider}:${r.model}`, r.ok ? 'ok' : 'failed', r.kind || '-', `${r.latency_ms} ms`]), ['TARGET', 'RESULT', 'KIND', 'LATENCY'])
    : 'No eligible routing targets.'));
  return results.length && results.every(result => result.ok) ? EXIT.OK : EXIT.PROBLEMS;
}

/** A wrong-case id on a case-insensitive filesystem is a usage error, never reported as corrupt memory. */
async function exactIds(memory, projectId, missionId) {
  try {
    await memory.checkIds(projectId, missionId);
  } catch (error) {
    if (error instanceof ToolError && error.code === 'invalid_request') throw new UsageError(error.message);
    throw error;
  }
}

async function missions(positionals, opts, io) {
  const [action, projectId, missionId] = positionals;
  if (action !== 'list' && action !== 'show') throw new UsageError('missions requires list or show');
  if (action === 'show' && (!projectId || !missionId)) throw new UsageError('missions show requires <project_id> <mission_id>');
  const {memory} = services(config(io.env));
  if (action === 'list') {
    if (opts.project) await exactIds(memory, validId(opts.project, 'project_id'));
    const projects = opts.project ? [opts.project] : await memory.listProjects();
    const rows = [];
    for (const project of projects) {
      for (const mission of await memory.listMissions(project)) {
        try {
          const state = await memory.getMission(project, mission);
          rows.push({project_id: project, mission_id: mission, status: state?.status ?? 'missing', sequence: state?.sequence ?? 0, updated_at: state?.updated_at ?? null, goal: String(state?.goal ?? '').slice(0, 120)});
        } catch (error) {
          if (!(error instanceof ToolError)) throw error;
          rows.push({project_id: project, mission_id: mission, status: 'unreadable', integrity: error.details?.kind || error.code});
        }
      }
    }
    print(io, rows, opts.json, list => table(list.map(r => [r.project_id, r.mission_id, r.status, r.sequence ?? '-', r.updated_at || '-', r.goal || r.integrity || '']), ['PROJECT', 'MISSION', 'STATUS', 'SEQ', 'UPDATED', 'GOAL']));
    return EXIT.OK;
  }
  validId(projectId, 'project_id');
  validId(missionId, 'mission_id');
  await exactIds(memory, projectId, missionId);
  let state;
  try { state = await memory.getMission(projectId, missionId); } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return failure(io, opts.json, error.code, `Error (${error.code})`, `Mission memory is not readable (${error.details?.kind || error.code}); run: dz23-subagents memory repair`, EXIT.PROBLEMS);
  }
  if (!state) return failure(io, opts.json, 'mission_not_found', 'Error (mission_not_found)', 'Mission not found', EXIT.PROBLEMS);
  const journal = await memory.readJournal(projectId, missionId, 10);
  const result = {state, recent_events: journal.events, journal_integrity: {invalid_lines: journal.invalid_lines, last_seq: journal.last_seq}};
  print(io, result, opts.json, r => [`${r.state.project_id}/${r.state.mission_id}  status=${r.state.status}  sequence=${r.state.sequence}`, `goal: ${r.state.goal || '-'}`,
    `next_action: ${r.state.next_action || '-'}`, `usage: ${r.state.usage?.calls ?? 0} calls, ${r.state.usage?.total_tokens ?? 0} tokens, ${r.state.usage?.cost_usd ?? 0} USD known cost`,
    'recent events:', ...r.recent_events.map(e => `  #${e.seq ?? '-'} ${e.ts} ${e.type}`)].join('\n'));
  return EXIT.OK;
}

async function memoryCommand(positionals, opts, io) {
  if (positionals[0] !== 'repair') throw new UsageError('memory requires the repair action');
  if (opts.apply && !opts.yes) throw new UsageError('--apply changes the state directory; confirm with --yes');
  const {memory} = services(config(io.env));
  if (opts.project) await exactIds(memory, validId(opts.project, 'project_id'));
  const report = await inspectMemory(memory, {projectId: opts.project || undefined});
  const result = await repairMemory(memory, report, {apply: Boolean(opts.apply)});
  const output = {state_dir_exists: report.state_dir_exists, projects_scanned: report.projects_scanned, missions_scanned: report.missions_scanned,
    apply_requested: result.applied, applied: result.actions.some(action => ['removed', 'restored', 'closed'].includes(action.status)), issues: report.issues, actions: result.actions};
  print(io, output, opts.json, r => [`Scanned ${r.projects_scanned} project(s), ${r.missions_scanned} mission(s); ${r.issues.length} issue(s).`,
    ...r.issues.map(i => `  ${i.repairable ? 'REPAIRABLE' : 'MANUAL    '}  ${i.type}  ${i.file || i.lock || `${i.project || ''}${i.mission ? `/${i.mission}` : ''}`}${i.action ? `  (${i.action})` : ''}`),
    ...r.actions.map(a => `  ACTION  ${a.type}: ${a.status}`), r.apply_requested ? (r.applied ? 'Repairs applied.' : 'No repairs applied.') : 'Dry run only. Re-run with --apply --yes to repair.'].join('\n'));
  const blocking = report.issues.some(issue => !issue.repairable && ['corrupt_project', 'corrupt_mission_state'].includes(issue.type));
  if (!result.applied) return blocking || report.issues.some(issue => issue.repairable) ? EXIT.PROBLEMS : EXIT.OK;
  return blocking || result.actions.some(action => action.status === 'skipped') ? EXIT.PROBLEMS : EXIT.OK;
}

async function tokenCommand(positionals, opts, io) {
  if (positionals[0] !== 'hash') throw new UsageError('token requires the hash action');
  if (io.stdin.isTTY) throw new UsageError('pipe the token through stdin so it never appears in shell history or process arguments');
  const chunks = [];
  for await (const chunk of io.stdin) chunks.push(Buffer.from(chunk));
  const value = Buffer.concat(chunks).toString('utf8').replace(/\s+$/u, '');
  if (!value || !/^[\x21-\x7e]+$/.test(value)) throw new UsageError('the token must be non-empty printable ASCII without spaces');
  if (value.length < 32) throw new UsageError('tokens must have at least 32 characters; generate them with a cryptographic random generator');
  print(io, {sha256: sha256Hex(value)}, opts.json, result => result.sha256);
  return EXIT.OK;
}

export async function runCli(argv, io = {stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env}) {
  let parsed;
  try {
    parsed = parseArgs({args: argv, allowPositionals: true, strict: true, options: {
      json: {type: 'boolean'}, yes: {type: 'boolean'}, apply: {type: 'boolean'}, project: {type: 'string'},
      help: {type: 'boolean', short: 'h'}, version: {type: 'boolean'}
    }});
  } catch (error) {
    const code = failure(io, argv.includes('--json'), 'usage_error', 'Usage error', error.message, EXIT.USAGE);
    io.stderr.write(`\n${USAGE}\n`);
    return code;
  }
  const {values: opts, positionals} = parsed;
  const [command, ...rest] = positionals;
  try {
    if (opts.version || command === 'version') {
      print(io, {version: SERVER_VERSION, protocol_versions: [...SUPPORTED_PROTOCOL_VERSIONS], node: process.versions.node}, opts.json,
        v => `dz23-subagents ${v.version} (MCP ${v.protocol_versions.join(', ')}; Node.js ${v.node})`);
      return EXIT.OK;
    }
    if (opts.help || !command || command === 'help') { io.stdout.write(`${USAGE}\n`); return EXIT.OK; }
    switch (command) {
      case 'doctor': return await doctor(opts, io);
      case 'config': return await configCommand(rest, opts, io);
      case 'providers': return await providers(opts, io);
      case 'health': return await health(opts, io);
      case 'missions': return await missions(rest, opts, io);
      case 'memory': return await memoryCommand(rest, opts, io);
      case 'token': return await tokenCommand(rest, opts, io);
      default: throw new UsageError(`unknown command: ${String(command).slice(0, 40)}`);
    }
  } catch (error) {
    const json = Boolean(opts.json);
    if (error instanceof UsageError) return failure(io, json, 'usage_error', 'Usage error', error.message, EXIT.USAGE);
    if (error instanceof ConfigError) return failure(io, json, 'config_error', 'Configuration error', error.message, EXIT.CONFIG);
    if (error instanceof ToolError) return failure(io, json, error.code, `Error (${error.code})`, error.message, EXIT.PROBLEMS);
    return failure(io, json, 'internal_error', 'Unexpected error', error?.name || 'Error', EXIT.PROBLEMS);
  }
}
