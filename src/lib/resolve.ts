import { retrieveAgent } from './agents.js';
import { idsTrackedElsewhere, requireUnique, type RemoteLookup } from './remote-lookup.js';
import type {
  AgentConfig,
  DeploymentAgentRef,
  DeploymentConfig,
  EnvironmentConfig,
  LocalSkill,
  MemoryStoreConfig,
  RemoteAgent,
  ResolvedDeployment,
  State,
} from './types.js';
import type { LocalVault } from './vaults.js';

/**
 * Build-time context for resolving name-based references in agent YAML.
 *
 * Lookup order:
 *   1. cmaform.state.json (`state.agents[name]` / `state.skills[localName]`)
 *   2. Remote (listed once per run through `lookup`; several active matches
 *      are an error unless the name is tracked in state)
 *   3. Local apply set (agents in local YAML / skills as local directories)
 *      → treated as a "forward dependency": replaced with a sentinel ID and
 *        resolved at apply time after the dependency is actually created.
 *   4. Otherwise: unresolved (surfaced as an error by callers).
 */
export interface ResolutionContext {
  state: State;
  /** Local agent configs keyed by `name` field. */
  localAgents: Map<string, AgentConfig>;
  /** Local skills keyed by local directory name (= state key). */
  localSkills: Map<string, LocalSkill>;
  /**
   * Local environment directory names (= state keys) mapped to the name the
   * environment has on remote (the manifest's `name`).
   */
  localEnvironments: Map<string, string>;
  /**
   * Local vault directory names (= state keys) mapped to the vault's remote
   * name (the manifest's `display_name`).
   */
  localVaults: Map<string, string>;
  /**
   * Local memory store directory names (= state keys) mapped to the store's
   * remote name (the manifest's `name`).
   */
  localMemoryStores: Map<string, string>;
  /** Per-run cached remote name lookup, shared with `computePlan`. */
  lookup: RemoteLookup;
}

export function buildResolutionContext(args: {
  state: State;
  agents: Map<string, { config: AgentConfig; filePath: string }>;
  skills: Map<string, LocalSkill>;
  environments?: Map<string, { config: EnvironmentConfig }>;
  vaults?: Map<string, LocalVault>;
  memoryStores?: Map<string, { config: MemoryStoreConfig }>;
  lookup: RemoteLookup;
}): ResolutionContext {
  return {
    state: args.state,
    localAgents: new Map([...args.agents].map(([k, v]) => [k, v.config])),
    localSkills: args.skills,
    localEnvironments: new Map([...(args.environments ?? [])].map(([k, v]) => [k, v.config.name])),
    localVaults: new Map([...(args.vaults ?? [])].map(([k, v]) => [k, v.config.display_name])),
    localMemoryStores: new Map([...(args.memoryStores ?? [])].map(([k, v]) => [k, v.config.name])),
    lookup: args.lookup,
  };
}

// ---------------- sentinels ----------------
//
// When a name-based reference points to a resource that is itself in the
// current apply set (i.e. about to be created), we don't know its real ID
// yet. We substitute a sentinel string and replace it just before sending
// apply params to the API. The sentinel uses a prefix that is impossible
// to collide with a real Anthropic ID.

const PENDING_AGENT_ID_PREFIX = '__cmaform_pending_agent__:';
const PENDING_SKILL_ID_PREFIX = '__cmaform_pending_skill__:';
const PENDING_ENV_ID_PREFIX = '__cmaform_pending_environment__:';
const PENDING_VAULT_ID_PREFIX = '__cmaform_pending_vault__:';
const PENDING_MEMORY_STORE_ID_PREFIX = '__cmaform_pending_memory_store__:';

export function pendingAgentSentinel(name: string): string {
  return `${PENDING_AGENT_ID_PREFIX}${name}`;
}

export function pendingSkillSentinel(name: string): string {
  return `${PENDING_SKILL_ID_PREFIX}${name}`;
}

export function pendingEnvironmentSentinel(name: string): string {
  return `${PENDING_ENV_ID_PREFIX}${name}`;
}

