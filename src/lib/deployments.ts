import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { DEPLOYMENTS_DIR, DEPLOYMENT_MANIFEST_FILENAME } from './config.js';
import { anthropic, isSDKNotFound } from './sdk.js';
import type {
  DeploymentConfig,
  FieldDiff,
  RemoteDeployment,
  ResolvedDeployment,
  State,
} from './types.js';

const DEPLOYMENT_COMPARE_FIELDS = [
  'name',
  'description',
  'agent',
  'environment_id',
  'initial_events',
  'schedule',
  'resources',
  'vault_ids',
  'metadata',
] as const;

// ---------------- filesystem ----------------

async function listDeploymentDirs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(DEPLOYMENTS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(DEPLOYMENTS_DIR, e.name))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readDeploymentManifest(dirPath: string): Promise<DeploymentConfig> {
  const manifestPath = path.join(dirPath, DEPLOYMENT_MANIFEST_FILENAME);
  let content: string;
  try {
    content = await fs.readFile(manifestPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${manifestPath}: ${DEPLOYMENT_MANIFEST_FILENAME} not found`);
    }
    throw err;
  }
  const parsed = parseYaml(content) as DeploymentConfig | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${manifestPath}: invalid YAML`);
  }
  if (!parsed.name) {
    throw new Error(`${manifestPath}: missing required field 'name'`);
  }
  if (!parsed.agent) {
    throw new Error(`${manifestPath}: missing required field 'agent'`);
  }
  if (!parsed.environment) {
    throw new Error(`${manifestPath}: missing required field 'environment'`);
  }
  if (!Array.isArray(parsed.initial_events) || parsed.initial_events.length === 0) {
    throw new Error(`${manifestPath}: 'initial_events' must be a non-empty array (1–50 events)`);
  }
  if (parsed.schedule) {
    if (parsed.schedule.type !== 'cron') {
      throw new Error(
        `${manifestPath}: schedule.type must be 'cron' (received ${parsed.schedule.type ?? 'undefined'})`,
      );
    }
    if (!parsed.schedule.expression || !parsed.schedule.timezone) {
      throw new Error(`${manifestPath}: schedule requires both 'expression' and 'timezone'`);
    }
  }
  return parsed;
}

export async function loadAllDeploymentConfigs(): Promise<
  Map<string, { config: DeploymentConfig; dirPath: string }>
> {
  const dirs = await listDeploymentDirs();
  const map = new Map<string, { config: DeploymentConfig; dirPath: string }>();
  for (const dirPath of dirs) {
    const localName = path.basename(dirPath);
    const config = await readDeploymentManifest(dirPath);
    map.set(localName, { config, dirPath });
  }
  return map;
}

/**
 * Write a remote deployment back to `deployments/<localName>/manifest.yaml`.
 * When `state` is provided, the agent / environment / vault references are
 * rewritten to their human-friendly local names wherever the id is tracked in
 * state; otherwise raw ids are kept.
 */
export async function writeDeploymentManifestFromRemote(
  remote: RemoteDeployment,
  localName: string,
  state: State | null = null,
): Promise<string> {
  const out: DeploymentConfig = {
    name: remote.name,
    description: remote.description ?? undefined,
    agent: agentRefForWrite(remote, state),
    environment: environmentRefForWrite(remote.environment_id, state),
    initial_events: remote.initial_events,
    schedule: remote.schedule
      ? { type: 'cron', expression: remote.schedule.expression, timezone: remote.schedule.timezone }
      : undefined,
    resources: remote.resources && remote.resources.length > 0 ? remote.resources : undefined,
    vault_ids:
      remote.vault_ids && remote.vault_ids.length > 0
        ? remote.vault_ids.map((id) => vaultRefForWrite(id, state))
        : undefined,
    metadata: remote.metadata,
  };
  const dirPath = path.join(DEPLOYMENTS_DIR, localName);
  await fs.mkdir(dirPath, { recursive: true });
  const manifestPath = path.join(dirPath, DEPLOYMENT_MANIFEST_FILENAME);
  await fs.writeFile(manifestPath, stringifyYaml(out), 'utf-8');
  return manifestPath;
}

