import { beforeEach, describe, expect, it, vi } from 'vitest';

// Safety net: name lookups in these tests go through a fake `RemoteLookup`
// that only knows the names a test seeds via `makeCtx`. Asking about any other
// name throws a loud error instead of silently reporting "not on remote".
// `retrieveAgent` is mocked so accidental SDK calls fail the same way.
vi.mock('./agents.js', () => {
  return {
    retrieveAgent: vi.fn((id: string) => {
      throw new Error(
        `retrieveAgent(${JSON.stringify(id)}) should not be reached in tests — mock retrieveAgent explicitly when resolving raw IDs.`,
      );
    }),
  };
});

import { retrieveAgent } from './agents.js';
import {
  extractPendingAgent,
  extractPendingSkill,
  pendingAgentSentinel,
  pendingMemoryStoreSentinel,
  prettifySentinelsForDisplay,
  pendingSkillSentinel,
  resolveAgentConfig,
  resolveDeploymentConfig,
  rewriteAgentRefsToNameForm,
  rewriteSkillRefsToNameForm,
  substitutePendingDeploymentIds,
  substitutePendingIds,
  type ResolutionContext,
} from './resolve.js';
import { AmbiguousRemoteNameError, type NameLookup, type RemoteLookup } from './remote-lookup.js';
import type {
  AgentConfig,
  DeploymentConfig,
  LocalSkill,
  RemoteAgent,
  RemoteEnvironment,
  RemoteMemoryStore,
  ResolvedDeployment,
  RemoteSkill,
  RemoteVault,
  State,
} from './types.js';

