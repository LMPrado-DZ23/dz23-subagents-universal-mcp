import {SCHEMA_VERSIONS} from './constants.js';
import {ToolError} from './errors.js';
import {emptyUsage} from './usage.js';
import {isPlainObject} from './schema.js';

const PROJECT_LISTS = ['decisions', 'facts', 'artifacts', 'agents'];
const MISSION_LISTS = ['acceptance_criteria', 'invariants', 'completed_tasks', 'active_tasks', 'blocked_tasks', 'next_tasks', 'decisions', 'known_failures', 'files_read', 'files_changed', 'artifacts', 'agents'];

function assertSupported(record, version) {
  if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSIONS[record]) {
    throw new ToolError('memory_integrity', `The ${record} record uses an unsupported schema version`,
      {kind: 'unsupported_schema', record, schema: Number.isInteger(version) ? version : null, supported: SCHEMA_VERSIONS[record]});
  }
}

const lists = (value, names) => Object.fromEntries(names.map(name => [name, Array.isArray(value[name]) ? value[name] : []]));

export function newProject(projectId, now) {
  return {schema: SCHEMA_VERSIONS.project, project_id: projectId, created_at: now, ...lists({}, PROJECT_LISTS), usage_totals: emptyUsage()};
}

export function newMission(projectId, missionId, now) {
  return {schema: SCHEMA_VERSIONS.mission, project_id: projectId, mission_id: missionId, created_at: now, sequence: 0, status: 'active', goal: '', summary: '',
    ...lists({}, MISSION_LISTS), tests: {passed: [], failed: [], pending: []}, usage: emptyUsage()};
}

/**
 * Migrations run on read and never drop unknown fields; the upgraded shape is persisted by
 * the next write. Records newer than this build are refused instead of being rewritten.
 * Add future steps as `if (version < N) value = migrateToN(value)`.
 */
export function migrateProject(project) {
  const version = project.schema ?? 1;
  assertSupported('project', version);
  if (version === SCHEMA_VERSIONS.project) return project;
  return {...project, ...lists(project, PROJECT_LISTS), usage_totals: project.usage_totals || emptyUsage(), schema: SCHEMA_VERSIONS.project, migrated_from: project.migrated_from ?? version};
}

export function migrateMission(mission) {
  const version = mission.schema ?? 1;
  assertSupported('mission', version);
  if (version === SCHEMA_VERSIONS.mission) return mission;
  return {
    ...mission, ...lists(mission, MISSION_LISTS),
    sequence: Number.isInteger(mission.sequence) ? mission.sequence : 0,
    status: mission.status || 'active', goal: mission.goal || '', summary: mission.summary || '',
    tests: {passed: [], failed: [], pending: [], ...(isPlainObject(mission.tests) ? mission.tests : {})},
    usage: mission.usage || emptyUsage(), schema: SCHEMA_VERSIONS.mission, migrated_from: mission.migrated_from ?? version
  };
}

/** Journal events: legacy lines (no schema/seq) stay readable; unknown future schemas are skipped. */
export function normalizeEvent(event) {
  if (!isPlainObject(event)) return null;
  const version = event.schema ?? 1;
  if (!Number.isInteger(version) || version > SCHEMA_VERSIONS.event) return null;
  return {...event, schema: version, seq: Number.isInteger(event.seq) ? event.seq : null};
}
