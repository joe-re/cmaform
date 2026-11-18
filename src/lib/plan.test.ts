import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agents.js')>();
  return {
    ...actual,
    resolveRemote: vi.fn(),
  };
});

vi.mock('./memory-stores.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memory-stores.js')>()),
  retrieveMemoryStore: vi.fn(),
}));
vi.mock('./environments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./environments.js')>()),
  retrieveEnvironment: vi.fn(),
}));
vi.mock('./vaults.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vaults.js')>()),
  retrieveVault: vi.fn(),
}));
vi.mock('./deployments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./deployments.js')>()),
  retrieveDeployment: vi.fn(),
}));

import { resolveRemote } from './agents.js';
import { retrieveDeployment } from './deployments.js';
import { retrieveEnvironment } from './environments.js';
import { retrieveMemoryStore } from './memory-stores.js';
import { AmbiguousRemoteNameError, type NameLookup, type RemoteLookup } from './remote-lookup.js';
import { retrieveVault } from './vaults.js';
import {
  actionKey,
  classifyUnmatchedTargets,
  computePlan,
  filterActionsByTargets,
  hasChanges,
  validResourceKinds,
  type Action,
  type PlanAmbiguity,
} from './plan.js';
import {
  UNKNOWN_SKILL_HASH,
  type AgentConfig,
  type RemoteAgent,
  type RemoteDeployment,
  type RemoteEnvironment,
  type RemoteMemoryStore,
  type RemoteVault,
  type ResolvedDeployment,
  type State,
} from './types.js';

const noop: Action = {
  type: 'noop',
  name: 'agent-a',
  id: 'agent_1',
  version: 1,
};

const skillNoop: Action = {
  type: 'skill_noop',
  localName: 'skill-a',
  id: 'skill_1',
  version: 'v1',
  hash: 'h1',
  displayTitle: 'Skill A',
};

const memstoreCreate: Action = {
  type: 'memstore_create',
  localName: 'memory-a',
  config: { name: 'Memory A' },
  dirPath: 'memory_stores/memory-a',
};

const envArchive: Action = {
  type: 'env_archive',
  localName: 'env-a',
  id: 'env_1',
};

const vaultNoop: Action = {
  type: 'vault_noop',
  localName: 'vault-a',
  id: 'vault_1',
  display_name: 'Vault A',
};

describe('filterActionsByTargets', () => {
  const actions = [noop, skillNoop, memstoreCreate, envArchive, vaultNoop];

  it('filters by resource kind aliases', () => {
    expect(filterActionsByTargets(actions, ['skills']).filtered).toEqual([skillNoop]);
    expect(filterActionsByTargets(actions, ['memstore']).filtered).toEqual([memstoreCreate]);
    expect(filterActionsByTargets(actions, ['env']).filtered).toEqual([envArchive]);
    expect(filterActionsByTargets(actions, ['vaults']).filtered).toEqual([vaultNoop]);
  });

  it('filters by local resource name and reports unmatched names', () => {
    expect(filterActionsByTargets(actions, ['agent-a', 'missing'])).toMatchObject({
      filtered: [noop],
      unmatched: ['missing'],
    });
  });
});

describe('hasChanges', () => {
  it('returns false for no-op actions only', () => {
    expect(hasChanges([noop, skillNoop, vaultNoop])).toBe(false);
  });

  it('returns true when any action changes remote state', () => {
    expect(hasChanges([noop, memstoreCreate])).toBe(true);
  });
});