export function pendingVaultSentinel(name: string): string {
  return `${PENDING_VAULT_ID_PREFIX}${name}`;
}

export function pendingMemoryStoreSentinel(name: string): string {
  return `${PENDING_MEMORY_STORE_ID_PREFIX}${name}`;
}

export function extractPendingAgent(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (!v.startsWith(PENDING_AGENT_ID_PREFIX)) return null;
  return v.slice(PENDING_AGENT_ID_PREFIX.length);
}

export function extractPendingSkill(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (!v.startsWith(PENDING_SKILL_ID_PREFIX)) return null;
  return v.slice(PENDING_SKILL_ID_PREFIX.length);
}

export function extractPendingEnvironment(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (!v.startsWith(PENDING_ENV_ID_PREFIX)) return null;
  return v.slice(PENDING_ENV_ID_PREFIX.length);
}

export function extractPendingVault(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (!v.startsWith(PENDING_VAULT_ID_PREFIX)) return null;
  return v.slice(PENDING_VAULT_ID_PREFIX.length);
}

export function extractPendingMemoryStore(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (!v.startsWith(PENDING_MEMORY_STORE_ID_PREFIX)) return null;
  return v.slice(PENDING_MEMORY_STORE_ID_PREFIX.length);
}

// ---------------- single-name resolution ----------------

export type AgentResolution =
  | { kind: 'resolved'; id: string; version: number }
  | { kind: 'forward'; name: string; sentinel: string }
  | { kind: 'missing' };

export async function resolveAgentName(
  name: string,
  ctx: ResolutionContext,
): Promise<AgentResolution> {
  const tracked = ctx.state.agents[name];
  if (tracked) {
    const remote = await trackedAgentRemote(name, tracked.id, ctx);
    if (!remote) {
      const byId = await retrieveAgent(tracked.id);
      if (byId && !byId.archived_at) {
        return { kind: 'resolved', id: tracked.id, version: byId.version };
      }
    }
    return {
      kind: 'resolved',
      id: tracked.id,
      version: remote ? remote.version : tracked.version,
    };
  }

  const remote = requireUnique('agent', name, await ctx.lookup.agentByName(name));
  if (remote) return { kind: 'resolved', id: remote.id, version: remote.version };

  if (ctx.localAgents.has(name)) {
    return { kind: 'forward', name, sentinel: pendingAgentSentinel(name) };
  }

  return { kind: 'missing' };
}

/**
 * The remote agent that is tracked in state under `name`, found through the
 * name lookup. Several same-named agents are not an error here: the tracked id
 * decides which one is meant. Null when the tracked id is not among the
 * active same-named agents.
 */
async function trackedAgentRemote(
  name: string,
  trackedId: string,
  ctx: ResolutionContext,
): Promise<RemoteAgent | null> {
  const found = await ctx.lookup.agentByName(name);
  if (found.kind === 'one') return found.remote.id === trackedId ? found.remote : null;
  if (found.kind === 'ambiguous') return found.candidates.find((c) => c.id === trackedId) ?? null;
  return null;
}

function agentStateEntryById(
  id: string,
  ctx: ResolutionContext,
): { name: string; version: number } | undefined {
  for (const [name, entry] of Object.entries(ctx.state.agents)) {
    if (entry.id === id) return { name, version: entry.version };
  }
  return undefined;
}

async function agentVersionByTrackedId(
  id: string,
  ctx: ResolutionContext,
): Promise<{ name: string; version: number } | undefined> {
  const tracked = agentStateEntryById(id, ctx);
  if (!tracked) return undefined;
  const remote = await trackedAgentRemote(tracked.name, id, ctx);
  if (remote) return { name: tracked.name, version: remote.version };
  const byId = await retrieveAgent(id);
  if (byId && !byId.archived_at) return { name: tracked.name, version: byId.version };
  return tracked;
}

async function remoteAgentVersionById(id: string): Promise<number | undefined> {
  const remote = await retrieveAgent(id);
  if (!remote || remote.archived_at) return undefined;
  return remote.version;
}