function agentRefForWrite(
  remote: RemoteDeployment,
  state: State | null,
): DeploymentConfig['agent'] {
  const name = state ? agentNameById(remote.agent.id, state) : undefined;
  if (name) return { name, version: remote.agent.version };
  return { id: remote.agent.id, version: remote.agent.version };
}

function environmentRefForWrite(envId: string, state: State | null): string {
  return (state ? environmentNameById(envId, state) : undefined) ?? envId;
}

function vaultRefForWrite(vaultId: string, state: State | null): string {
  return (state ? vaultNameById(vaultId, state) : undefined) ?? vaultId;
}

function agentNameById(id: string, state: State): string | undefined {
  for (const [name, entry] of Object.entries(state.agents)) {
    if (entry.id === id) return name;
  }
  return undefined;
}

function environmentNameById(id: string, state: State): string | undefined {
  for (const [name, entry] of Object.entries(state.environments)) {
    if (entry.id === id) return name;
  }
  return undefined;
}

function vaultNameById(id: string, state: State): string | undefined {
  for (const [name, entry] of Object.entries(state.vaults)) {
    if (entry.id === id) return name;
  }
  return undefined;
}

// ---------------- SDK ----------------

export async function listDeployments(includeArchived = false): Promise<RemoteDeployment[]> {
  const results: RemoteDeployment[] = [];
  for await (const d of anthropic.beta.deployments.list({
    include_archived: includeArchived,
  })) {
    results.push(d as unknown as RemoteDeployment);
  }
  return results;
}

export async function retrieveDeployment(id: string): Promise<RemoteDeployment | null> {
  try {
    const d = await anthropic.beta.deployments.retrieve(id);
    return d as unknown as RemoteDeployment;
  } catch (err) {
    if (isSDKNotFound(err)) return null;
    throw err;
  }
}

export async function findDeploymentByName(name: string): Promise<RemoteDeployment | null> {
  const deployments = await listDeployments();
  return deployments.find((d) => d.name === name && !d.archived_at) ?? null;
}

/** Convert a resolved agent ref to the API's `agent` param form. */
function agentApplyParam(agent: ResolvedDeployment['agent']): unknown {
  // An object pins a concrete version; a bare id string re-pins to the latest.
  return agent.version != null ? { type: 'agent', id: agent.id, version: agent.version } : agent.id;
}

export async function createDeployment(config: ResolvedDeployment): Promise<RemoteDeployment> {
  const created = await anthropic.beta.deployments.create({
    name: config.name,
    description: config.description ?? undefined,
    agent: agentApplyParam(config.agent),
    environment_id: config.environment_id,
    initial_events: config.initial_events,
    schedule: config.schedule ?? undefined,
    resources: config.resources,
    vault_ids: config.vault_ids,
    metadata: config.metadata,
  } as unknown as Parameters<typeof anthropic.beta.deployments.create>[0]);
  return created as unknown as RemoteDeployment;
}

export async function updateDeployment(
  id: string,
  config: ResolvedDeployment,
  remote: RemoteDeployment,
  diffs: FieldDiff[],
): Promise<RemoteDeployment> {
  const changed = new Set(diffs.map((d) => d.field));
  const params: Record<string, unknown> = {};
  if (changed.has('name')) params.name = config.name;
  if (changed.has('description')) params.description = config.description ?? '';
  if (changed.has('agent')) params.agent = agentApplyParam(config.agent);
  if (changed.has('environment_id')) params.environment_id = config.environment_id;
  if (changed.has('initial_events')) params.initial_events = config.initial_events;
  if (changed.has('schedule')) params.schedule = config.schedule ?? null;
  if (changed.has('resources')) params.resources = config.resources ?? null;
  if (changed.has('vault_ids')) params.vault_ids = config.vault_ids ?? null;
  if (changed.has('metadata')) {
    // metadata patch: keys missing locally are sent as null (delete); others upserted.
    const localMeta = config.metadata ?? {};
    const remoteMeta = remote.metadata ?? {};
    const allKeys = new Set([...Object.keys(localMeta), ...Object.keys(remoteMeta)]);
    const metadataPatch: Record<string, string | null> = {};
    for (const k of allKeys) {
      if (!(k in localMeta)) metadataPatch[k] = null;
      else if (localMeta[k] !== remoteMeta[k]) metadataPatch[k] = localMeta[k];
    }
    if (Object.keys(metadataPatch).length > 0) params.metadata = metadataPatch;
  }

  const updated = await anthropic.beta.deployments.update(
    id,
    params as unknown as Parameters<typeof anthropic.beta.deployments.update>[1],
  );
  return updated as unknown as RemoteDeployment;
}

