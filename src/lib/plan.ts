import { fieldDiffs, resolveRemote } from './agents.js';
import { environmentFieldDiffs, retrieveEnvironment } from './environments.js';
import { memoryStoreFieldDiffs, retrieveMemoryStore } from './memory-stores.js';
import type { ResolvedConfig } from './resolve.js';
import { findSkillByDisplayTitle } from './skills.js';
import { retrieveVault, type LocalVault } from './vaults.js';
import type {
  AgentConfig,
  EnvironmentConfig,
  FieldDiff,
  LocalSkill,
  MemoryStoreConfig,
  RemoteEnvironment,
  RemoteMemoryStore,
  State,
  VaultConfig,
} from './types.js';

/**
 * Surfaced by `plan` / `apply` when a delete / archive action would leave a
 * dangling reference in another local agent (see lib/warnings.ts).
 */
export interface PlanWarning {
  /** Name of the agent that still references the to-be-deleted resource. */
  referrer: string;
  /** Where in the referrer's YAML the reference lives (e.g. `skills[0]`). */
  fieldPath: string;
}

export type Action =
  // agents
  | {
      type: 'create';
      name: string;
      config: AgentConfig;
      filePath: string;
      forwardAgentDeps: string[];
      forwardSkillDeps: string[];
    }
  | {
      type: 'update';
      name: string;
      id: string;
      config: AgentConfig;
      filePath: string;
      currentVersion: number;
      diffs: FieldDiff[];
      forwardAgentDeps: string[];
      forwardSkillDeps: string[];
    }
  | { type: 'noop'; name: string; id: string; version: number }
  | {
      type: 'delete';
      name: string;
      id: string;
      warnings?: PlanWarning[];
    }
  // skills
  | { type: 'skill_create'; localName: string; skill: LocalSkill }
  | {
      type: 'skill_update';
      localName: string;
      id: string;
      skill: LocalSkill;
      currentVersion: string;
      currentHash: string;
    }
  | {
      type: 'skill_noop';
      localName: string;
      id: string;
      version: string;
      hash: string;
      displayTitle: string;
    }
  | {
      type: 'skill_delete';
      localName: string;
      id: string;
      warnings?: PlanWarning[];
    }
  // memory stores
  | {
      type: 'memstore_create';
      localName: string;
      config: MemoryStoreConfig;
      dirPath: string;
    }
  | {
      type: 'memstore_update';
      localName: string;
      id: string;
      config: MemoryStoreConfig;
      remote: RemoteMemoryStore;
      dirPath: string;
      diffs: FieldDiff[];
    }
  | {
      type: 'memstore_noop';
      localName: string;
      id: string;
      name: string;
    }
  | {
      type: 'memstore_archive';
      localName: string;
      id: string;
    }
  // environments
  | {
      type: 'env_create';
      localName: string;
      config: EnvironmentConfig;
      dirPath: string;
    }
  | {
      type: 'env_update';
      localName: string;
      id: string;
      config: EnvironmentConfig;
      remote: RemoteEnvironment;
      dirPath: string;
      diffs: FieldDiff[];
    }
  | {
      type: 'env_noop';
      localName: string;
      id: string;
      name: string;
    }
  | {
      type: 'env_archive';
      localName: string;
      id: string;
    }
  // vaults — current scope is create + archive only; updates are NOT
  // detected and credentials are not yet managed by cmaform.
  | {
      type: 'vault_create';
      localName: string;
      config: VaultConfig;
      dirPath: string;
    }
  | {
      type: 'vault_noop';
      localName: string;
      id: string;
      display_name: string;
    }
  | {
      type: 'vault_archive';
      localName: string;
      id: string;
    };

