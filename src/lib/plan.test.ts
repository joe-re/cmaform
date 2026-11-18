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
import { computePlan, filterActionsByTargets, hasChanges, type Action } from './plan.js';
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
    expect(filterActionsByTargets(actions, ['agent-a', 'missing'])).toEqual({
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
      { lookup },
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
      missingRefs: [],
      idMismatches: [],
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