beforeEach(() => {
  vi.mocked(retrieveAgent).mockReset();
  vi.mocked(retrieveAgent).mockResolvedValue(null);
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

/** Seeded remote names: `null` = confirmed missing, an array = several active matches. */
type Seed<T> = Record<string, T | T[] | null>;

function fakeLookupFn<T extends { id: string }>(label: string, seed: Seed<T>) {
  return async (name: string, lookupOpts?: { excludeIds?: ReadonlySet<string> }) => {
    if (!(name in seed)) {
      throw new Error(`${label}(${JSON.stringify(name)}) was not seeded in makeCtx().`);
    }
    const value = seed[name];
    const all = value === null ? [] : Array.isArray(value) ? value : [value];
    const candidates = all.filter((r) => !lookupOpts?.excludeIds?.has(r.id));
    const result: NameLookup<T> =
      candidates.length === 0
        ? { kind: 'none' }
        : candidates.length === 1
          ? { kind: 'one', remote: candidates[0] }
          : { kind: 'ambiguous', candidates };
    return result;
  };
}

function makeCtx(
  opts: {
    state?: State;
    localAgents?: Record<string, AgentConfig>;
    localSkills?: Record<string, LocalSkill>;
    /** Local environment dir name -> manifest name (the name used on remote). */
    localEnvironments?: Record<string, string>;
    localVaults?: Record<string, string>;
    /** Local memory store dir name -> manifest name (the name used on remote). */
    localMemoryStores?: Record<string, string>;
    remoteMemoryStores?: Seed<RemoteMemoryStore>;
    remoteAgents?: Seed<RemoteAgent>;
    remoteSkills?: Seed<RemoteSkill>;
    remoteEnvs?: Seed<RemoteEnvironment>;
    remoteVaults?: Seed<RemoteVault>;
  } = {},
): ResolutionContext {
  const lookup: RemoteLookup = {
    agentByName: fakeLookupFn('agentByName', opts.remoteAgents ?? {}),
    skillByDisplayTitle: fakeLookupFn('skillByDisplayTitle', opts.remoteSkills ?? {}),
    environmentByName: fakeLookupFn('environmentByName', opts.remoteEnvs ?? {}),
    vaultByDisplayName: fakeLookupFn('vaultByDisplayName', opts.remoteVaults ?? {}),
    memoryStoreByName: fakeLookupFn('memoryStoreByName', opts.remoteMemoryStores ?? {}),
    deploymentByName: fakeLookupFn('deploymentByName', {}),
  };
  return {
    state: opts.state ?? emptyState(),
    localAgents: new Map(Object.entries(opts.localAgents ?? {})),
    localSkills: new Map(Object.entries(opts.localSkills ?? {})),
    localEnvironments: new Map(Object.entries(opts.localEnvironments ?? {})),
    localVaults: new Map(Object.entries(opts.localVaults ?? {})),
    localMemoryStores: new Map(Object.entries(opts.localMemoryStores ?? {})),
    lookup,
  };
}

describe('resolveAgentConfig — agent refs', () => {
  it('resolves a name to the id tracked in state', async () => {
    const ctx = makeCtx({
      state: {
        ...emptyState(),
        agents: { 'spec-qa': { id: 'agent_real_001', version: 1 } },
      },
      remoteAgents: { 'spec-qa': null },
    });
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', name: 'spec-qa' }],
      },
    };
    const r = await resolveAgentConfig(config, ctx);
    expect(r.missingAgentRefs).toEqual([]);
    expect(r.forwardAgentDeps).toEqual([]);
    expect(r.idMismatches).toEqual([]);
    expect(r.config.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_real_001', version: 1 },
    ]);
  });

  it('resolves a name via the pre-cached remote lookup (no SDK call needed)', async () => {
    const remote = { id: 'agent_remote_002', version: 4 } as RemoteAgent;
    const ctx = makeCtx({ remoteAgents: { 'release-prep': remote } });
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', name: 'release-prep' }],
      },
    };
    const r = await resolveAgentConfig(config, ctx);
    expect(r.config.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_remote_002', version: 4 },
    ]);
    expect(r.forwardAgentDeps).toEqual([]);
  });

  it('resolves explicit latest to a numeric agent version', async () => {
    const ctx = makeCtx({
      state: {
        ...emptyState(),
        agents: { 'spec-qa': { id: 'agent_real_001', version: 10 } },
      },
      remoteAgents: { 'spec-qa': null },
    });
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', name: 'spec-qa', version: 'latest' }],
      },
    };

    const r = await resolveAgentConfig(config, ctx);

    expect(r.config.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_real_001', version: 10 },
    ]);
  });

  it('resolves latest from remote when state has a stale tracked version', async () => {
    const ctx = makeCtx({
      state: {
        ...emptyState(),
        agents: { 'spec-qa': { id: 'agent_real_001', version: 10 } },
      },
      remoteAgents: { 'spec-qa': { id: 'agent_real_001', version: 12 } as RemoteAgent },
    });
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', name: 'spec-qa', version: 'latest' }],
      },
    };

    const r = await resolveAgentConfig(config, ctx);

    expect(r.config.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_real_001', version: 12 },
    ]);
  });

  it('resolves latest from remote by tracked id when name lookup misses', async () => {
    vi.mocked(retrieveAgent).mockResolvedValueOnce({
      id: 'agent_real_001',
      version: 12,
      name: 'renamed-spec-qa',
      archived_at: null,
    });
    const ctx = makeCtx({
      state: {
        ...emptyState(),
        agents: { 'spec-qa': { id: 'agent_real_001', version: 10 } },
      },
      remoteAgents: { 'spec-qa': null },
    });
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', name: 'spec-qa', version: 'latest' }],
      },
    };

    const r = await resolveAgentConfig(config, ctx);

    expect(retrieveAgent).toHaveBeenCalledWith('agent_real_001');
    expect(r.config.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_real_001', version: 12 },
    ]);
  });

  it('keeps an explicit numeric agent version pinned', async () => {
    const ctx = makeCtx({
      state: {
        ...emptyState(),
        agents: { 'spec-qa': { id: 'agent_real_001', version: 10 } },
      },
      remoteAgents: { 'spec-qa': null },
    });
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', name: 'spec-qa', version: 3 }],
      },
    };

    const r = await resolveAgentConfig(config, ctx);

    expect(r.config.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_real_001', version: 3 },
    ]);
  });

  it('produces a forward dep + sentinel when the name only exists locally', async () => {
    const ctx = makeCtx({
      // Confirm remote miss so we never hit the SDK in the test.
      remoteAgents: { 'spec-qa': null },
      localAgents: { 'spec-qa': { name: 'spec-qa' } },
    });
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', name: 'spec-qa' }],
      },
    };
    const r = await resolveAgentConfig(config, ctx);
    expect(r.forwardAgentDeps).toEqual(['spec-qa']);
    const entry = r.config.multiagent?.agents[0] as { id: string };
    expect(extractPendingAgent(entry.id)).toBe('spec-qa');
  });

  it('records missingAgentRefs when the name is not in state, remote, or local', async () => {
    const ctx = makeCtx({ remoteAgents: { 'ghost-agent': null } });
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', name: 'ghost-agent' }],
      },
    };
    const r = await resolveAgentConfig(config, ctx);
    expect(r.missingAgentRefs).toEqual(['ghost-agent']);
    expect(r.forwardAgentDeps).toEqual([]);
  });

  it('passes id-only entries through verbatim and does not add forward deps', async () => {
    const ctx = makeCtx();
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: 'agent_real_009' }],
      },
    };
    const r = await resolveAgentConfig(config, ctx);
    expect(r.config.multiagent?.agents).toEqual([{ type: 'agent', id: 'agent_real_009' }]);
    expect(r.forwardAgentDeps).toEqual([]);
    expect(r.idMismatches).toEqual([]);
  });

  it('resolves raw-id latest agent versions from remote by id', async () => {
    vi.mocked(retrieveAgent).mockResolvedValueOnce({
      id: 'agent_untracked_001',
      version: 7,
      name: 'untracked-agent',
      archived_at: null,
    });
    const ctx = makeCtx();
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: 'agent_untracked_001', version: 'latest' }],
      },
    };

    const r = await resolveAgentConfig(config, ctx);

    expect(retrieveAgent).toHaveBeenCalledWith('agent_untracked_001');
    expect(r.config.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_untracked_001', version: 7 },
    ]);
    expect(r.latestAgentVersionRefs).toEqual([]);
  });

  it('fills omitted id-only agent versions from state when the id is tracked', async () => {
    const ctx = makeCtx({
      state: {
        ...emptyState(),
        agents: { 'spec-qa': { id: 'agent_real_001', version: 10 } },
      },
      remoteAgents: { 'spec-qa': null },
    });
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: 'agent_real_001' }],
      },
    };

    const r = await resolveAgentConfig(config, ctx);

    expect(r.config.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_real_001', version: 10 },
    ]);
    expect(r.latestAgentVersionRefs).toEqual([{ name: 'spec-qa', id: 'agent_real_001', index: 0 }]);
  });

  it('records an idMismatch when name+id pin-form disagrees with the resolved id', async () => {
    const ctx = makeCtx({
      state: {
        ...emptyState(),
        agents: { 'spec-qa': { id: 'agent_real_001', version: 1 } },
      },
      remoteAgents: { 'spec-qa': null },
    });
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', name: 'spec-qa', id: 'agent_stale_xxx' }],
      },
    };
    const r = await resolveAgentConfig(config, ctx);
    expect(r.idMismatches).toHaveLength(1);
    expect(r.idMismatches[0]).toMatch(/spec-qa/);
    expect(r.idMismatches[0]).toMatch(/agent_stale_xxx/);
    expect(r.idMismatches[0]).toMatch(/agent_real_001/);
  });

  it('does not flag a name+id pin-form when both agree', async () => {
    const ctx = makeCtx({
      state: {
        ...emptyState(),
        agents: { 'spec-qa': { id: 'agent_real_001', version: 1 } },
      },
      remoteAgents: { 'spec-qa': null },
    });
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', name: 'spec-qa', id: 'agent_real_001' }],
      },
    };
    const r = await resolveAgentConfig(config, ctx);
    expect(r.idMismatches).toEqual([]);
  });
});