export async function computePlan(
  state: State,
  configs: Map<string, { config: AgentConfig; filePath: string }>,
  skills: Map<string, LocalSkill>,
  memoryStores: Map<string, { config: MemoryStoreConfig; dirPath: string }>,
  environments: Map<string, { config: EnvironmentConfig; dirPath: string }>,
  vaults: Map<string, LocalVault>,
  resolutions: Map<string, ResolvedConfig>,
  opts: { targets?: string[] } = {},
): Promise<Action[]> {
  const actions: Action[] = [];
  const dynamicLatestScope = agentNamesSelectedByTargets(configs, opts.targets ?? []);
  const pendingAgentActions: Array<{
    name: string;
    filePath: string;
    config: AgentConfig;
    remote: Awaited<ReturnType<typeof resolveRemote>>;
    forwardAgentDeps: string[];
    forwardSkillDeps: string[];
    latestAgentVersionRefs: { name: string; id: string; index?: number }[];
  }> = [];

  // ----- agents -----
  for (const [name, { filePath }] of configs) {
    const resolution = resolutions.get(name);
    // The resolved config (name refs replaced with id refs / sentinels) is
    // what we both diff against remote and ultimately send to the API.
    const resolvedConfig = resolution?.config ?? configs.get(name)!.config;
    const forwardAgentDeps = resolution?.forwardAgentDeps ?? [];
    const forwardSkillDeps = resolution?.forwardSkillDeps ?? [];
    const latestAgentVersionRefs = resolution?.latestAgentVersionRefs ?? [];

    const remote = await resolveRemote(name, state);
    pendingAgentActions.push({
      name,
      filePath,
      config: resolvedConfig,
      remote,
      forwardAgentDeps,
      forwardSkillDeps,
      latestAgentVersionRefs,
    });
  }

  const changedAgentNames = new Set<string>();
  for (const pending of pendingAgentActions) {
    if (!pending.remote || pending.remote.archived_at) {
      if (dynamicLatestScope.has(pending.name)) changedAgentNames.add(pending.name);
      continue;
    }
    if (fieldDiffs(pending.config, pending.remote).length > 0) {
      if (dynamicLatestScope.has(pending.name)) changedAgentNames.add(pending.name);
    }
  }
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const pending of pendingAgentActions) {
      if (changedAgentNames.has(pending.name)) continue;
      if (pending.latestAgentVersionRefs.some((ref) => changedAgentNames.has(ref.name))) {
        changedAgentNames.add(pending.name);
        propagated = true;
      }
    }
  }

  for (const pending of pendingAgentActions) {
    const dynamicAgentDeps = pending.latestAgentVersionRefs.filter((ref) =>
      changedAgentNames.has(ref.name),
    );
    const config =
      dynamicAgentDeps.length > 0
        ? markLatestAgentVersions(pending.config, dynamicAgentDeps)
        : pending.config;
    const forwardAgentDeps = [
      ...pending.forwardAgentDeps,
      ...dynamicAgentDeps.map((ref) => ref.name),
    ];

    if (!pending.remote || pending.remote.archived_at) {
      actions.push({
        type: 'create',
        name: pending.name,
        config,
        filePath: pending.filePath,
        forwardAgentDeps,
        forwardSkillDeps: pending.forwardSkillDeps,
      });
      continue;
    }
    const diffs = fieldDiffs(config, pending.remote);
    if (diffs.length === 0) {
      actions.push({
        type: 'noop',
        name: pending.name,
        id: pending.remote.id,
        version: pending.remote.version,
      });
    } else {
      actions.push({
        type: 'update',
        name: pending.name,
        id: pending.remote.id,
        config,
        filePath: pending.filePath,
        currentVersion: pending.remote.version,
        diffs,
        forwardAgentDeps,
        forwardSkillDeps: pending.forwardSkillDeps,
      });
    }
  }
  for (const [name, entry] of Object.entries(state.agents)) {
    if (!configs.has(name)) {
      actions.push({ type: 'delete', name, id: entry.id });
    }
  }

  // ----- skills -----
  for (const [localName, skill] of skills) {
    const tracked = state.skills[localName];
    if (!tracked) {
      // Not tracked in state, but if a remote skill with the same display_title exists, treat as update.
      const remote = await findSkillByDisplayTitle(skill.displayTitle);
      if (remote) {
        actions.push({
          type: 'skill_update',
          localName,
          id: remote.id,
          skill,
          currentVersion: remote.latest_version,
          currentHash: '(unknown)',
        });
      } else {
        actions.push({ type: 'skill_create', localName, skill });
      }
      continue;
    }

    if (tracked.hash === skill.hash) {
      actions.push({
        type: 'skill_noop',
        localName,
        id: tracked.id,
        version: tracked.version,
        hash: tracked.hash,
        displayTitle: tracked.display_title,
      });
    } else {
      actions.push({
        type: 'skill_update',
        localName,
        id: tracked.id,
        skill,
        currentVersion: tracked.version,
        currentHash: tracked.hash,
      });
    }
  }
  for (const [localName, entry] of Object.entries(state.skills)) {
    if (!skills.has(localName)) {
      actions.push({ type: 'skill_delete', localName, id: entry.id });
    }
  }

  // ----- memory stores -----
  for (const [localName, { config, dirPath }] of memoryStores) {
    const tracked = state.memory_stores[localName];
    const remote = tracked ? await retrieveMemoryStore(tracked.id) : null;
    if (!remote || remote.archived_at) {
      actions.push({ type: 'memstore_create', localName, config, dirPath });
      continue;
    }
    const diffs = memoryStoreFieldDiffs(config, remote);
    if (diffs.length === 0) {
      actions.push({
        type: 'memstore_noop',
        localName,
        id: remote.id,
        name: remote.name,
      });
    } else {
      actions.push({
        type: 'memstore_update',
        localName,
        id: remote.id,
        config,
        remote,
        dirPath,
        diffs,
      });
    }
  }
  for (const [localName, entry] of Object.entries(state.memory_stores)) {
    if (!memoryStores.has(localName)) {
      actions.push({ type: 'memstore_archive', localName, id: entry.id });
    }
  }

  // ----- environments -----
  for (const [localName, { config, dirPath }] of environments) {
    const tracked = state.environments[localName];
    const remote = tracked ? await retrieveEnvironment(tracked.id) : null;
    if (!remote || remote.archived_at) {
      actions.push({ type: 'env_create', localName, config, dirPath });
      continue;
    }
    const diffs = environmentFieldDiffs(config, remote);
    if (diffs.length === 0) {
      actions.push({
        type: 'env_noop',
        localName,
        id: remote.id,
        name: remote.name,
      });
    } else {
      actions.push({
        type: 'env_update',
        localName,
        id: remote.id,
        config,
        remote,
        dirPath,
        diffs,
      });
    }
  }
  for (const [localName, entry] of Object.entries(state.environments)) {
    if (!environments.has(localName)) {
      actions.push({ type: 'env_archive', localName, id: entry.id });
    }
  }

  // ----- vaults -----
  //
  // Scope: create + archive only. Updates to `display_name` / `metadata`
  // after the initial create are NOT detected — the resource is treated as
  // immutable from cmaform's perspective until the broader vault design
  // settles. Credentials are not managed by cmaform yet.
  for (const [localName, vault] of vaults) {
    const tracked = state.vaults[localName];
    const remote = tracked ? await retrieveVault(tracked.id) : null;

    if (!remote || remote.archived_at) {
      actions.push({
        type: 'vault_create',
        localName,
        config: vault.config,
        dirPath: vault.dirPath,
      });
    } else {
      actions.push({
        type: 'vault_noop',
        localName,
        id: remote.id,
        display_name: remote.display_name,
      });
    }
  }

  for (const [localName, entry] of Object.entries(state.vaults)) {
    if (!vaults.has(localName)) {
      actions.push({ type: 'vault_archive', localName, id: entry.id });
    }
  }

  return actions;
}

