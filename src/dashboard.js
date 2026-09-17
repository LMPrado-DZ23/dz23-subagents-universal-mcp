import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {SERVER_VERSION} from './constants.js';
import {listMissionsTool} from './insight-tools.js';

// Read-only local dashboard. Loopback only, one random token per run passed in the URL fragment (never sent in
// requests or logs), strict CSP, no mutation routes, data rendered with textContent.
const AUDIT_TAIL = 50;

async function liveLeases(stateDir) {
  const out = [];
  const root = path.join(stateDir, 'leases');
  for (const project of await fs.readdir(root).catch(() => [])) {
    for (const file of await fs.readdir(path.join(root, project)).catch(() => [])) {
      if (!file.endsWith('.json')) continue;
      const lease = await fs.readFile(path.join(root, project, file), 'utf8').then(JSON.parse).catch(() => null);
      if (lease && Date.parse(lease.expires_at) > Date.now()) out.push({project_id: lease.project_id, mission_id: lease.mission_id, identity: lease.identity, expires_at: lease.expires_at});
    }
  }
  return out;
}

async function auditTail(stateDir) {
  const text = await fs.readFile(path.join(stateDir, 'audit', 'events.jsonl'), 'utf8').catch(() => '');
  return text.trim().split('\n').filter(Boolean).slice(-AUDIT_TAIL).map(line => {
    try {
      const {at, event} = JSON.parse(line);
      return {at, tool: event?.tool, status: event?.status, error_code: event?.error_code ?? null, identity: event?.identity ?? null, duration_ms: event?.duration_ms};
    } catch { return null; }
  }).filter(Boolean).reverse();
}

export async function dashboardData({cfg, memory, router}) {
  await router.refreshSharedCooldowns?.().catch(() => undefined);
  await router.stats?.load();
  const today = new Date().toISOString().slice(0, 10);
  const {missions, total} = await listMissionsTool(memory, {limit: 200});
  const stats = router.stats?.snapshot() || {entries: [], quotas: {}};
  return {version: SERVER_VERSION, generated_at: new Date().toISOString(), missions_total: total, missions,
    leases: await liveLeases(cfg.stateDir), usage_today: await memory.getDailyUsage(today).catch(() => null),
    cooldowns: router.cooldowns(), routing: {adaptive: cfg.adaptiveRouting !== false, entries: stats.entries, quotas: stats.quotas},
    audit: await auditTail(cfg.stateDir)};
}