function shouldResolveAgentVersion(version: unknown): boolean {
  return version === undefined || version === 'latest';
}

function withResolvedAgentVersion(
  entry: Record<string, unknown>,
  version: number | undefined,
): Record<string, unknown> {
  if (!shouldResolveAgentVersion(entry.version) || version === undefined) return entry;
  return { ...entry, version };
}

function createdAgentVersionById(
  id: string,
  createdAgents: Map<string, string>,
  createdAgentVersions: Map<string, number>,
): number | undefined {
  for (const [name, createdId] of createdAgents) {
    if (createdId === id) return createdAgentVersions.get(name);
  }
  return undefined;
}

export type SkillResolution =
  | { kind: 'resolved'; id: string }
  | { kind: 'forward'; name: string; sentinel: string }
  | { kind: 'missing' };

export async function resolveSkillName(
  name: string,
  ctx: ResolutionContext,
): Promise<SkillResolution> {
  const tracked = ctx.state.skills[name];
  if (tracked) return { kind: 'resolved', id: tracked.id };

  const remote = requireUnique(
    'skill',
    name,
    await ctx.lookup.skillByDisplayTitle(name, {
      excludeIds: idsTrackedElsewhere(ctx.state.skills, name),
    }),
  );
  if (remote) return { kind: 'resolved', id: remote.id };

  if (ctx.localSkills.has(name)) {
    return { kind: 'forward', name, sentinel: pendingSkillSentinel(name) };
  }

  return { kind: 'missing' };
}

export type RefResolution =
  | { kind: 'resolved'; id: string }
  | { kind: 'forward'; name: string; sentinel: string }
  | { kind: 'missing' };

export async function resolveEnvironmentName(
  name: string,
  ctx: ResolutionContext,
): Promise<RefResolution> {
  const tracked = ctx.state.environments[name];
  if (tracked) return { kind: 'resolved', id: tracked.id };

  // A reference written as a local directory name is looked up under the
  // manifest's remote name (the same name `computePlan` adopts by). Anything
  // else is a best-effort lookup by the reference string itself.
  const remoteName = ctx.localEnvironments.get(name) ?? name;
  const remote = requireUnique(
    'environment',
    remoteName,
    await ctx.lookup.environmentByName(remoteName, {
      excludeIds: idsTrackedElsewhere(ctx.state.environments, name),
    }),
  );
  if (remote) return { kind: 'resolved', id: remote.id };

  if (ctx.localEnvironments.has(name)) {
    return { kind: 'forward', name, sentinel: pendingEnvironmentSentinel(name) };
  }

  return { kind: 'missing' };
}

export async function resolveVaultName(
  name: string,
  ctx: ResolutionContext,
): Promise<RefResolution> {
  const tracked = ctx.state.vaults[name];
  if (tracked) return { kind: 'resolved', id: tracked.id };

  const remoteName = ctx.localVaults.get(name) ?? name;
  const remote = requireUnique(
    'vault',
    remoteName,
    await ctx.lookup.vaultByDisplayName(remoteName, {
      excludeIds: idsTrackedElsewhere(ctx.state.vaults, name),
    }),
  );
  if (remote) return { kind: 'resolved', id: remote.id };

  if (ctx.localVaults.has(name)) {
    return { kind: 'forward', name, sentinel: pendingVaultSentinel(name) };
  }

  return { kind: 'missing' };
}

export async function resolveMemoryStoreName(
  name: string,
  ctx: ResolutionContext,
): Promise<RefResolution> {
  const tracked = ctx.state.memory_stores[name];
  if (tracked) return { kind: 'resolved', id: tracked.id };

  const remoteName = ctx.localMemoryStores.get(name) ?? name;
  const remote = requireUnique(
    'memory_store',
    remoteName,
    await ctx.lookup.memoryStoreByName(remoteName, {
      excludeIds: idsTrackedElsewhere(ctx.state.memory_stores, name),
    }),
  );
  if (remote) return { kind: 'resolved', id: remote.id };

  if (ctx.localMemoryStores.has(name)) {
    return { kind: 'forward', name, sentinel: pendingMemoryStoreSentinel(name) };
  }

  return { kind: 'missing' };
}