describe('resolveAgentConfig — skill refs', () => {
  it('resolves a custom skill name to the id tracked in state', async () => {
    const ctx = makeCtx({
      state: {
        ...emptyState(),
        skills: {
          'slack-mention-lookup': {
            id: 'skill_real_001',
            version: 'v1',
            hash: 'h',
            display_title: 'slack-mention-lookup',
          },
        },
      },
    });
    const config: AgentConfig = {
      name: 'agent-with-skill',
      skills: [{ type: 'custom', name: 'slack-mention-lookup' }],
    };
    const r = await resolveAgentConfig(config, ctx);
    expect(r.config.skills).toEqual([{ type: 'custom', skill_id: 'skill_real_001' }]);
  });

  it('produces a forward dep + sentinel when the skill only exists locally', async () => {
    const ctx = makeCtx({
      remoteSkills: { 'my-skill': null },
      localSkills: {
        'my-skill': {
          localName: 'my-skill',
          dirPath: 'skills/my-skill',
          skillName: 'my-skill',
          description: 'my-skill description',
          displayTitle: 'my-skill',
          hash: 'my-skill-hash',
          files: ['SKILL.md'],
        },
      },
    });
    const config: AgentConfig = {
      name: 'agent-with-skill',
      skills: [{ type: 'custom', name: 'my-skill', version: 'latest' }],
    };
    const r = await resolveAgentConfig(config, ctx);
    expect(r.forwardSkillDeps).toEqual(['my-skill']);
    const entry = r.config.skills?.[0] as { skill_id: string; version: string };
    expect(extractPendingSkill(entry.skill_id)).toBe('my-skill');
    expect(entry.version).toBe('latest');
  });
});