const page = nonce => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DZ23 Subagents</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e3e6;--card:#fff;--ok:#1a7f37;--bad:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececef;--muted:#9a9aa2;--line:#2c2c31;--card:#1c1c20;--ok:#56d364;--bad:#ff7b72}}
body{margin:0;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
h1{font-size:18px;margin:0}h2{font-size:15px;margin:24px 0 8px}#meta{color:var(--muted)}
main{padding:0 20px 32px;max-width:1200px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-top:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:140px}
.card b{display:block;font-size:20px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.wrap{overflow-x:auto}.bad{color:var(--bad)}.ok{color:var(--ok)}#error{color:var(--bad)}
</style></head><body>
<header><h1>DZ23 Subagents</h1><span id="meta">carregando…</span><span id="error"></span></header>
<main>
<div class="cards" id="cards"></div>
<h2>Missões</h2><div class="wrap"><table id="missions"></table></div>
<h2>Roteamento aprendido</h2><div class="wrap"><table id="routing"></table></div>
<h2>Cooldowns e travas</h2><div class="wrap"><table id="cooldowns"></table></div><br><div class="wrap"><table id="leases"></table></div>
<h2>Últimas chamadas (auditoria)</h2><div class="wrap"><table id="audit"></table></div>
</main>
<script nonce="${nonce}">
const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
history.replaceState(null, '', location.pathname);
const el = id => document.getElementById(id);
function fill(id, headers, rows) {
  const table = el(id); table.replaceChildren();
  const head = table.insertRow(); for (const h of headers) { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); }
  if (!rows.length) { const cell = table.insertRow().insertCell(); cell.colSpan = headers.length; cell.textContent = 'nenhum'; return; }
  for (const row of rows) { const tr = table.insertRow(); for (const value of row) { const td = tr.insertCell(); td.textContent = value == null ? '' : String(value); if (/failed|cancelled|busy|exceeded/.test(td.textContent)) td.className = 'bad'; } }
}
function card(label, value) { const d = document.createElement('div'); d.className = 'card'; const b = document.createElement('b'); b.textContent = value; d.append(b, label); return d; }
async function refresh() {
  try {
    const res = await fetch('/api/overview', {headers: {authorization: 'Bearer ' + token}, cache: 'no-store'});
    if (!res.ok) throw new Error(res.status === 401 ? 'token inválido: abra a URL impressa pelo comando dashboard' : 'erro ' + res.status);
    const d = await res.json();
    el('error').textContent = '';
    el('meta').textContent = 'v' + d.version + ' · atualizado ' + new Date(d.generated_at).toLocaleTimeString();
    const usage = d.usage_today || {};
    el('cards').replaceChildren(card('missões', d.missions_total), card('chamadas hoje', usage.calls ?? 0), card('tokens hoje', usage.total_tokens ?? 0),
      card('custo hoje (USD)', usage.cost_usd ?? 0), card('travas ativas', d.leases.length), card('cooldowns', d.cooldowns.length));
    fill('missions', ['projeto', 'missão', 'status', 'loop', 'grafo', 'próximo passo', 'atualizada'], d.missions.map(m => [m.project_id, m.mission_id, m.status, m.loop_status,
      m.dag ? m.dag.done + '/' + m.dag.nodes + (m.dag.failed ? ' (' + m.dag.failed + ' falhas)' : '') : '', m.next_action, m.updated_at]));
    fill('routing', ['alvo', 'tipo de tarefa', 'chamadas', 'sucessos', 'falhas', 'latência (ms)'], d.routing.entries.map(e => [e.target, e.task_type, e.calls, e.successes,
      Object.entries(e.failures || {}).map(([k, v]) => k + '×' + v).join(', '), e.latency_ms]));
    fill('cooldowns', ['alvo em cooldown', 'motivo', 'restante (s)'], d.cooldowns.map(c => [c.target, c.kind, Math.round(c.remaining_ms / 1000)]));
    fill('leases', ['projeto', 'missão travada', 'harness', 'expira'], d.leases.map(l => [l.project_id, l.mission_id, l.identity, l.expires_at]));
    fill('audit', ['quando', 'ferramenta', 'status', 'erro', 'identidade', 'ms'], d.audit.map(a => [a.at, a.tool, a.status, a.error_code, a.identity, a.duration_ms]));
  } catch (error) { el('error').textContent = error.message; }
}
refresh(); setInterval(refresh, 5000);
</script></body></html>`;

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, {'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', ...extra});
  res.end(body);
}

export function startDashboard({cfg, memory, router, host = '127.0.0.1', port = 0, token = crypto.randomBytes(24).toString('base64url')}) {
  const expected = Buffer.from(`Bearer ${token}`);
  const server = http.createServer(async (req, res) => {
    const address = server.address();
    const allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
    if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) return send(res, 403, 'forbidden host', 'text/plain');
    if (req.method !== 'GET') return send(res, 405, 'read-only', 'text/plain', {allow: 'GET'});
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/') {
      const nonce = crypto.randomBytes(16).toString('base64');
      return send(res, 200, page(nonce), 'text/html; charset=utf-8', {'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`});
    }
    if (url.pathname === '/api/overview') {
      const given = Buffer.from(String(req.headers.authorization || ''));
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return send(res, 401, JSON.stringify({error: 'unauthorized'}), 'application/json');
      try {
        return send(res, 200, JSON.stringify(await dashboardData({cfg, memory, router})), 'application/json');
      } catch {
        return send(res, 500, JSON.stringify({error: 'internal_error'}), 'application/json');
      }
    }
    return send(res, 404, 'not found', 'text/plain');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({server, token, url: `http://127.0.0.1:${server.address().port}/#token=${token}`}));
  });
}