// ---------------- deployment config transformation ----------------

export interface ResolvedDeploymentConfig {
  config: ResolvedDeployment;
  /** Agent names that must be created before this deployment in the apply set. */
  forwardAgentDeps: string[];
  /** Environment names that must be created before this deployment. */
  forwardEnvDeps: string[];
  /** Vault names that must be created before this deployment. */
  forwardVaultDeps: string[];
  /** Memory store names that must be created before this deployment. */
  forwardMemoryStoreDeps: string[];
  /** References that could not be resolved anywhere — fatal. */
  missingRefs: string[];
  /** Pinned-id-vs-name assertion failures — fatal. */
  idMismatches: string[];
}

function normalizeAgentRef(agent: string | DeploymentAgentRef): DeploymentAgentRef {
  if (typeof agent === 'string') {
    return agent.startsWith('agent_') ? { id: agent } : { name: agent };
  }
  return agent;
}

/**
 * Resolve a deployment's `agent` / `environment` / `vault_ids` name references
 * into the id form the API expects, recording forward dependencies for any ref
 * that points at a resource being created in the same apply set.
 */
export async function resolveDeploymentConfig(
  config: DeploymentConfig,
  ctx: ResolutionContext,
): Promise<ResolvedDeploymentConfig> {
  const forwardAgentDeps: string[] = [];
  const forwardEnvDeps: string[] = [];
  const forwardVaultDeps: string[] = [];
  const forwardMemoryStoreDeps: string[] = [];
  const missingRefs: string[] = [];
  const idMismatches: string[] = [];

  // ----- agent -----
  const agentRef = normalizeAgentRef(config.agent);
  let resolvedAgent: { id: string; version?: number };
  if (agentRef.id) {
    resolvedAgent = { id: agentRef.id, version: agentRef.version };
    if (agentRef.name) {
      const res = await resolveAgentName(agentRef.name, ctx);
      if (res.kind === 'resolved' && res.id !== agentRef.id) {
        idMismatches.push(
          `agent "${agentRef.name}" pinned id=${agentRef.id}, resolved id=${res.id}`,
        );
      }
    }
  } else if (agentRef.name) {
    const res = await resolveAgentName(agentRef.name, ctx);
    if (res.kind === 'resolved') {
      resolvedAgent = { id: res.id, version: agentRef.version };
    } else if (res.kind === 'forward') {
      forwardAgentDeps.push(agentRef.name);
      resolvedAgent = { id: res.sentinel, version: agentRef.version };
    } else {
      missingRefs.push(`agent "${agentRef.name}"`);
      resolvedAgent = { id: agentRef.name, version: agentRef.version };
    }
  } else {
    missingRefs.push('agent (neither name nor id provided)');
    resolvedAgent = { id: '' };
  }

  // ----- environment -----
  let environmentId: string;
  if (config.environment.startsWith('env_')) {
    environmentId = config.environment;
  } else {
    const res = await resolveEnvironmentName(config.environment, ctx);
    if (res.kind === 'resolved') {
      environmentId = res.id;
    } else if (res.kind === 'forward') {
      forwardEnvDeps.push(config.environment);
      environmentId = res.sentinel;
    } else {
      missingRefs.push(`environment "${config.environment}"`);
      environmentId = config.environment;
    }
  }

  // ----- vault_ids -----
  let vaultIds: string[] | undefined;
  if (Array.isArray(config.vault_ids) && config.vault_ids.length > 0) {
    vaultIds = [];
    for (const ref of config.vault_ids) {
      if (typeof ref === 'string' && ref.startsWith('vlt_')) {
        vaultIds.push(ref);
        continue;
      }
      const res = await resolveVaultName(ref, ctx);
      if (res.kind === 'resolved') {
        vaultIds.push(res.id);
      } else if (res.kind === 'forward') {
        forwardVaultDeps.push(ref);
        vaultIds.push(res.sentinel);
      } else {
        missingRefs.push(`vault "${ref}"`);
        vaultIds.push(ref);
      }
    }
  }

  // ----- resources[] (memory_store name refs) -----
  let resources = config.resources;
  if (Array.isArray(resources)) {
    const newResources: unknown[] = [];
    for (const entry of resources) {
      const e = entry as Record<string, unknown> | null;
      if (!isPlainObject(e) || e.type !== 'memory_store' || typeof e.memory_store !== 'string') {
        newResources.push(entry);
        continue;
      }
      const { memory_store, memory_store_id: pinned, ...others } = e;
      const name = memory_store as string;
      const res = await resolveMemoryStoreName(name, ctx);
      // The API only knows `memory_store_id`; never let `memory_store` through.
      if (typeof pinned === 'string') {
        // Pin form: the written id is what gets sent. The name is only an
        // assertion, checked when it resolves to an existing store.
        if (res.kind === 'resolved' && res.id !== pinned) {
          idMismatches.push(
            `memory store "${name}" pinned memory_store_id=${pinned}, resolved memory_store_id=${res.id}`,
          );
        }
        newResources.push({ ...others, memory_store_id: pinned });
        continue;
      }
      let id: string;
      if (res.kind === 'resolved') {
        id = res.id;
      } else if (res.kind === 'forward') {
        forwardMemoryStoreDeps.push(name);
        id = res.sentinel;
      } else {
        missingRefs.push(`memory store "${name}"`);
        id = name;
      }
      newResources.push({ ...others, memory_store_id: id });
    }
    resources = newResources;
  }

  return {
    config: {
      name: config.name,
      description: config.description,
      agent: resolvedAgent,
      environment_id: environmentId,
      initial_events: config.initial_events,
      schedule: config.schedule,
      resources,
      vault_ids: vaultIds,
      metadata: config.metadata,
    },
    forwardAgentDeps,
    forwardEnvDeps,
    forwardVaultDeps,
    forwardMemoryStoreDeps,
    missingRefs,
    idMismatches,
  };
}