describe('computePlan', () => {
  beforeEach(() => {
    vi.mocked(resolveRemote).mockReset();
  });

  it('updates a coordinator latest pin when the sub-agent changes in the same plan', async () => {
    const state: State = {
      agents: {
        'spec-qa': { id: 'agent_child', version: 9 },
        coordinator: { id: 'agent_coord', version: 5 },
      },
      skills: {},
      memory_stores: {},
      environments: {},
      vaults: {},
      deployments: {},
    };
    const childConfig: AgentConfig = { name: 'spec-qa', system: 'new prompt' };
    const coordinatorConfig: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: 'agent_child', version: 9 }],
      },
    };
    const childRemote: RemoteAgent = {
      id: 'agent_child',
      version: 9,
      name: 'spec-qa',
      archived_at: null,
      system: 'old prompt',
    };
    const coordinatorRemote: RemoteAgent = {
      id: 'agent_coord',
      version: 5,
      name: 'coordinator',
      archived_at: null,
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: 'agent_child', version: 9 }],
      },
    };

    vi.mocked(resolveRemote).mockImplementation(async (name) => {
      if (name === 'spec-qa') return childRemote;
      if (name === 'coordinator') return coordinatorRemote;
      return null;
    });

    const actions = await computePlan(
      state,
      new Map([
        ['spec-qa', { config: childConfig, filePath: 'agents/spec-qa.yaml' }],
        ['coordinator', { config: coordinatorConfig, filePath: 'agents/coordinator.yaml' }],
      ]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(), // deployments
      new Map([
        [
          'spec-qa',
          {
            config: childConfig,
            forwardAgentDeps: [],
            forwardSkillDeps: [],
            missingAgentRefs: [],
            missingSkillRefs: [],
            latestAgentVersionRefs: [],
            idMismatches: [],
            ambiguousRefs: [],
          },
        ],
        [
          'coordinator',
          {
            config: coordinatorConfig,
            forwardAgentDeps: [],
            forwardSkillDeps: [],
            missingAgentRefs: [],
            missingSkillRefs: [],
            latestAgentVersionRefs: [{ name: 'spec-qa', id: 'agent_child' }],
            idMismatches: [],
            ambiguousRefs: [],
          },
        ],
      ]),
      new Map(), // deploymentResolutions
    );

    const coordinatorUpdate = actions.find(
      (a): a is Extract<Action, { type: 'update' }> =>
        a.type === 'update' && a.name === 'coordinator',
    );
    expect(coordinatorUpdate).toBeDefined();
    expect(coordinatorUpdate?.forwardAgentDeps).toEqual(['spec-qa']);
    expect(coordinatorUpdate?.config.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_child', version: 'latest' },
    ]);
  });

  it('does not rewrite explicit numeric pins that share an id with a latest ref', async () => {
    const state: State = {
      agents: {
        'spec-qa': { id: 'agent_child', version: 9 },
        coordinator: { id: 'agent_coord', version: 5 },
      },
      skills: {},
      memory_stores: {},
      environments: {},
      vaults: {},
      deployments: {},
    };
    const childConfig: AgentConfig = { name: 'spec-qa', system: 'new prompt' };
    const coordinatorConfig: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [
          { type: 'agent', id: 'agent_child', version: 3 },
          { type: 'agent', id: 'agent_child', version: 9 },
        ],
      },
    };
    const childRemote: RemoteAgent = {
      id: 'agent_child',
      version: 9,
      name: 'spec-qa',
      archived_at: null,
      system: 'old prompt',
    };
    const coordinatorRemote: RemoteAgent = {
      id: 'agent_coord',
      version: 5,
      name: 'coordinator',
      archived_at: null,
      multiagent: {
        type: 'coordinator',
        agents: [
          { type: 'agent', id: 'agent_child', version: 3 },
          { type: 'agent', id: 'agent_child', version: 9 },
        ],
      },
    };

    vi.mocked(resolveRemote).mockImplementation(async (name) => {
      if (name === 'spec-qa') return childRemote;
      if (name === 'coordinator') return coordinatorRemote;
      return null;
    });

    const actions = await computePlan(
      state,
      new Map([
        ['spec-qa', { config: childConfig, filePath: 'agents/spec-qa.yaml' }],
        ['coordinator', { config: coordinatorConfig, filePath: 'agents/coordinator.yaml' }],
      ]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(), // deployments
      new Map([
        [
          'spec-qa',
          {
            config: childConfig,
            forwardAgentDeps: [],
            forwardSkillDeps: [],
            missingAgentRefs: [],
            missingSkillRefs: [],
            latestAgentVersionRefs: [],
            idMismatches: [],
            ambiguousRefs: [],
          },
        ],
        [
          'coordinator',
          {
            config: coordinatorConfig,
            forwardAgentDeps: [],
            forwardSkillDeps: [],
            missingAgentRefs: [],
            missingSkillRefs: [],
            latestAgentVersionRefs: [
              { name: 'spec-qa', id: 'agent_child', index: 1 } as {
                name: string;
                id: string;
              },
            ],
            idMismatches: [],
            ambiguousRefs: [],
          },
        ],
      ]),
      new Map(), // deploymentResolutions
    );

    const coordinatorUpdate = actions.find(
      (a): a is Extract<Action, { type: 'update' }> =>
        a.type === 'update' && a.name === 'coordinator',
    );
    expect(coordinatorUpdate?.config.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_child', version: 3 },
      { type: 'agent', id: 'agent_child', version: 'latest' },
    ]);
  });

  it('does not add latest deps for changed agents outside the target filter', async () => {
    const state: State = {
      agents: {
        'spec-qa': { id: 'agent_child', version: 9 },
        coordinator: { id: 'agent_coord', version: 5 },
      },
      skills: {},
      memory_stores: {},
      environments: {},
      vaults: {},
      deployments: {},
    };
    const childConfig: AgentConfig = { name: 'spec-qa', system: 'new prompt' };
    const coordinatorConfig: AgentConfig = {
      name: 'coordinator',
      description: 'new coordinator description',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: 'agent_child', version: 9 }],
      },
    };
    const childRemote: RemoteAgent = {
      id: 'agent_child',
      version: 9,
      name: 'spec-qa',
      archived_at: null,
      system: 'old prompt',
    };
    const coordinatorRemote: RemoteAgent = {
      id: 'agent_coord',
      version: 5,
      name: 'coordinator',
      archived_at: null,
      description: 'old coordinator description',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: 'agent_child', version: 9 }],
      },
    };

    vi.mocked(resolveRemote).mockImplementation(async (name) => {
      if (name === 'spec-qa') return childRemote;
      if (name === 'coordinator') return coordinatorRemote;
      return null;
    });

    const actions = await computePlan(
      state,
      new Map([
        ['spec-qa', { config: childConfig, filePath: 'agents/spec-qa.yaml' }],
        ['coordinator', { config: coordinatorConfig, filePath: 'agents/coordinator.yaml' }],
      ]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(), // deployments
      new Map([
        [
          'spec-qa',
          {
            config: childConfig,
            forwardAgentDeps: [],
            forwardSkillDeps: [],
            missingAgentRefs: [],
            missingSkillRefs: [],
            latestAgentVersionRefs: [],
            idMismatches: [],
            ambiguousRefs: [],
          },
        ],
        [
          'coordinator',
          {
            config: coordinatorConfig,
            forwardAgentDeps: [],
            forwardSkillDeps: [],
            missingAgentRefs: [],
            missingSkillRefs: [],
            latestAgentVersionRefs: [{ name: 'spec-qa', id: 'agent_child' }],
            idMismatches: [],
            ambiguousRefs: [],
          },
        ],
      ]),
      new Map(), // deploymentResolutions
      { targets: ['coordinator'] },
    );

    const coordinatorUpdate = actions.find(
      (a): a is Extract<Action, { type: 'update' }> =>
        a.type === 'update' && a.name === 'coordinator',
    );
    expect(coordinatorUpdate).toBeDefined();
    expect(coordinatorUpdate?.forwardAgentDeps).toEqual([]);
    expect(coordinatorUpdate?.config.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_child', version: 9 },
    ]);
  });

  it('propagates latest pin updates through transitive agent chains', async () => {
    const state: State = {
      agents: {
        a: { id: 'agent_a', version: 1 },
        b: { id: 'agent_b', version: 1 },
        c: { id: 'agent_c', version: 1 },
      },
      skills: {},
      memory_stores: {},
      environments: {},
      vaults: {},
      deployments: {},
    };
    const aConfig: AgentConfig = { name: 'a', system: 'new prompt' };
    const bConfig: AgentConfig = {
      name: 'b',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: 'agent_a', version: 1 }],
      },
    };
    const cConfig: AgentConfig = {
      name: 'c',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: 'agent_b', version: 1 }],
      },
    };
    const remotes: Record<string, RemoteAgent> = {
      a: { id: 'agent_a', version: 1, name: 'a', archived_at: null, system: 'old prompt' },
      b: {
        id: 'agent_b',
        version: 1,
        name: 'b',
        archived_at: null,
        multiagent: { type: 'coordinator', agents: [{ type: 'agent', id: 'agent_a', version: 1 }] },
      },
      c: {
        id: 'agent_c',
        version: 1,
        name: 'c',
        archived_at: null,
        multiagent: { type: 'coordinator', agents: [{ type: 'agent', id: 'agent_b', version: 1 }] },
      },
    };

    vi.mocked(resolveRemote).mockImplementation(async (name) => remotes[name] ?? null);

    const actions = await computePlan(
      state,
      new Map([
        ['a', { config: aConfig, filePath: 'agents/a.yaml' }],
        ['b', { config: bConfig, filePath: 'agents/b.yaml' }],
        ['c', { config: cConfig, filePath: 'agents/c.yaml' }],
      ]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(), // deployments
      new Map([
        [
          'a',
          {
            config: aConfig,
            forwardAgentDeps: [],
            forwardSkillDeps: [],
            missingAgentRefs: [],
            missingSkillRefs: [],
            latestAgentVersionRefs: [],
            idMismatches: [],
            ambiguousRefs: [],
          },
        ],
        [
          'b',
          {
            config: bConfig,
            forwardAgentDeps: [],
            forwardSkillDeps: [],
            missingAgentRefs: [],
            missingSkillRefs: [],
            latestAgentVersionRefs: [{ name: 'a', id: 'agent_a' }],
            idMismatches: [],
            ambiguousRefs: [],
          },
        ],
        [
          'c',
          {
            config: cConfig,
            forwardAgentDeps: [],
            forwardSkillDeps: [],
            missingAgentRefs: [],
            missingSkillRefs: [],
            latestAgentVersionRefs: [{ name: 'b', id: 'agent_b' }],
            idMismatches: [],
            ambiguousRefs: [],
          },
        ],
      ]),
      new Map(), // deploymentResolutions
    );

    const updates = actions.filter(
      (a): a is Extract<Action, { type: 'update' }> => a.type === 'update',
    );
    expect(updates.map((a) => a.name).sort()).toEqual(['a', 'b', 'c']);
    expect(updates.find((a) => a.name === 'b')?.forwardAgentDeps).toEqual(['a']);
    expect(updates.find((a) => a.name === 'c')?.forwardAgentDeps).toEqual(['b']);
  });
});