describe('substitutePendingIds', () => {
  it('replaces agent and skill sentinels with the ids minted during apply', () => {
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: pendingAgentSentinel('spec-qa') }],
      },
      skills: [{ type: 'custom', skill_id: pendingSkillSentinel('my-skill') }],
    };
    const substituted = substitutePendingIds(
      config,
      new Map([['spec-qa', 'agent_just_created']]),
      new Map([['my-skill', 'skill_just_created']]),
      new Map([['spec-qa', 1]]),
    );
    expect(substituted.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_just_created', version: 1 },
    ]);
    expect(substituted.skills).toEqual([{ type: 'custom', skill_id: 'skill_just_created' }]);
  });

  it('throws if a sentinel still points at a not-yet-created resource', () => {
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: pendingAgentSentinel('spec-qa') }],
      },
    };
    expect(() => substitutePendingIds(config, new Map(), new Map())).toThrow(/spec-qa/);
  });

  it('replaces latest agent versions for existing ids after dependency updates', () => {
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: 'agent_updated', version: 'latest' }],
      },
    };

    const substituted = substitutePendingIds(
      config,
      new Map([['spec-qa', 'agent_updated']]),
      new Map(),
      new Map([['spec-qa', 11]]),
    );

    expect(substituted.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_updated', version: 11 },
    ]);
  });
});

describe('writeback helpers', () => {
  it('rewriteAgentRefsToNameForm replaces tracked ids with the local name', () => {
    const state: State = {
      ...emptyState(),
      agents: { 'spec-qa': { id: 'agent_real_001', version: 1 } },
    };
    const rewritten = rewriteAgentRefsToNameForm(
      [
        { type: 'agent', id: 'agent_real_001', version: 'latest' },
        { type: 'agent', id: 'agent_unknown_999' },
      ],
      state,
    );
    expect(rewritten).toEqual([
      { type: 'agent', name: 'spec-qa', version: 'latest' },
      // Unknown id passes through unchanged.
      { type: 'agent', id: 'agent_unknown_999' },
    ]);
  });

  it('rewriteSkillRefsToNameForm replaces tracked custom skill_ids with the local name', () => {
    const state: State = {
      ...emptyState(),
      skills: {
        'slack-mention-lookup': {
          id: 'skill_real_001',
          version: 'v1',
          hash: 'h',
          display_title: 'slack-mention-lookup',
        },
      },
    };
    const rewritten = rewriteSkillRefsToNameForm(
      [
        { type: 'custom', skill_id: 'skill_real_001' },
        // Anthropic-provided skills (e.g. xlsx) stay in skill_id form.
        { type: 'anthropic', skill_id: 'xlsx' },
      ],
      state,
    );
    expect(rewritten).toEqual([
      { type: 'custom', name: 'slack-mention-lookup' },
      { type: 'anthropic', skill_id: 'xlsx' },
    ]);
  });
});