/**
 * Replace forward-dependency sentinels in a resolved deployment with the
 * freshly-issued ids once those dependencies have been created. Called just
 * before `createDeployment` / `updateDeployment`.
 */
export function substitutePendingDeploymentIds(
  config: ResolvedDeployment,
  created: {
    agents: Map<string, string>;
    environments: Map<string, string>;
    vaults: Map<string, string>;
    memoryStores: Map<string, string>;
  },
): ResolvedDeployment {
  const createdAgents = created.agents;
  const createdEnvironments = created.environments;
  const createdVaults = created.vaults;
  const out: ResolvedDeployment = { ...config };

  const pendingAgent = extractPendingAgent(out.agent.id);
  if (pendingAgent) {
    const id = createdAgents.get(pendingAgent);
    if (!id) throw new Error(`internal: agent "${pendingAgent}" referenced but not yet created`);
    out.agent = { ...out.agent, id };
  }

  const pendingEnv = extractPendingEnvironment(out.environment_id);
  if (pendingEnv) {
    const id = createdEnvironments.get(pendingEnv);
    if (!id)
      throw new Error(`internal: environment "${pendingEnv}" referenced but not yet created`);
    out.environment_id = id;
  }

  if (Array.isArray(out.vault_ids)) {
    out.vault_ids = out.vault_ids.map((v) => {
      const pendingVault = extractPendingVault(v);
      if (!pendingVault) return v;
      const id = createdVaults.get(pendingVault);
      if (!id) throw new Error(`internal: vault "${pendingVault}" referenced but not yet created`);
      return id;
    });
  }

  if (Array.isArray(out.resources)) {
    out.resources = out.resources.map((entry) => {
      const e = entry as Record<string, unknown> | null;
      if (!isPlainObject(e) || e.type !== 'memory_store') return entry;
      const pending = extractPendingMemoryStore(e.memory_store_id);
      if (!pending) return entry;
      const id = created.memoryStores.get(pending);
      if (!id) {
        throw new Error(`internal: memory store "${pending}" referenced but not yet created`);
      }
      return { ...e, memory_store_id: id };
    });
  }

  return out;
}