function agentNamesSelectedByTargets(
  configs: Map<string, { config: AgentConfig; filePath: string }>,
  targets: string[],
): Set<string> {
  if (targets.length === 0) return new Set(configs.keys());

  const selected = new Set<string>();
  for (const target of targets) {
    const kind = RESOURCE_KIND_ALIASES[target];
    if (kind === 'agent') {
      for (const name of configs.keys()) selected.add(name);
    } else if (!kind && configs.has(target)) {
      selected.add(target);
    }
  }
  return selected;
}

function markLatestAgentVersions(
  config: AgentConfig,
  refs: { name: string; id: string; index?: number }[],
): AgentConfig {
  if (!config.multiagent || !Array.isArray(config.multiagent.agents)) return config;

  const latestIndices = new Set(
    refs.flatMap((ref) => (typeof ref.index === 'number' ? [ref.index] : [])),
  );
  const latestIds = new Set(refs.map((ref) => ref.id));
  return {
    ...config,
    multiagent: {
      ...config.multiagent,
      agents: config.multiagent.agents.map((entry, idx) => {
        if (entry.type !== 'agent' || typeof entry.id !== 'string') return entry;
        if (latestIndices.size > 0) {
          if (!latestIndices.has(idx)) return entry;
          return { ...entry, version: 'latest' };
        }
        if (!latestIds.has(entry.id)) return entry;
        return { ...entry, version: 'latest' };
      }),
    },
  };
}

