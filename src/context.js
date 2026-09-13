/**
 * Layered mission context under a character budget.
 * Pass 1 fills sections in priority order, each capped at a share of the budget so a long
 * list cannot starve a small critical section that follows it. Pass 2 returns leftover room
 * to truncated sections, again in priority order. Lists keep their most useful end
 * (criteria from the start; decisions, events and outputs from the newest end), and every
 * truncation is reported instead of silently cutting a JSON tail.
 */
const RESERVED = 260;
const NOTE_ROOM = 42;
const FIRST_PASS_SHARE = 0.35;
const SECTIONS = [
  ['project', 'head'], ['goal', 'head'], ['acceptance_criteria', 'head'], ['decisions', 'tail'], ['invariants', 'head'],
  ['tasks', 'head'], ['files_and_tests', 'tail'], ['known_failures', 'tail'], ['checkpoint', 'head'], ['recent_events', 'tail'], ['recent_outputs', 'tail']
];
const EVENT_FIELDS = ['role', 'provider', 'model', 'attempt', 'kind', 'reason', 'status'];

const asText = item => (typeof item === 'string' ? item : JSON.stringify(item));
const list = (values, prefix = '') => (Array.isArray(values) ? values : []).map(item => `${prefix}${asText(item)}`);

function clip(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 14))}…[truncated]`;
}

function summarizeEvent(event) {
  const payload = event.payload || {};
  const fields = EVENT_FIELDS.filter(key => payload[key] !== undefined && payload[key] !== null).map(key => `${key}=${String(payload[key]).slice(0, 80)}`);
  return `#${event.seq ?? '-'} ${event.ts} ${event.type}${fields.length ? ` ${fields.join(' ')}` : ''}`;
}

function collect(project, mission, events) {
  const tests = mission?.tests || {};
  return {
    project: project ? [`project_id: ${project.project_id}`, project.repository && `repository: ${project.repository}`, project.branch && `branch: ${project.branch}`, project.workspace && `workspace: ${project.workspace}`].filter(Boolean) : [],
    goal: mission?.goal ? [String(mission.goal)] : [],
    acceptance_criteria: list(mission?.acceptance_criteria),
    decisions: [...list(project?.decisions, 'project: '), ...list(mission?.decisions)],
    invariants: list(mission?.invariants),
    tasks: [...list(mission?.active_tasks, 'active: '), ...list(mission?.blocked_tasks, 'blocked: '), ...list(mission?.next_tasks, 'next: ')],
    files_and_tests: [...list(mission?.files_read, 'read: '), ...list(mission?.files_changed, 'changed: '), ...list(mission?.artifacts, 'artifact: '),
      ...list(tests.passed, 'test passed: '), ...list(tests.failed, 'test failed: '), ...list(tests.pending, 'test pending: ')],
    known_failures: list(mission?.known_failures),
    checkpoint: mission ? [`status: ${mission.status}`, mission.next_action && `next_action: ${mission.next_action}`, mission.summary && `summary: ${mission.summary}`,
      mission.checkpoint_at && `checkpoint_at: ${mission.checkpoint_at}`, `sequence: ${mission.sequence ?? 0}`].filter(Boolean) : [],
    recent_events: events.map(summarizeEvent),
    recent_outputs: (mission?.agent_outputs || []).slice(-8).map(o => `[${o.role} via ${o.provider}:${o.model} at ${o.at}]\n${o.content}`)
  };
}

function take(items, limit, fromEnd) {
  const ordered = fromEnd ? [...items].reverse() : items;
  const kept = [];
  let size = 0;
  for (const item of ordered) {
    if (size + item.length + 1 > limit) break;
    kept.push(item);
    size += item.length + 1;
  }
  let truncated = kept.length < items.length;
  let included = kept.length;
  if (!kept.length) { kept.push(clip(ordered[0], limit)); included = 1; truncated = true; }
  const lines = fromEnd ? kept.reverse() : kept;
  const omitted = items.length - included;
  if (omitted > 0) {
    const note = `[${omitted} ${fromEnd ? 'older' : 'later'} item(s) omitted]`;
    if (fromEnd) lines.unshift(note); else lines.push(note);
  }
  return {lines, included, truncated: truncated || lines.some(line => line.endsWith('…[truncated]'))};
}

export function buildContext({project, mission, events = [], maxChars = 60_000, exclude = []}) {
  const budget = Math.max(400, maxChars - RESERVED);
  const cap = Math.max(200, Math.floor(budget * FIRST_PASS_SHARE));
  const all = collect(project, mission, events);
  const state = SECTIONS.map(([name, keep]) => ({name, keep, items: exclude.includes(name) ? [] : all[name], header: `## ${name.toUpperCase()}\n`, chosen: null, size: 0}));
  let used = 0;
  const fill = (section, limit) => {
    const chosen = take(section.items, limit, section.keep === 'tail');
    const size = section.header.length + chosen.lines.join('\n').length + 2;
    used += size - section.size;
    section.chosen = chosen;
    section.size = size;
  };
  for (const section of state) {
    if (!section.items.length) continue;
    const room = Math.min(cap, budget - used) - section.header.length - NOTE_ROOM;
    if (room >= 40) fill(section, room);
  }
  for (const section of state) {
    if (!section.items.length || (section.chosen && !section.chosen.truncated)) continue;
    const current = section.chosen ? section.size - section.header.length - 2 : 0;
    const room = current + (budget - used) - NOTE_ROOM - (section.chosen ? 0 : section.header.length + 2);
    if (room >= 40 && room > current) fill(section, room);
  }
  const parts = [];
  const sections = [];
  for (const section of state) {
    const report = {name: section.name, items: section.items.length, included: section.chosen?.included || 0, truncated: Boolean(section.items.length) && (!section.chosen || section.chosen.truncated)};
    if (section.chosen) parts.push(section.header + section.chosen.lines.join('\n'));
    sections.push(report);
  }
  const truncated = sections.filter(section => section.truncated).map(section => section.name);
  const banner = truncated.length ? `CONTEXT TRUNCATED SECTIONS: ${truncated.join(', ')} (higher-priority sections kept first)` : 'CONTEXT COMPLETE';
  const text = `${banner}\n\n${parts.join('\n\n')}`;
  return {text: text.length > maxChars ? text.slice(0, maxChars) : text, truncated_sections: truncated, sections};
}