// ---------------- config transformation ----------------

export interface ResolvedConfig {
  config: AgentConfig;
  /** Names of agents that must be created before this one in the apply set. */
  forwardAgentDeps: string[];
  /** Local skill names that must be created before this one. */
  forwardSkillDeps: string[];
  /** Name-based agent refs that could not be resolved anywhere — fatal. */
  missingAgentRefs: string[];
  /** Name-based skill refs that could not be resolved anywhere — fatal. */
  missingSkillRefs: string[];
  /**
   * Agent refs whose YAML omitted `version` or wrote `version: latest`.
   * If one of these agents is updated in the same apply run, the dependent
   * must be updated after it with that newly-created version.
   */
  latestAgentVersionRefs: { name: string; id: string; index?: number }[];
  /**
   * Assertion failures from entries that wrote both `name` and `id` (or
   * `skill_id`). Each entry is `<refKind> "<name>" pinned id=<written>,
   * resolved=<actual>`. Surfaced to the caller, who should fail the plan.
   */
  idMismatches: string[];
}

/**
 * Walk an AgentConfig and replace every name-based reference in
 * `multiagent.agents[]` and `skills[]` with the resolved form expected
 * by the Anthropic API. Existing `id` / `skill_id` references are kept
 * as-is. Returns the resolved config plus dependency metadata.
 */
