import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agents.js')>();
  return {
    ...actual,
    resolveRemote: vi.fn(),
  };
});

import { resolveRemote } from './agents.js';
import { computePlan, filterActionsByTargets, hasChanges, type Action } from './plan.js';
import type { AgentConfig, RemoteAgent, State } from './types.js';

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
    );

    const updates = actions.filter(
      (a): a is Extract<Action, { type: 'update' }> => a.type === 'update',
    );
    expect(updates.map((a) => a.name).sort()).toEqual(['a', 'b', 'c']);
    expect(updates.find((a) => a.name === 'b')?.forwardAgentDeps).toEqual(['a']);
    expect(updates.find((a) => a.name === 'c')?.forwardAgentDeps).toEqual(['b']);
  });
});