describe('resolveDeploymentConfig', () => {
  function baseDeployment(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
    return {
      name: 'nightly',
      agent: 'spec-qa',
      environment: 'python-dev',
      initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'go' }] }],
      ...overrides,
    };
  }

  it('resolves agent + environment names to ids via state', async () => {
    const state = emptyState();
    state.agents['spec-qa'] = { id: 'agent_1', version: 3 };
    state.environments['python-dev'] = { id: 'env_1', name: 'python-dev' };
    const ctx = makeCtx({ state, remoteAgents: { 'spec-qa': null } });

    const r = await resolveDeploymentConfig(baseDeployment(), ctx);
    expect(r.config.agent).toEqual({ id: 'agent_1', version: undefined });
    expect(r.config.environment_id).toBe('env_1');
    expect(r.forwardAgentDeps).toEqual([]);
    expect(r.forwardEnvDeps).toEqual([]);
    expect(r.missingRefs).toEqual([]);
  });

  it('passes raw agent_/env_/vlt_ ids through untouched', async () => {
    const ctx = makeCtx();
    const r = await resolveDeploymentConfig(
      baseDeployment({
        agent: { id: 'agent_raw', version: 2 },
        environment: 'env_raw',
        vault_ids: ['vlt_raw'],
      }),
      ctx,
    );
    expect(r.config.agent).toEqual({ id: 'agent_raw', version: 2 });
    expect(r.config.environment_id).toBe('env_raw');
    expect(r.config.vault_ids).toEqual(['vlt_raw']);
    expect(r.missingRefs).toEqual([]);
  });

  it('records forward dependencies for resources created in the same apply set', async () => {
    // Seed the remote lookups as empty so resolution falls through to the
    // local apply set.
    const ctx = makeCtx({
      localAgents: { 'spec-qa': { name: 'spec-qa' } },
      remoteAgents: { 'spec-qa': null },
      localEnvironments: { 'python-dev': 'python-dev' },
      localVaults: { 'bot-vault': 'bot-vault' },
      remoteEnvs: { 'python-dev': null },
      remoteVaults: { 'bot-vault': null },
    });

    const r = await resolveDeploymentConfig(baseDeployment({ vault_ids: ['bot-vault'] }), ctx);
    expect(r.forwardAgentDeps).toEqual(['spec-qa']);
    expect(r.forwardEnvDeps).toEqual(['python-dev']);
    expect(r.forwardVaultDeps).toEqual(['bot-vault']);
    expect(extractPendingAgent(r.config.agent.id)).toBe('spec-qa');
    expect(r.config.environment_id).toContain('python-dev');
    expect(r.missingRefs).toEqual([]);
  });

  it('reports unresolved references as missing', async () => {
    const ctx = makeCtx({
      remoteAgents: { 'spec-qa': null },
      remoteEnvs: { 'no-such-env': null },
    });
    const r = await resolveDeploymentConfig(baseDeployment({ environment: 'no-such-env' }), ctx);
    // agent is missing (not in state, remote null, not local) and so is the env.
    expect(r.missingRefs).toContain('agent "spec-qa"');
    expect(r.missingRefs).toContain('environment "no-such-env"');
  });

  it('flags a pinned-id-vs-name mismatch', async () => {
    const state = emptyState();
    state.agents['spec-qa'] = { id: 'agent_1', version: 3 };
    state.environments['python-dev'] = { id: 'env_1', name: 'python-dev' };
    const ctx = makeCtx({ state, remoteAgents: { 'spec-qa': null } });

    const r = await resolveDeploymentConfig(
      baseDeployment({ agent: { name: 'spec-qa', id: 'agent_WRONG' } }),
      ctx,
    );
    expect(r.idMismatches).toEqual(['agent "spec-qa" pinned id=agent_WRONG, resolved id=agent_1']);
  });

  it('looks an untracked environment up by its manifest name when referenced by directory name', async () => {
    const remoteEnv = { id: 'env_remote', name: 'Python Dev' } as RemoteEnvironment;
    const ctx = makeCtx({
      remoteAgents: { 'spec-qa': null },
      localAgents: { 'spec-qa': { name: 'spec-qa' } },
      localEnvironments: { 'python-dev': 'Python Dev' },
      // Only the manifest name is seeded: asking for "python-dev" would throw.
      remoteEnvs: { 'Python Dev': remoteEnv },
    });
    const r = await resolveDeploymentConfig(baseDeployment(), ctx);
    expect(r.config.environment_id).toBe('env_remote');
    expect(r.forwardEnvDeps).toEqual([]);
  });

  it('does not match an environment already tracked under another local name', async () => {
    const state = emptyState();
    state.environments['old-dir'] = { id: 'env_remote', name: 'Python Dev' };
    const ctx = makeCtx({
      state,
      remoteAgents: { 'spec-qa': null },
      localAgents: { 'spec-qa': { name: 'spec-qa' } },
      localEnvironments: { 'python-dev': 'Python Dev' },
      remoteEnvs: { 'Python Dev': { id: 'env_remote', name: 'Python Dev' } as RemoteEnvironment },
    });
    const r = await resolveDeploymentConfig(baseDeployment(), ctx);
    expect(r.forwardEnvDeps).toEqual(['python-dev']);
  });

  it('throws when an untracked environment name matches several active remotes', async () => {
    const ctx = makeCtx({
      remoteAgents: { 'spec-qa': null },
      remoteEnvs: {
        'python-dev': [
          { id: 'env_1', name: 'python-dev' },
          { id: 'env_2', name: 'python-dev' },
        ] as RemoteEnvironment[],
      },
    });
    await expect(resolveDeploymentConfig(baseDeployment(), ctx)).rejects.toBeInstanceOf(
      AmbiguousRemoteNameError,
    );
  });

  it('resolves a tracked agent even when several remote agents share its name', async () => {
    const state = emptyState();
    state.agents['spec-qa'] = { id: 'agent_2', version: 3 };
    state.environments['python-dev'] = { id: 'env_1', name: 'python-dev' };
    const ctx = makeCtx({
      state,
      remoteAgents: {
        'spec-qa': [
          { id: 'agent_1', version: 1 },
          { id: 'agent_2', version: 7 },
        ] as RemoteAgent[],
      },
    });
    const r = await resolveDeploymentConfig(baseDeployment(), ctx);
    expect(r.config.agent.id).toBe('agent_2');
  });

  it('throws when an untracked agent name matches several active remotes', async () => {
    const ctx = makeCtx({
      remoteAgents: {
        'spec-qa': [
          { id: 'agent_1', version: 1 },
          { id: 'agent_2', version: 7 },
        ] as RemoteAgent[],
      },
    });
    await expect(resolveDeploymentConfig(baseDeployment(), ctx)).rejects.toBeInstanceOf(
      AmbiguousRemoteNameError,
    );
  });
});