export async function resolveAgentConfig(
  config: AgentConfig,
  ctx: ResolutionContext,
): Promise<ResolvedConfig> {
  const forwardAgentDeps: string[] = [];
  const forwardSkillDeps: string[] = [];
  const missingAgentRefs: string[] = [];
  const missingSkillRefs: string[] = [];
  const latestAgentVersionRefs: { name: string; id: string; index: number }[] = [];
  const idMismatches: string[] = [];

  const resolved: AgentConfig = { ...config };

  // ----- multiagent.agents[] -----
  if (resolved.multiagent && Array.isArray(resolved.multiagent.agents)) {
    const newAgents: unknown[] = [];
    for (const [idx, entry] of resolved.multiagent.agents.entries()) {
      const e = entry as unknown as Record<string, unknown> | null;
      // Pin-form: both `name` and `id` provided. Resolve the name and assert
      // the resolved id matches the pinned one. Useful as a safety net during
      // migration from id-based to name-based references.
      if (
        e &&
        typeof e === 'object' &&
        e.type === 'agent' &&
        typeof e.id === 'string' &&
        typeof e.name === 'string'
      ) {
        const res = await resolveAgentName(e.name, ctx);
        if (res.kind === 'resolved' && res.id !== e.id) {
          idMismatches.push(`agent "${e.name}" pinned id=${e.id}, resolved id=${res.id}`);
        }
        if (shouldResolveAgentVersion(e.version)) {
          latestAgentVersionRefs.push({ name: e.name, id: e.id, index: idx });
        }
        // Pass through the original id form. Mismatch (if any) is surfaced
        // via idMismatches; the caller decides whether to fail.
        newAgents.push(
          withResolvedAgentVersion(
            e,
            res.kind === 'resolved'
              ? res.version
              : (await agentVersionByTrackedId(e.id, ctx))?.version,
          ),
        );
        continue;
      }
      if (
        e &&
        typeof e === 'object' &&
        e.type === 'agent' &&
        typeof e.id !== 'string' &&
        typeof e.name === 'string'
      ) {
        const res = await resolveAgentName(e.name, ctx);
        if (res.kind === 'resolved') {
          if (shouldResolveAgentVersion(e.version)) {
            latestAgentVersionRefs.push({ name: e.name, id: res.id, index: idx });
          }
          newAgents.push({
            type: 'agent',
            id: res.id,
            version: shouldResolveAgentVersion(e.version) ? res.version : e.version,
          });
        } else if (res.kind === 'forward') {
          forwardAgentDeps.push(e.name);
          newAgents.push({
            type: 'agent',
            id: res.sentinel,
            ...(e.version !== undefined ? { version: e.version } : {}),
          });
        } else {
          missingAgentRefs.push(e.name);
          newAgents.push(entry);
        }
      } else if (e && typeof e === 'object' && e.type === 'agent' && typeof e.id === 'string') {
        const tracked = await agentVersionByTrackedId(e.id, ctx);
        if (tracked && shouldResolveAgentVersion(e.version)) {
          latestAgentVersionRefs.push({ name: tracked.name, id: e.id, index: idx });
        }
        if (e.version === 'latest' && !tracked) {
          const version = await remoteAgentVersionById(e.id);
          if (version === undefined) {
            throw new Error(
              `agent "${config.name}" references raw id ${JSON.stringify(
                e.id,
              )} with version: latest, but the agent could not be retrieved`,
            );
          }
          newAgents.push({ ...e, version });
        } else {
          newAgents.push(withResolvedAgentVersion(e, tracked?.version));
        }
      } else {
        newAgents.push(entry);
      }
    }
    resolved.multiagent = {
      ...resolved.multiagent,
      agents: newAgents as typeof resolved.multiagent.agents,
    };
  }

  // ----- skills[] -----
  if (Array.isArray(resolved.skills)) {
    const newSkills: unknown[] = [];
    for (const entry of resolved.skills) {
      const e = entry as unknown as Record<string, unknown> | null;
      // Pin-form: both `name` and `skill_id` provided (custom skills only).
      if (
        e &&
        typeof e === 'object' &&
        e.type === 'custom' &&
        typeof e.skill_id === 'string' &&
        typeof e.name === 'string'
      ) {
        const res = await resolveSkillName(e.name, ctx);
        if (res.kind === 'resolved' && res.id !== e.skill_id) {
          idMismatches.push(
            `skill "${e.name}" pinned skill_id=${e.skill_id}, resolved skill_id=${res.id}`,
          );
        }
        newSkills.push(entry);
        continue;
      }
      if (
        e &&
        typeof e === 'object' &&
        e.type === 'custom' &&
        typeof e.skill_id !== 'string' &&
        typeof e.name === 'string'
      ) {
        const res = await resolveSkillName(e.name, ctx);
        if (res.kind === 'resolved') {
          newSkills.push({
            type: 'custom',
            skill_id: res.id,
            ...(e.version !== undefined ? { version: e.version } : {}),
          });
        } else if (res.kind === 'forward') {
          forwardSkillDeps.push(e.name);
          newSkills.push({
            type: 'custom',
            skill_id: res.sentinel,
            ...(e.version !== undefined ? { version: e.version } : {}),
          });
        } else {
          missingSkillRefs.push(e.name);
          newSkills.push(entry);
        }
      } else {
        newSkills.push(entry);
      }
    }
    resolved.skills = newSkills;
  }

  return {
    config: resolved,
    forwardAgentDeps,
    forwardSkillDeps,
    missingAgentRefs,
    missingSkillRefs,
    latestAgentVersionRefs,
    idMismatches,
  };
}

// ---------------- sentinel substitution at apply time ----------------

/**
 * After a forward dependency is actually created, walk the resolved config
 * one more time and replace any sentinels with the freshly-issued IDs.
 * Called immediately before `createAgent` / `updateAgent`.
 */
