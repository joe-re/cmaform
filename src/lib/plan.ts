import {
  fieldDiffs,
  resolveRemote,
} from './agents.js';
import {
  environmentFieldDiffs,
  retrieveEnvironment,
} from './environments.js';
import {
  memoryStoreFieldDiffs,
  retrieveMemoryStore,
} from './memory-stores.js';
import type { ResolvedConfig } from './resolve.js';
import { findSkillByDisplayTitle } from './skills.js';
import {
  retrieveVault,
  vaultFieldDiffs,
  type LocalVault,
} from './vaults.js';
import type {
  AgentConfig,
  CredentialConfig,
  EnvironmentConfig,
  FieldDiff,
  LocalSkill,
  MemoryStoreConfig,
  RemoteEnvironment,
  RemoteMemoryStore,
  RemoteVault,
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
  // vaults
  | {
      type: 'vault_create';
      localName: string;
      config: VaultConfig;
      dirPath: string;
    }
  | {
      type: 'vault_update';
      localName: string;
      id: string;
      config: VaultConfig;
      remote: RemoteVault;
      dirPath: string;
      diffs: FieldDiff[];
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
      /** Credentials in state that will be cascade-archived along with the vault. */
      cascadedCredentials: string[];
    }
  // credentials (scope: create + archive only — see vaults-resource-support.md)
  | {
      type: 'cred_create';
      vaultLocalName: string;
      credLocalName: string;
      filePath: string;
      config: CredentialConfig;
    }
  | {
      type: 'cred_noop';
      vaultLocalName: string;
      credLocalName: string;
      id: string;
    }
  | {
      type: 'cred_archive';
      vaultLocalName: string;
      credLocalName: string;
      id: string;
      mcp_server_url: string;
    };

export async function computePlan(
  state: State,
  configs: Map<string, { config: AgentConfig; filePath: string }>,
  skills: Map<string, LocalSkill>,
  memoryStores: Map<string, { config: MemoryStoreConfig; dirPath: string }>,
  environments: Map<string, { config: EnvironmentConfig; dirPath: string }>,
  vaults: Map<string, LocalVault>,
  resolutions: Map<string, ResolvedConfig>
): Promise<Action[]> {
  const actions: Action[] = [];

  // ----- agents -----
  for (const [name, { filePath }] of configs) {
    const resolution = resolutions.get(name);
    // The resolved config (name refs replaced with id refs / sentinels) is
    // what we both diff against remote and ultimately send to the API.
    const resolvedConfig = resolution?.config ?? configs.get(name)!.config;
    const forwardAgentDeps = resolution?.forwardAgentDeps ?? [];
    const forwardSkillDeps = resolution?.forwardSkillDeps ?? [];

    const remote = await resolveRemote(name, state);
    if (!remote || remote.archived_at) {
      actions.push({
        type: 'create',
        name,
        config: resolvedConfig,
        filePath,
        forwardAgentDeps,
        forwardSkillDeps,
      });
      continue;
    }
    const diffs = fieldDiffs(resolvedConfig, remote);
    if (diffs.length === 0) {
      actions.push({
        type: 'noop',
        name,
        id: remote.id,
        version: remote.version,
      });
    } else {
      actions.push({
        type: 'update',
        name,
        id: remote.id,
        config: resolvedConfig,
        filePath,
        currentVersion: remote.version,
        diffs,
        forwardAgentDeps,
        forwardSkillDeps,
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

  // ----- vaults + credentials -----
  //
  // Per vaults-resource-support.md: vaults are full CRUD; credentials are
  // create + archive only (no update detection — secret values are
  // write-only on the API side).
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
      for (const [credLocalName, cred] of vault.credentials) {
        actions.push({
          type: 'cred_create',
          vaultLocalName: localName,
          credLocalName,
          filePath: cred.filePath,
          config: cred.config,
        });
      }
      continue;
    }

    const vaultDiffs = vaultFieldDiffs(vault.config, remote);
    if (vaultDiffs.length === 0) {
      actions.push({
        type: 'vault_noop',
        localName,
        id: remote.id,
        display_name: remote.display_name,
      });
    } else {
      actions.push({
        type: 'vault_update',
        localName,
        id: remote.id,
        config: vault.config,
        remote,
        dirPath: vault.dirPath,
        diffs: vaultDiffs,
      });
    }

    // Credential diff: new local file → create; missing local file → archive.
    const trackedCreds = tracked!.credentials;
    for (const [credLocalName, cred] of vault.credentials) {
      const trackedCred = trackedCreds[credLocalName];
      if (!trackedCred) {
        actions.push({
          type: 'cred_create',
          vaultLocalName: localName,
          credLocalName,
          filePath: cred.filePath,
          config: cred.config,
        });
      } else {
        actions.push({
          type: 'cred_noop',
          vaultLocalName: localName,
          credLocalName,
          id: trackedCred.id,
        });
      }
    }
    for (const [credLocalName, trackedCred] of Object.entries(trackedCreds)) {
      if (!vault.credentials.has(credLocalName)) {
        actions.push({
          type: 'cred_archive',
          vaultLocalName: localName,
          credLocalName,
          id: trackedCred.id,
          mcp_server_url: trackedCred.mcp_server_url,
        });
      }
    }
  }

  for (const [localName, entry] of Object.entries(state.vaults)) {
    if (!vaults.has(localName)) {
      // Vault archive cascades to its credentials API-side; surface the list
      // so plan output can WARN about it. Don't emit explicit cred_archive
      // actions (avoids double-archive errors).
      const cascadedCredentials = Object.keys(entry.credentials);
      actions.push({
        type: 'vault_archive',
        localName,
        id: entry.id,
        cascadedCredentials,
      });
    }
  }

  return actions;
}

// ---------------- target filtering ----------------

type ResourceKind =
  | 'agent'
  | 'skill'
  | 'memory_store'
  | 'environment'
  | 'vault'
  | 'credential';

function actionResourceName(a: Action): string {
  if (
    a.type === 'create' ||
    a.type === 'update' ||
    a.type === 'noop' ||
    a.type === 'delete'
  ) {
    return a.name;
  }
  if (a.type.startsWith('cred_')) {
    const c = a as { vaultLocalName: string; credLocalName: string };
    return `${c.vaultLocalName}/${c.credLocalName}`;
  }
  return (a as { localName: string }).localName;
}

function actionResourceKind(a: Action): ResourceKind {
  if (a.type.startsWith('skill_')) return 'skill';
  if (a.type.startsWith('memstore_')) return 'memory_store';
  if (a.type.startsWith('env_')) return 'environment';
  if (a.type.startsWith('vault_')) return 'vault';
  if (a.type.startsWith('cred_')) return 'credential';
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
  credential: 'credential',
  credentials: 'credential',
};

export function filterActionsByTargets(
  actions: Action[],
  targets: string[]
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

  const unmatched = [...nameTargets].filter(n => !matchedNames.has(n));
  return { filtered, unmatched };
}

export function hasChanges(actions: Action[]): boolean {
  return actions.some(
    a =>
      a.type !== 'noop' &&
      a.type !== 'skill_noop' &&
      a.type !== 'memstore_noop' &&
      a.type !== 'env_noop' &&
      a.type !== 'vault_noop' &&
      a.type !== 'cred_noop'
  );
}