describe('memory store name references in deployment resources', () => {
  function deploymentWith(resources: unknown[]): DeploymentConfig {
    return {
      name: 'nightly',
      agent: { id: 'agent_raw' },
      environment: 'env_raw',
      initial_events: [],
      resources,
    };
  }

  it('resolves a name through state and drops the memory_store key', async () => {
    const state = emptyState();
    state.memory_stores['notes'] = { id: 'memstore_1', name: 'notes' };
    const ctx = makeCtx({ state });
    const r = await resolveDeploymentConfig(
      deploymentWith([
        { type: 'memory_store', memory_store: 'notes', access: 'read_write', instructions: 'hi' },
      ]),
      ctx,
    );
    expect(r.config.resources).toEqual([
      {
        type: 'memory_store',
        access: 'read_write',
        instructions: 'hi',
        memory_store_id: 'memstore_1',
      },
    ]);
    expect(r.config.resources?.[0]).not.toHaveProperty('memory_store');
    expect(r.missingRefs).toEqual([]);
    expect(r.forwardMemoryStoreDeps).toEqual([]);
  });

  it('resolves a name through the remote lookup', async () => {
    const ctx = makeCtx({
      remoteMemoryStores: { notes: { id: 'memstore_remote', name: 'notes' } as RemoteMemoryStore },
    });
    const r = await resolveDeploymentConfig(
      deploymentWith([{ type: 'memory_store', memory_store: 'notes' }]),
      ctx,
    );
    expect(r.config.resources).toEqual([
      { type: 'memory_store', memory_store_id: 'memstore_remote' },
    ]);
  });

  it("looks the store up by the manifest's name when referenced by directory name", async () => {
    const ctx = makeCtx({
      localMemoryStores: { notes: 'Customer Notes' },
      // Only the manifest name is seeded: asking for "notes" would throw.
      remoteMemoryStores: {
        'Customer Notes': { id: 'memstore_remote', name: 'Customer Notes' } as RemoteMemoryStore,
      },
    });
    const r = await resolveDeploymentConfig(
      deploymentWith([{ type: 'memory_store', memory_store: 'notes' }]),
      ctx,
    );
    expect(r.config.resources).toEqual([
      { type: 'memory_store', memory_store_id: 'memstore_remote' },
    ]);
    expect(r.forwardMemoryStoreDeps).toEqual([]);
  });

  it('uses a forward sentinel for a store that only exists locally', async () => {
    const ctx = makeCtx({
      localMemoryStores: { notes: 'notes' },
      remoteMemoryStores: { notes: null },
    });
    const r = await resolveDeploymentConfig(
      deploymentWith([{ type: 'memory_store', memory_store: 'notes', access: 'read_only' }]),
      ctx,
    );
    expect(r.forwardMemoryStoreDeps).toEqual(['notes']);
    expect(r.config.resources).toEqual([
      {
        type: 'memory_store',
        access: 'read_only',
        memory_store_id: pendingMemoryStoreSentinel('notes'),
      },
    ]);
    expect(prettifySentinelsForDisplay(r.config.resources)).toEqual([
      {
        type: 'memory_store',
        access: 'read_only',
        memory_store_id: '<pending: memory_store "notes">',
      },
    ]);
  });

  it('reports a name that exists nowhere as missing', async () => {
    const ctx = makeCtx({ remoteMemoryStores: { ghost: null } });
    const r = await resolveDeploymentConfig(
      deploymentWith([{ type: 'memory_store', memory_store: 'ghost' }]),
      ctx,
    );
    expect(r.missingRefs).toEqual(['memory store "ghost"']);
  });

  it('flags a pinned id that differs from the resolved id', async () => {
    const state = emptyState();
    state.memory_stores['notes'] = { id: 'memstore_1', name: 'notes' };
    const r = await resolveDeploymentConfig(
      deploymentWith([
        { type: 'memory_store', memory_store: 'notes', memory_store_id: 'memstore_WRONG' },
      ]),
      makeCtx({ state }),
    );
    expect(r.idMismatches).toEqual([
      'memory store "notes" pinned memory_store_id=memstore_WRONG, resolved memory_store_id=memstore_1',
    ]);
  });

  it('accepts a matching name + id pair and leaves no memory_store key behind', async () => {
    const state = emptyState();
    state.memory_stores['notes'] = { id: 'memstore_1', name: 'notes' };
    const r = await resolveDeploymentConfig(
      deploymentWith([
        { type: 'memory_store', memory_store: 'notes', memory_store_id: 'memstore_1' },
      ]),
      makeCtx({ state }),
    );
    expect(r.idMismatches).toEqual([]);
    expect(r.config.resources).toEqual([{ type: 'memory_store', memory_store_id: 'memstore_1' }]);
    expect(r.config.resources?.[0]).not.toHaveProperty('memory_store');
  });

  it('keeps a pinned id when the named store does not exist on remote yet', async () => {
    const r = await resolveDeploymentConfig(
      deploymentWith([
        { type: 'memory_store', memory_store: 'notes', memory_store_id: 'memstore_PINNED' },
      ]),
      makeCtx({ localMemoryStores: { notes: 'notes' }, remoteMemoryStores: { notes: null } }),
    );
    expect(r.config.resources).toEqual([
      { type: 'memory_store', memory_store_id: 'memstore_PINNED' },
    ]);
    expect(r.forwardMemoryStoreDeps).toEqual([]);
    expect(r.missingRefs).toEqual([]);
    expect(r.idMismatches).toEqual([]);
  });

  it('keeps raw-id entries and other resource types untouched', async () => {
    const resources = [
      { type: 'memory_store', memory_store_id: 'memstore_raw', access: 'read_only' },
      { type: 'file', file_id: 'file_1', memory_store: 'not-a-ref' },
      { type: 'memory_store', memory_store: 42 },
      'weird',
      null,
    ];
    const r = await resolveDeploymentConfig(deploymentWith(resources), makeCtx());
    expect(r.config.resources).toEqual(resources);
    expect(r.missingRefs).toEqual([]);
  });
});