// ---------------- target filtering ----------------

type ResourceKind = 'agent' | 'skill' | 'memory_store' | 'environment' | 'vault';

function actionResourceName(a: Action): string {
  if (a.type === 'create' || a.type === 'update' || a.type === 'noop' || a.type === 'delete') {
    return a.name;
  }
  return (a as { localName: string }).localName;
}

function actionResourceKind(a: Action): ResourceKind {
  if (a.type.startsWith('skill_')) return 'skill';
  if (a.type.startsWith('memstore_')) return 'memory_store';
  if (a.type.startsWith('env_')) return 'environment';
  if (a.type.startsWith('vault_')) return 'vault';
  return 'agent';
}

const RESOURCE_KIND_ALIASES: Record<string, ResourceKind> = {
  agent: 'agent',
  agents: 'agent',
  skill: 'skill',
  skills: 'skill',
  memory_store: 'memory_store',
  memory_stores: 'memory_store',
  memstore: 'memory_store',
  memstores: 'memory_store',
  environment: 'environment',
  environments: 'environment',
  env: 'environment',
  envs: 'environment',
  vault: 'vault',
  vaults: 'vault',
};

export function filterActionsByTargets(
  actions: Action[],
  targets: string[],
): { filtered: Action[]; unmatched: string[] } {
  const kindTargets = new Set<ResourceKind>();
  const nameTargets = new Set<string>();
  for (const t of targets) {
    const kind = RESOURCE_KIND_ALIASES[t];
    if (kind) {
      kindTargets.add(kind);
    } else {
      nameTargets.add(t);
    }
  }

  const matchedNames = new Set<string>();
  const filtered: Action[] = [];
  for (const a of actions) {
    const kind = actionResourceKind(a);
    const name = actionResourceName(a);
    if (kindTargets.has(kind) || nameTargets.has(name)) {
      if (nameTargets.has(name)) matchedNames.add(name);
      filtered.push(a);
    }
  }

  const unmatched = [...nameTargets].filter((n) => !matchedNames.has(n));
  return { filtered, unmatched };
}

export function hasChanges(actions: Action[]): boolean {
  return actions.some(
    (a) =>
      a.type !== 'noop' &&
      a.type !== 'skill_noop' &&
      a.type !== 'memstore_noop' &&
      a.type !== 'env_noop' &&
      a.type !== 'vault_noop',
  );
}
