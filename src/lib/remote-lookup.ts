import { listAgents } from './agents.js';
import { listDeployments } from './deployments.js';
import { listEnvironments } from './environments.js';
import { listMemoryStores } from './memory-stores.js';
import { listSkills } from './skills.js';
import type {
  RemoteAgent,
  RemoteDeployment,
  RemoteEnvironment,
  RemoteMemoryStore,
  RemoteSkill,
  RemoteVault,
} from './types.js';
import { listVaults } from './vaults.js';

export type NameLookup<T> =
  | { kind: 'none' }
  | { kind: 'one'; remote: T }
  | { kind: 'ambiguous'; candidates: T[] };

export type RemoteResourceKind =
  | 'agent'
  | 'skill'
  | 'memory_store'
  | 'environment'
  | 'vault'
  | 'deployment';

export class AmbiguousRemoteNameError extends Error {
  constructor(
    readonly resourceKind: RemoteResourceKind,
    readonly resourceName: string,
    readonly candidates: { id: string; created_at?: string }[],
  ) {
    super(
      `multiple active ${resourceKind} resources on remote are named ${JSON.stringify(resourceName)} (${candidates
        .map((c) => c.id)
        .join(', ')})`,
    );
    this.name = 'AmbiguousRemoteNameError';
  }
}

export interface LookupOptions {
  /** Remote ids that must not be matched (e.g. already tracked under another local name). */
  excludeIds?: ReadonlySet<string>;
}

type LookupFn<T> = (name: string, opts?: LookupOptions) => Promise<NameLookup<T>>;

export interface RemoteLookup {
  agentByName: LookupFn<RemoteAgent>;
  skillByDisplayTitle: LookupFn<RemoteSkill>;
  memoryStoreByName: LookupFn<RemoteMemoryStore>;
  environmentByName: LookupFn<RemoteEnvironment>;
  vaultByDisplayName: LookupFn<RemoteVault>;
  deploymentByName: LookupFn<RemoteDeployment>;
}

interface Listed {
  id: string;
  archived_at?: string | null;
}

function makeLookup<T extends Listed>(
  list: () => Promise<T[]>,
  nameOf: (item: T) => string,
  { skipArchivedCheck = false } = {},
): LookupFn<T> {
  let cache: Promise<T[]> | undefined;
  return async (name, opts) => {
    cache ??= list();
    const all = await cache;
    const candidates = all.filter(
      (r) =>
        nameOf(r) === name && (skipArchivedCheck || !r.archived_at) && !opts?.excludeIds?.has(r.id),
    );
    if (candidates.length === 0) return { kind: 'none' };
    if (candidates.length === 1) return { kind: 'one', remote: candidates[0] };
    return { kind: 'ambiguous', candidates };
  };
}

/**
 * Create a per-run lookup. Each resource kind is listed from the API at most
 * once (lazily) and the result is reused for every later name query.
 */
export function createRemoteLookup(): RemoteLookup {
  return {
    agentByName: makeLookup(listAgents, (a) => a.name),
    // Skills have no archive concept: match on display_title only.
    skillByDisplayTitle: makeLookup(
      () => listSkills('custom'),
      (s) => s.display_title,
      {
        skipArchivedCheck: true,
      },
    ),
    memoryStoreByName: makeLookup(
      () => listMemoryStores(),
      (m) => m.name,
    ),
    environmentByName: makeLookup(
      () => listEnvironments(),
      (e) => e.name,
    ),
    vaultByDisplayName: makeLookup(
      () => listVaults(),
      (v) => v.display_name,
    ),
    deploymentByName: makeLookup(
      () => listDeployments(),
      (d) => d.name,
    ),
  };
}

export function requireUnique<T extends { id: string; created_at?: string }>(
  kind: RemoteResourceKind,
  name: string,
  lookup: NameLookup<T>,
): T | null {
  if (lookup.kind === 'none') return null;
  if (lookup.kind === 'one') return lookup.remote;
  throw new AmbiguousRemoteNameError(
    kind,
    name,
    lookup.candidates.map((c) => ({ id: c.id, created_at: c.created_at })),
  );
}

/**
 * Ids tracked in `entries` under a local name other than `localName`. Such a
 * resource belongs to another manifest (typically the old name after a
 * directory rename) and must not be adopted here, or the same remote resource
 * would be adopted and archived in one plan.
 */
export function idsTrackedElsewhere(
  entries: Record<string, { id: string }>,
  localName: string,
): ReadonlySet<string> {
  return new Set(
    Object.entries(entries)
      .filter(([name]) => name !== localName)
      .map(([, entry]) => entry.id),
  );
}