export function substitutePendingIds(
  config: AgentConfig,
  createdAgents: Map<string, string>,
  createdSkills: Map<string, string>,
  createdAgentVersions: Map<string, number> = new Map(),
): AgentConfig {
  const out: AgentConfig = { ...config };

  if (out.multiagent && Array.isArray(out.multiagent.agents)) {
    out.multiagent = {
      ...out.multiagent,
      agents: out.multiagent.agents.map((entry) => {
        const e = entry as unknown as Record<string, unknown> | null;
        if (e && typeof e === 'object' && e.type === 'agent') {
          const pending = extractPendingAgent(e.id);
          if (pending) {
            const resolvedId = createdAgents.get(pending);
            if (!resolvedId) {
              throw new Error(`internal: agent "${pending}" referenced but not yet created`);
            }
            return withResolvedAgentVersion(
              { ...e, id: resolvedId },
              createdAgentVersions.get(pending),
            );
          }
        }
        if (e && typeof e === 'object' && e.type === 'agent' && typeof e.id === 'string') {
          return withResolvedAgentVersion(
            e,
            createdAgentVersionById(e.id, createdAgents, createdAgentVersions),
          );
        }
        return entry;
      }) as typeof out.multiagent.agents,
    };
  }

  if (Array.isArray(out.skills)) {
    out.skills = out.skills.map((entry) => {
      const e = entry as unknown as Record<string, unknown> | null;
      if (e && typeof e === 'object' && e.type === 'custom') {
        const pending = extractPendingSkill(e.skill_id);
        if (pending) {
          const resolvedId = createdSkills.get(pending);
          if (!resolvedId) {
            throw new Error(`internal: skill "${pending}" referenced but not yet created`);
          }
          return { ...e, skill_id: resolvedId };
        }
      }
      return entry;
    });
  }

  return out;
}

// ---------------- pretty rendering for diff display ----------------

/**
 * Replace sentinels with a human-readable placeholder for diff display.
 * The actual diff comparison still uses the sentinel string so that the
 * field is correctly detected as "changed".
 */
export function prettifySentinelsForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => prettifySentinelsForDisplay(v));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = prettifySentinelsForDisplay(v);
    }
    return out;
  }
  if (typeof value === 'string') {
    const a = extractPendingAgent(value);
    if (a) return `<pending: agent "${a}">`;
    const s = extractPendingSkill(value);
    if (s) return `<pending: skill "${s}">`;
    const e = extractPendingEnvironment(value);
    if (e) return `<pending: environment "${e}">`;
    const v = extractPendingVault(value);
    if (v) return `<pending: vault "${v}">`;
    const m = extractPendingMemoryStore(value);
    if (m) return `<pending: memory_store "${m}">`;
  }
  return value;
}

// ---------------- writeback: id → name ----------------

/**
 * When writing a remote agent's `multiagent.agents` / `skills` back to YAML,
 * prefer the human-friendly name form for any reference whose ID is tracked
 * in state. Falls back to the original id form for unknown IDs.
 */
export function rewriteAgentRefsToNameForm(
  agents: unknown[] | undefined,
  state: State,
): unknown[] | undefined {
  if (!Array.isArray(agents)) return agents;
  const idToName = new Map<string, string>();
  for (const [name, entry] of Object.entries(state.agents)) {
    idToName.set(entry.id, name);
  }
  return agents.map((entry) => {
    const e = entry as Record<string, unknown> | null;
    if (e && typeof e === 'object' && e.type === 'agent' && typeof e.id === 'string') {
      const name = idToName.get(e.id);
      if (name) {
        const out: Record<string, unknown> = { type: 'agent', name };
        if (e.version !== undefined) out.version = e.version;
        return out;
      }
    }
    return entry;
  });
}

export function rewriteSkillRefsToNameForm(
  skills: unknown[] | undefined,
  state: State,
): unknown[] | undefined {
  if (!Array.isArray(skills)) return skills;
  const idToLocalName = new Map<string, string>();
  for (const [localName, entry] of Object.entries(state.skills)) {
    idToLocalName.set(entry.id, localName);
  }
  return skills.map((entry) => {
    const e = entry as Record<string, unknown> | null;
    if (e && typeof e === 'object' && e.type === 'custom' && typeof e.skill_id === 'string') {
      const name = idToLocalName.get(e.skill_id);
      if (name) {
        const out: Record<string, unknown> = { type: 'custom', name };
        if (e.version !== undefined) out.version = e.version;
        return out;
      }
    }
    return entry;
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