describe('substitutePendingDeploymentIds — memory stores', () => {
  const created = (memoryStores: Record<string, string>) => ({
    agents: new Map<string, string>(),
    environments: new Map<string, string>(),
    vaults: new Map<string, string>(),
    memoryStores: new Map(Object.entries(memoryStores)),
  });
  const config = (): ResolvedDeployment => ({
    name: 'nightly',
    agent: { id: 'agent_1' },
    environment_id: 'env_1',
    initial_events: [],
    resources: [
      {
        type: 'memory_store',
        memory_store_id: pendingMemoryStoreSentinel('notes'),
        access: 'read_write',
      },
      { type: 'memory_store', memory_store_id: 'memstore_raw' },
    ],
  });

  it('replaces a sentinel with the created id', () => {
    const out = substitutePendingDeploymentIds(config(), created({ notes: 'memstore_new' }));
    expect(out.resources).toEqual([
      { type: 'memory_store', memory_store_id: 'memstore_new', access: 'read_write' },
      { type: 'memory_store', memory_store_id: 'memstore_raw' },
    ]);
  });

  it('throws when the store has not been created yet', () => {
    expect(() => substitutePendingDeploymentIds(config(), created({}))).toThrow(
      'internal: memory store "notes" referenced but not yet created',
    );
  });
});