export async function archiveDeployment(id: string): Promise<void> {
  await anthropic.beta.deployments.archive(id);
}

// ---------------- normalization ----------------
//
// The retrieve response materializes computed schedule fields
// (last_run_at / upcoming_runs_at), echoes the agent as { id, type, version },
// drops write-only resource credentials (e.g. github authorization_token), and
// fills null-valued resource defaults. To keep `plan` idempotent we collapse
// both sides into a canonical comparison form before diffing.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function nullToUndefined<T>(v: T): T | undefined {
  return v === null ? undefined : (v as T | undefined);
}

function normalizeObjectField(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (isPlainObject(v) && Object.keys(v).length === 0) return undefined;
  return v;
}

/** Recursively strip write-only credentials and null/undefined-valued keys. */
function stripCredentialsAndNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripCredentialsAndNulls);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === 'authorization_token') continue; // write-only, never returned
      if (val === null || val === undefined) continue;
      out[k] = stripCredentialsAndNulls(val);
    }
    return out;
  }
  return v;
}

function normalizeResources(resources: unknown): unknown {
  if (!Array.isArray(resources) || resources.length === 0) return undefined;
  return resources.map(stripCredentialsAndNulls);
}

function normalizeSchedule(schedule: unknown): unknown {
  if (!isPlainObject(schedule)) return undefined;
  return { type: 'cron', expression: schedule.expression, timezone: schedule.timezone };
}

function normalizeVaultIds(ids: unknown): unknown {
  if (!Array.isArray(ids) || ids.length === 0) return undefined;
  return [...(ids as string[])].sort();
}

/**
 * Build the comparable agent form. The version is only significant when the
 * local manifest pins one — otherwise the deployment tracks whatever the
 * server resolved at create time and we ignore version drift in the diff.
 */
function agentCompareForms(
  local: ResolvedDeployment['agent'],
  remote: RemoteDeployment['agent'],
): [unknown, unknown] {
  if (local.version != null) {
    return [
      { id: local.id, version: local.version },
      { id: remote.id, version: remote.version },
    ];
  }
  return [{ id: local.id }, { id: remote.id }];
}

export function deploymentFieldDiffs(
  local: ResolvedDeployment,
  remote: RemoteDeployment,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of DEPLOYMENT_COMPARE_FIELDS) {
    let lv: unknown;
    let rv: unknown;
    switch (field) {
      case 'name':
        lv = local.name;
        rv = remote.name;
        break;
      case 'description':
        lv = nullToUndefined(local.description);
        rv = nullToUndefined(remote.description);
        break;
      case 'agent':
        [lv, rv] = agentCompareForms(local.agent, remote.agent);
        break;
      case 'environment_id':
        lv = local.environment_id;
        rv = remote.environment_id;
        break;
      case 'initial_events':
        lv = local.initial_events;
        rv = remote.initial_events;
        break;
      case 'schedule':
        lv = normalizeSchedule(local.schedule);
        rv = normalizeSchedule(remote.schedule);
        break;
      case 'resources':
        lv = normalizeResources(local.resources);
        rv = normalizeResources(remote.resources);
        break;
      case 'vault_ids':
        lv = normalizeVaultIds(local.vault_ids);
        rv = normalizeVaultIds(remote.vault_ids);
        break;
      case 'metadata':
        lv = normalizeObjectField(local.metadata);
        rv = normalizeObjectField(remote.metadata);
        break;
    }
    if (!isDeepStrictEqual(lv, rv)) {
      diffs.push({ field, oldValue: rv, newValue: lv });
    }
  }
  return diffs;
}