describe('computePlan — adopting same-named remote resources', () => {
  beforeEach(() => {
    vi.mocked(resolveRemote).mockReset();
    vi.mocked(retrieveMemoryStore).mockReset().mockResolvedValue(null);
    vi.mocked(retrieveEnvironment).mockReset().mockResolvedValue(null);
    vi.mocked(retrieveVault).mockReset().mockResolvedValue(null);
    vi.mocked(retrieveDeployment).mockReset().mockResolvedValue(null);
  });

  function emptyState(): State {
    return {
      agents: {},
      skills: {},
      memory_stores: {},
      environments: {},
      vaults: {},
      deployments: {},
    };
  }

  type Named = { id: string; archived_at?: string | null };
  function listLookup<T extends Named>(items: T[], nameOf: (t: T) => string) {
    return async (
      name: string,
      opts?: { excludeIds?: ReadonlySet<string> },
    ): Promise<NameLookup<T>> => {
      const c = items.filter(
        (r) => nameOf(r) === name && !r.archived_at && !opts?.excludeIds?.has(r.id),
      );
      if (c.length === 0) return { kind: 'none' };
      if (c.length === 1) return { kind: 'one', remote: c[0] };
      return { kind: 'ambiguous', candidates: c };
    };
  }

  function makeLookup(
    remote: {
      memoryStores?: RemoteMemoryStore[];
      environments?: RemoteEnvironment[];
      vaults?: RemoteVault[];
      deployments?: RemoteDeployment[];
    } = {},
  ): RemoteLookup {
    const none = async (): Promise<NameLookup<never>> => ({ kind: 'none' });
    return {
      agentByName: none,
      skillByDisplayTitle: none,
      memoryStoreByName: listLookup(remote.memoryStores ?? [], (r) => r.name),
      environmentByName: listLookup(remote.environments ?? [], (r) => r.name),
      vaultByDisplayName: listLookup(remote.vaults ?? [], (r) => r.display_name),
      deploymentByName: listLookup(remote.deployments ?? [], (r) => r.name),
    };
  }

  function plan(
    state: State,
    lookup: RemoteLookup,
    local: {
      memoryStores?: Map<
        string,
        { config: { name: string; description?: string }; dirPath: string }
      >;
      environments?: Map<string, { config: never; dirPath: string }>;
      vaults?: Map<string, { config: { display_name: string }; dirPath: string }>;
      deployments?: Map<string, { config: never; dirPath: string }>;
      deploymentResolutions?: Map<string, never>;
      ambiguities?: PlanAmbiguity[];
    } = {},
  ) {
    return computePlan(
      state,
      new Map(),
      new Map(),
      local.memoryStores ?? new Map(),
      (local.environments ?? new Map()) as never,
      (local.vaults ?? new Map()) as never,
      (local.deployments ?? new Map()) as never,
      new Map(),
      (local.deploymentResolutions ?? new Map()) as never,
      { lookup, ambiguities: local.ambiguities },
    );
  }

  const memLocal = (name = 'Memory A', description?: string) =>
    new Map([['mem-a', { config: { name, description }, dirPath: 'memory_stores/mem-a' }]]);

  it('adopts an untracked same-named memory store as a noop', async () => {
    const actions = await plan(
      emptyState(),
      makeLookup({ memoryStores: [{ id: 'ms_1', name: 'Memory A' }] }),
      { memoryStores: memLocal() },
    );
    expect(actions).toEqual([
      { type: 'memstore_noop', localName: 'mem-a', id: 'ms_1', name: 'Memory A', adopted: true },
    ]);
  });

  it('adopts an untracked same-named memory store as an update when it differs', async () => {
    const actions = await plan(
      emptyState(),
      makeLookup({ memoryStores: [{ id: 'ms_1', name: 'Memory A', description: 'old' }] }),
      { memoryStores: memLocal('Memory A', 'new') },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'memstore_update', id: 'ms_1', adopted: true });
  });

  it('does not flag a state-tracked resource as adopted', async () => {
    const state = emptyState();
    state.memory_stores['mem-a'] = { id: 'ms_1', name: 'Memory A' };
    vi.mocked(retrieveMemoryStore).mockResolvedValue({ id: 'ms_1', name: 'Memory A' });
    const actions = await plan(state, makeLookup(), { memoryStores: memLocal() });
    expect(actions).toEqual([
      { type: 'memstore_noop', localName: 'mem-a', id: 'ms_1', name: 'Memory A' },
    ]);
  });

  it('creates a memory store when nothing on remote matches', async () => {
    const actions = await plan(
      emptyState(),
      makeLookup({ memoryStores: [{ id: 'ms_9', name: 'Other' }] }),
      { memoryStores: memLocal() },
    );
    expect(actions.map((a) => a.type)).toEqual(['memstore_create']);
  });

  it('adopts a same-named active store when the tracked id is archived', async () => {
    const state = emptyState();
    state.memory_stores['mem-a'] = { id: 'ms_old', name: 'Memory A' };
    vi.mocked(retrieveMemoryStore).mockResolvedValue({
      id: 'ms_old',
      name: 'Memory A',
      archived_at: '2026-01-01',
    });
    const actions = await plan(
      state,
      makeLookup({
        memoryStores: [
          { id: 'ms_old', name: 'Memory A', archived_at: '2026-01-01' },
          { id: 'ms_new', name: 'Memory A' },
        ],
      }),
      { memoryStores: memLocal() },
    );
    expect(actions).toEqual([
      { type: 'memstore_noop', localName: 'mem-a', id: 'ms_new', name: 'Memory A', adopted: true },
    ]);
  });

  it('creates and archives (does not adopt) when the directory was renamed', async () => {
    const state = emptyState();
    state.memory_stores['old-dir'] = { id: 'ms_1', name: 'Memory A' };
    const actions = await plan(
      state,
      makeLookup({ memoryStores: [{ id: 'ms_1', name: 'Memory A' }] }),
      { memoryStores: memLocal() },
    );
    expect(actions.map((a) => a.type).sort()).toEqual(['memstore_archive', 'memstore_create']);
  });

  it('throws AmbiguousRemoteNameError when two active stores share the name', async () => {
    await expect(
      plan(
        emptyState(),
        makeLookup({
          memoryStores: [
            { id: 'ms_1', name: 'Memory A' },
            { id: 'ms_2', name: 'Memory A' },
          ],
        }),
        { memoryStores: memLocal() },
      ),
    ).rejects.toBeInstanceOf(AmbiguousRemoteNameError);
  });

  it('records an ambiguous memory store instead of throwing and plans no action for it', async () => {
    const ambiguities: PlanAmbiguity[] = [];
    const actions = await plan(
      emptyState(),
      makeLookup({
        memoryStores: [
          { id: 'ms_1', name: 'Memory A' },
          { id: 'ms_2', name: 'Memory A' },
        ],
        vaults: [{ id: 'vlt_1', display_name: 'Bot Vault' }],
      }),
      {
        memoryStores: memLocal(),
        vaults: new Map([
          ['bot', { config: { display_name: 'Bot Vault' }, dirPath: 'vaults/bot' }],
        ]),
        ambiguities,
      },
    );
    expect(actions.map((a) => a.type)).toEqual(['vault_noop']);
    expect(ambiguities).toHaveLength(1);
    expect(ambiguities[0]).toMatchObject({ kind: 'memory_store', name: 'mem-a' });
    expect(ambiguities[0].error).toBeInstanceOf(AmbiguousRemoteNameError);
    expect(ambiguities[0].error.candidates.map((c) => c.id)).toEqual(['ms_1', 'ms_2']);
  });

  it.each([
    ['environment', 'environments'],
    ['vault', 'vaults'],
    ['deployment', 'deployments'],
  ] as const)('records an ambiguous %s and plans no action for it', async (kind, key) => {
    const dup = {
      environment: [
        { id: 'e_1', name: 'X' },
        { id: 'e_2', name: 'X' },
      ],
      vault: [
        { id: 'v_1', display_name: 'X' },
        { id: 'v_2', display_name: 'X' },
      ],
      deployment: [
        { id: 'd_1', name: 'X' },
        { id: 'd_2', name: 'X' },
      ],
    }[kind];
    const resolution = {
      config: { name: 'X', agent: { id: 'agent_1' }, environment_id: 'env_1', initial_events: [] },
      forwardAgentDeps: [],
      forwardEnvDeps: [],
      forwardVaultDeps: [],
      forwardMemoryStoreDeps: [],
    };
    const ambiguities: PlanAmbiguity[] = [];
    const actions = await plan(emptyState(), makeLookup({ [key]: dup }), {
      environments:
        kind === 'environment'
          ? new Map([['x', { config: { name: 'X' } as never, dirPath: 'environments/x' }]])
          : undefined,
      vaults:
        kind === 'vault'
          ? new Map([['x', { config: { display_name: 'X' }, dirPath: 'vaults/x' }]])
          : undefined,
      deployments:
        kind === 'deployment'
          ? new Map([['x', { config: {} as never, dirPath: 'deployments/x' }]])
          : undefined,
      deploymentResolutions: new Map([['x', resolution as never]]),
      ambiguities,
    });
    expect(actions).toEqual([]);
    expect(ambiguities).toMatchObject([{ kind, name: 'x' }]);
  });

  it('records an ambiguous untracked skill and keeps planning the others', async () => {
    const skill = (n: string) => ({
      localName: n,
      dirPath: `skills/${n}`,
      skillName: n,
      description: '',
      displayTitle: n,
      hash: 'h',
      files: ['SKILL.md'],
    });
    const lookup = {
      ...makeLookup(),
      skillByDisplayTitle: async (name: string): Promise<NameLookup<never>> =>
        name === 'dup'
          ? ({
              kind: 'ambiguous',
              candidates: [{ id: 's_1' }, { id: 's_2' }],
            } as unknown as NameLookup<never>)
          : { kind: 'none' },
    };
    const ambiguities: PlanAmbiguity[] = [];
    const actions = await computePlan(
      emptyState(),
      new Map(),
      new Map([
        ['dup', skill('dup')],
        ['solo', skill('solo')],
      ]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      { lookup, ambiguities },
    );
    expect(actions.map((a) => a.type)).toEqual(['skill_create']);
    expect(ambiguities).toMatchObject([{ kind: 'skill', name: 'dup' }]);
  });

  it('records an ambiguous agent and keeps planning the others', async () => {
    const err = new AmbiguousRemoteNameError('agent', 'dup', [{ id: 'a_1' }, { id: 'a_2' }]);
    vi.mocked(resolveRemote).mockImplementation(async (name) => {
      if (name === 'dup') throw err;
      return null;
    });
    const ambiguities: PlanAmbiguity[] = [];
    const config = (name: string) => ({
      config: { name } as AgentConfig,
      filePath: `${name}.yaml`,
    });
    const actions = await computePlan(
      emptyState(),
      new Map([
        ['dup', config('dup')],
        ['solo', config('solo')],
      ]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      { lookup: makeLookup(), ambiguities },
    );
    expect(actions.map((a) => actionKey(a))).toEqual(['agent:solo']);
    expect(ambiguities).toEqual([{ kind: 'agent', name: 'dup', error: err }]);
  });

  it('still throws for an ambiguous agent when no sink is given', async () => {
    vi.mocked(resolveRemote).mockRejectedValue(
      new AmbiguousRemoteNameError('agent', 'dup', [{ id: 'a_1' }, { id: 'a_2' }]),
    );
    await expect(
      computePlan(
        emptyState(),
        new Map([['dup', { config: { name: 'dup' } as AgentConfig, filePath: 'dup.yaml' }]]),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        { lookup: makeLookup() },
      ),
    ).rejects.toBeInstanceOf(AmbiguousRemoteNameError);
  });

  it('adopts an untracked vault as a noop', async () => {
    const actions = await plan(
      emptyState(),
      makeLookup({ vaults: [{ id: 'vlt_1', display_name: 'Bot Vault' }] }),
      {
        vaults: new Map([
          ['bot', { config: { display_name: 'Bot Vault' }, dirPath: 'vaults/bot' }],
        ]),
      },
    );
    expect(actions).toEqual([
      {
        type: 'vault_noop',
        localName: 'bot',
        id: 'vlt_1',
        display_name: 'Bot Vault',
        adopted: true,
      },
    ]);
  });

  it('adopts an untracked environment', async () => {
    const config = { name: 'py', config: { type: 'cloud' } } as never;
    const remote = { id: 'env_1', name: 'py', config: { type: 'cloud' } } as RemoteEnvironment;
    const actions = await plan(emptyState(), makeLookup({ environments: [remote] }), {
      environments: new Map([['py-dir', { config, dirPath: 'environments/py-dir' }]]),
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ localName: 'py-dir', id: 'env_1', adopted: true });
    expect(actions[0].type).toMatch(/^env_(noop|update)$/);
  });

  it('passes memory store forward deps through to deployment actions', async () => {
    const resolved: ResolvedDeployment = {
      name: 'nightly',
      agent: { id: 'agent_1', version: 1 },
      environment_id: 'env_1',
      initial_events: [],
    };
    const resolution = {
      config: resolved,
      forwardAgentDeps: [],
      forwardEnvDeps: [],
      forwardVaultDeps: [],
      forwardMemoryStoreDeps: ['notes'],
      missingRefs: [],
      idMismatches: [],
      ambiguousRefs: [],
    };
    const actions = await plan(emptyState(), makeLookup(), {
      deployments: new Map([['nightly', { config: {} as never, dirPath: 'deployments/nightly' }]]),
      deploymentResolutions: new Map([['nightly', resolution as never]]),
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'deploy_create',
      forwardMemoryStoreDeps: ['notes'],
    });
  });

  it('adopts an untracked deployment', async () => {
    const resolved: ResolvedDeployment = {
      name: 'nightly',
      agent: { id: 'agent_1', version: 1 },
      environment_id: 'env_1',
      initial_events: [],
    };
    const remote: RemoteDeployment = {
      id: 'dep_1',
      name: 'nightly',
      agent: { id: 'agent_1', type: 'agent', version: 1 },
      environment_id: 'env_1',
      initial_events: [],
    };
    const resolution = {
      config: resolved,
      forwardAgentDeps: [],
      forwardEnvDeps: [],
      forwardVaultDeps: [],
      forwardMemoryStoreDeps: [],
      missingRefs: [],
      idMismatches: [],
      ambiguousRefs: [],
    };
    const actions = await plan(emptyState(), makeLookup({ deployments: [remote] }), {
      deployments: new Map([['nightly-dir', { config: {} as never, dirPath: 'deployments/n' }]]),
      deploymentResolutions: new Map([['nightly-dir', resolution as never]]),
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ localName: 'nightly-dir', id: 'dep_1', adopted: true });
    expect(actions[0].type).toMatch(/^deploy_(noop|update)$/);
  });
});

describe('computePlan — skills with an unknown state hash', () => {
  const skill = {
    localName: 'my-skill',
    dirPath: 'skills/my-skill',
    skillName: 'my-skill',
    description: '',
    displayTitle: 'my-skill',
    hash: 'abcdef0123456789',
    files: ['SKILL.md'],
  };

  function planSkill(trackedHash: string) {
    const state: State = {
      agents: {},
      skills: {
        'my-skill': { id: 'skill_1', version: '1', hash: trackedHash, display_title: 'my-skill' },
      },
      memory_stores: {},
      environments: {},
      vaults: {},
      deployments: {},
    };
    return computePlan(
      state,
      new Map(),
      new Map([['my-skill', skill]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );
  }

  it('plans an update when the recorded hash is unknown', async () => {
    const actions = await planSkill(UNKNOWN_SKILL_HASH);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'skill_update',
      id: 'skill_1',
      currentHash: UNKNOWN_SKILL_HASH,
    });
  });

  it('stays unchanged when the recorded hash matches the local one', async () => {
    const actions = await planSkill(skill.hash);
    expect(actions.map((a) => a.type)).toEqual(['skill_noop']);
  });
});

describe('filterActionsByTargets — kind-qualified targets', () => {
  const agent: Action = { type: 'noop', name: 'shared', id: 'agent_1', version: 1 };
  const store: Action = { type: 'memstore_noop', localName: 'shared', id: 'ms_1', name: 'Shared' };
  const deployment: Action = {
    type: 'deploy_noop',
    localName: 'shared',
    id: 'dep_1',
    name: 'Shared',
  };
  const other: Action = { type: 'noop', name: 'other', id: 'agent_2', version: 1 };
  const actions = [agent, store, deployment, other];

  it('keeps only the resource of the qualified kind', () => {
    expect(filterActionsByTargets(actions, ['deployment:shared'])).toMatchObject({
      filtered: [deployment],
      unmatched: [],
    });
    expect(filterActionsByTargets(actions, ['agent:shared']).filtered).toEqual([agent]);
  });

  it('accepts kind aliases as the qualifier', () => {
    expect(filterActionsByTargets(actions, ['deploy:shared']).filtered).toEqual([deployment]);
    expect(filterActionsByTargets(actions, ['memstore:shared']).filtered).toEqual([store]);
    expect(filterActionsByTargets(actions, ['memory_store:shared']).filtered).toEqual([store]);
    expect(filterActionsByTargets(actions, ['agents:shared']).filtered).toEqual([agent]);
  });

  it('still matches a bare name against every kind', () => {
    expect(filterActionsByTargets(actions, ['shared']).filtered).toEqual([
      agent,
      store,
      deployment,
    ]);
  });

  it('treats a string with a non-alias prefix as a bare name', () => {
    const colonAgent: Action = { type: 'noop', name: 'team:ops', id: 'agent_3', version: 1 };
    expect(filterActionsByTargets([colonAgent, other], ['team:ops'])).toMatchObject({
      filtered: [colonAgent],
      unmatched: [],
    });
  });

  it('reports qualified targets that match nothing, as typed', () => {
    expect(
      filterActionsByTargets(actions, ['vault:shared', 'agent:', 'deployment:shared']),
    ).toMatchObject({ filtered: [deployment], unmatched: ['vault:shared', 'agent:'] });
  });

  it('combines qualified targets with kinds and bare names', () => {
    const result = filterActionsByTargets(actions, ['deployment:shared', 'memstores', 'other']);
    expect(result.filtered).toEqual([store, deployment, other]);
    expect(result.unmatched).toEqual([]);
  });
});

describe('actionKey', () => {
  it('formats <kind>:<name> for every resource kind', () => {
    expect(actionKey(noop)).toBe('agent:agent-a');
    expect(actionKey(skillNoop)).toBe('skill:skill-a');
    expect(actionKey(memstoreCreate)).toBe('memory_store:memory-a');
    expect(actionKey(envArchive)).toBe('environment:env-a');
    expect(actionKey(vaultNoop)).toBe('vault:vault-a');
    expect(actionKey({ type: 'deploy_noop', localName: 'd', id: 'x', name: 'D' })).toBe(
      'deployment:d',
    );
  });
});

describe('filterActionsByTargets — resources without an action', () => {
  const other: Action = { type: 'noop', name: 'other', id: 'agent_2', version: 1 };
  const notes = { kind: 'memory_store', name: 'notes' } as const;

  it.each([
    ['a kind', 'memstores'],
    ['a bare name', 'notes'],
    ['a qualified name', 'memory_store:notes'],
    ['a qualified name with an alias', 'memstore:notes'],
  ])('selects an ambiguous resource named by %s', (_label, target) => {
    const r = filterActionsByTargets([other], [target], [notes]);
    expect(r.selectedExtra).toEqual([notes]);
    expect(r.unmatched).toEqual([]);
  });

  it('does not select it for unrelated targets', () => {
    for (const target of ['skills', 'other', 'agent:notes', 'vault:notes']) {
      const r = filterActionsByTargets([other], [target], [notes]);
      expect(r.selectedExtra).toEqual([]);
    }
  });

  it('keeps the actions result independent of the extra resources', () => {
    const r = filterActionsByTargets([other], ['other'], [notes]);
    expect(r.filtered).toEqual([other]);
  });

  it('still reports a qualified target of the wrong kind as unmatched', () => {
    expect(filterActionsByTargets([other], ['vault:notes'], [notes]).unmatched).toEqual([
      'vault:notes',
    ]);
  });
});

describe('classifyUnmatchedTargets', () => {
  const known = [
    { kind: 'deployment', name: 'nightly' },
    { kind: 'agent', name: 'nightly' },
    { kind: 'memory_store', name: 'notes' },
  ] as const;

  it('flags an unknown kind and suggests the kind that has that name', () => {
    expect(classifyUnmatchedTargets(['deploymnt:notes'], [...known])).toEqual({
      notFound: [],
      unknownKind: [
        { target: 'deploymnt:notes', kind: 'deploymnt', suggestions: ['memory_store:notes'] },
      ],
    });
  });

  it('lists every kind that has the name, in kind order', () => {
    const r = classifyUnmatchedTargets(['foo:nightly'], [...known]);
    expect(r.unknownKind[0].suggestions).toEqual(['agent:nightly', 'deployment:nightly']);
  });

  it('gives no suggestion when nothing has that name', () => {
    const r = classifyUnmatchedTargets(['foo:missing'], [...known]);
    expect(r.unknownKind).toEqual([{ target: 'foo:missing', kind: 'foo', suggestions: [] }]);
  });

  it('keeps a valid kind with a missing name as not found', () => {
    const r = classifyUnmatchedTargets(['deployment:nope', 'plain', 'env:x'], [...known]);
    expect(r).toEqual({ notFound: ['deployment:nope', 'plain', 'env:x'], unknownKind: [] });
  });

  it('keeps a target with an empty prefix as not found', () => {
    expect(classifyUnmatchedTargets([':nightly'], [...known]).notFound).toEqual([':nightly']);
  });

  it('splits a mix of both kinds of mistake', () => {
    const r = classifyUnmatchedTargets(['foo:nightly', 'deployment:nope'], [...known]);
    expect(r.notFound).toEqual(['deployment:nope']);
    expect(r.unknownKind.map((u) => u.target)).toEqual(['foo:nightly']);
  });

  it('does not report an existing resource whose name contains a colon', () => {
    const colon: Action = { type: 'noop', name: 'team:ops', id: 'agent_3', version: 1 };
    const { unmatched } = filterActionsByTargets([colon], ['team:ops']);
    expect(unmatched).toEqual([]);
  });
});

describe('validResourceKinds', () => {
  it('puts canonical kinds first and every other spelling in aliases', () => {
    expect(validResourceKinds()).toEqual({
      canonical: ['agent', 'skill', 'memory_store', 'environment', 'vault', 'deployment'],
      aliases: [
        'agents',
        'skills',
        'memory_stores',
        'memstore',
        'memstores',
        'environments',
        'env',
        'envs',
        'vaults',
        'deployments',
        'deploy',
        'deploys',
      ],
    });
  });
});
