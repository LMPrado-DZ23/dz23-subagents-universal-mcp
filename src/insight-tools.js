import {ToolError, RpcError, safeText} from './errors.js';
import {targetKey, targetReport, effectiveTier} from './targets.js';
import {taskTypeOf} from './routing-stats.js';
import {getPrompt, listPrompts} from './mcp-resources.js';
import {CLI_SPECS, cliAccountStatus, selectedAccountProviders} from './cli-providers.js';

const CHARS_PER_TOKEN = 4;
const CONTEXT_OVERHEAD_TOKENS = 1500;

/** How the router would order targets for a task right now, and why each configured target is or is not used. */
export async function explainRouting(router, {task_type, role = 'worker', target = 'auto'} = {}) {
  await router.stats?.load();
  const taskType = taskTypeOf(role, task_type);
  const order = router.availableTargets(taskType).map(targetKey);
  const cooling = new Map(router.cooldowns().map(c => [c.target, c]));
  let requested = null;
  if (target && target !== 'auto') {
    try { requested = {target, allowed: router.resolvePreferred(target).length > 0}; } catch (error) { requested = {target, allowed: false, reason: error.details?.reason || error.code}; }
  }
  const targets = targetReport(router.cfg, router.registry).map(item => {
    const stats = router.stats?.entry(item.target, taskType);
    return {...item, position: order.indexOf(item.target) >= 0 ? order.indexOf(item.target) + 1 : null,
      ...(cooling.has(item.target) ? {cooldown: cooling.get(item.target)} : {}),
      ...(stats ? {observed: {calls: stats.calls, successes: stats.successes, failures: stats.failures, latency_ms: stats.latency_ms ?? null}} : {}),
      score: router.stats?.score(item.target, taskType) ?? null, quota: router.stats?.quota(item.target) ?? null};
  });
  return {task_type: taskType, policy: router.cfg.policy || 'free-first', adaptive: router.cfg.adaptiveRouting !== false && (router.cfg.policy || 'free-first') === 'free-first',
    order, targets, ...(requested ? {requested} : {}),
    note: 'Order is by cost tier first; inside a tier, targets with more observed successes and lower latency for this task type go first. Paid targets stay blocked unless DZ23_ALLOW_PAID=true.'};
}

/** Upper-bound estimate before a billable call: calls, tokens and cost when a price table exists. */
export async function estimateCost(router, {tool = 'delegate', prompt = '', prompt_chars, models = 3, roles, max_agents, synthesis = 'heuristic', task_type} = {}) {
  const chars = Number.isInteger(prompt_chars) ? prompt_chars : String(prompt).length;
  const workers = Math.min(roles?.length || 7, max_agents || 7, 7);
  const calls = tool === 'consensus' ? models + (synthesis === 'model' ? 1 : 0) : tool === 'swarm_run' ? workers + 1 : 1;
  const inputTokens = Math.ceil(chars / CHARS_PER_TOKEN) + CONTEXT_OVERHEAD_TOKENS;
  const outputTokens = router.cfg.maxOutputTokens || 4096;
  const order = router.availableTargets(taskTypeOf('worker', task_type));
  const perTarget = order.slice(0, Math.max(1, Math.min(calls, 8))).map(target => {
    const tier = effectiveTier(target);
    const price = router.budget.priceFor(target);
    const cost = tier === 'local' ? 0 : price ? Number(((inputTokens * price.input_per_million_usd + outputTokens * price.output_per_million_usd) / 1e6).toFixed(6)) : null;
    return {target: targetKey(target), tier, max_cost_per_call_usd: cost, price_source: tier === 'local' ? 'local' : price ? 'price_table' : 'unknown'};
  });
  const known = perTarget.every(t => t.max_cost_per_call_usd !== null);
  const worst = perTarget.length ? Math.max(...perTarget.map(t => t.max_cost_per_call_usd ?? 0)) : 0;
  return {tool, calls, input_tokens_per_call: inputTokens, max_output_tokens_per_call: outputTokens, max_total_tokens: calls * (inputTokens + outputTokens),
    targets: perTarget, max_total_cost_usd: known ? Number((worst * calls).toFixed(6)) : null,
    note: known ? 'Upper bound: every call at the configured output limit on the most expensive listed target.' : 'Cost unknown for at least one target: configure DZ23_PRICES_FILE. Free tiers may still bill beyond their quota.'};
}

/** Account providers: which official CLIs are installed and logged in with an account (never an API key), and the OmniRoute gateway. */
export async function accountStatus(router, {refresh = false} = {}) {
  const selected = selectedAccountProviders(process.env);
  const accounts = (await Promise.all(Object.keys(CLI_SPECS).map(name => cliAccountStatus(name, process.env, {refresh}))))
    .map(account => ({...account, selected: selected.has(account.provider)}));
  const gateway = router.registry.omniroute;
  return {accounts, selection: process.env.DZ23_ACCOUNT_PROVIDERS || 'off', gateways: gateway ? [{provider: 'omniroute', configured: gateway.enabled, base_url: gateway.baseURL, tier: gateway.tier}] : [],
    order: 'local models, then accounts (logged-in CLIs and account gateways), then free-tier APIs, then the rest; paid stays blocked without DZ23_ALLOW_PAID',
    note: 'Log in once in each CLI with your account (the login command is listed); the server never uses a CLI that is logged in with an API key.'};
}

/** Missions across projects for harnesses without MCP resources support. */
export async function listMissionsTool(memory, {project_id, limit = 50, cursor} = {}) {
  const projects = project_id ? [project_id] : await memory.listProjects();
  const all = [];
  for (const project of projects) for (const mission of await memory.listMissions(project).catch(() => [])) all.push([project, mission]);
  const start = cursor ? Number.parseInt(cursor, 10) : 0;
  if (!Number.isInteger(start) || start < 0) throw new ToolError('invalid_request', 'invalid cursor');
  const page = all.slice(start, start + limit);
  const missions = [];
  for (const [project, mission] of page) {
    const state = await memory.getMission(project, mission).catch(() => null);
    if (!state) continue;
    const dag = state.dag_state?.nodes ? Object.values(state.dag_state.nodes) : null;
    missions.push({project_id: project, mission_id: mission, status: state.status, goal: safeText(state.goal || '', 200), next_action: safeText(state.next_action || '', 200),
      updated_at: state.updated_at, ...(state.loop_state ? {loop_status: state.loop_state.status} : {}),
      ...(dag ? {dag: {nodes: dag.length, done: dag.filter(n => n.status === 'done').length, failed: dag.filter(n => n.status === 'failed').length}} : {}),
      resource_uri: `dz23://mission/${project}/${mission}`});
  }
  return {missions, total: all.length, ...(start + limit < all.length ? {next_cursor: String(start + limit)} : {})};
}

/** The MCP prompts as a tool, for harnesses that do not expose MCP prompts. */
export function playbook({name, arguments: args} = {}) {
  if (!name) return listPrompts();
  try {
    return getPrompt({name, arguments: args || {}});
  } catch (error) {
    if (error instanceof RpcError) throw new ToolError('invalid_request', error.message, error.data);
    throw error;
  }
}
