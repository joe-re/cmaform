import { beforeEach, describe, expect, it, vi } from 'vitest';

// Safety net: every name lookup in these tests goes through the per-run cache
// (`ResolutionContext.remoteAgentByName` / `remoteSkillByTitle`), which is
// pre-populated by `makeCtx`. If a test ever asks `resolveAgentConfig` about
// a name we didn't pre-cache, the code under test would fall through to the
// real SDK call — which would either hit the network or fail auth. Mock those
// two helpers so any such accidental fall-through throws a loud, descriptive
// error instead.
vi.mock('./agents.js', () => {
  return {
    findAgentByName: vi.fn((name: string) => {
      throw new Error(
        `findAgentByName(${JSON.stringify(name)}) should not be reached in tests — pre-populate remoteAgentByName in makeCtx().`,
      );
    }),
    retrieveAgent: vi.fn((id: string) => {
      throw new Error(
        `retrieveAgent(${JSON.stringify(id)}) should not be reached in tests — mock retrieveAgent explicitly when resolving raw IDs.`,
      );
    }),
  };
});
vi.mock('./skills.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./skills.js')>();
  return {
    ...actual,
    findSkillByDisplayTitle: vi.fn((title: string) => {
      throw new Error(
        `findSkillByDisplayTitle(${JSON.stringify(title)}) should not be reached in tests — pre-populate remoteSkillByTitle in makeCtx().`,
      );
    }),
  };
});
vi.mock('./environments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./environments.js')>();
  return {
    ...actual,
    findEnvironmentByName: vi.fn((name: string) => {
      throw new Error(
        `findEnvironmentByName(${JSON.stringify(name)}) should not be reached in tests — use state or env_ ids.`,
      );
    }),
  };
});
vi.mock('./vaults.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vaults.js')>();
  return {
    ...actual,
    findVaultByDisplayName: vi.fn((name: string) => {
      throw new Error(
        `findVaultByDisplayName(${JSON.stringify(name)}) should not be reached in tests — use state or vlt_ ids.`,
      );
    }),
  };
});

import { retrieveAgent } from './agents.js';
import {
  extractPendingAgent,
  extractPendingSkill,
  pendingAgentSentinel,
  pendingSkillSentinel,
  resolveAgentConfig,
  resolveDeploymentConfig,
  rewriteAgentRefsToNameForm,
  rewriteSkillRefsToNameForm,
  substitutePendingIds,
  type ResolutionContext,
} from './resolve.js';
import type {
  AgentConfig,
  DeploymentConfig,
  LocalSkill,
  RemoteAgent,
  RemoteSkill,
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

function makeCtx(
  opts: {
    state?: State;
    localAgents?: Record<string, AgentConfig>;
    localSkills?: Record<string, LocalSkill>;
    /** Pre-seeded remote agent lookups. `null` = name confirmed missing on remote. */
    remoteAgents?: Record<string, RemoteAgent | null>;
    remoteSkills?: Record<string, RemoteSkill | null>;
  } = {},
): ResolutionContext {
  return {
    state: opts.state ?? emptyState(),
    localAgents: new Map(Object.entries(opts.localAgents ?? {})),
    localSkills: new Map(Object.entries(opts.localSkills ?? {})),
    localEnvironments: new Set(),
    localVaults: new Set(),
    remoteAgentByName: new Map(Object.entries(opts.remoteAgents ?? {})),
    remoteSkillByTitle: new Map(Object.entries(opts.remoteSkills ?? {})),
    remoteEnvByName: new Map(),
    remoteVaultByName: new Map(),
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
    // Pre-seed the remote caches to `null` so resolution falls through to the
    // local apply set instead of hitting the (mocked, throwing) remote lookups.
    const ctx = makeCtx({
      localAgents: { 'spec-qa': { name: 'spec-qa' } },
      remoteAgents: { 'spec-qa': null },
    });
    ctx.remoteEnvByName.set('python-dev', null);
    ctx.remoteVaultByName.set('bot-vault', null);
    ctx.localEnvironments.add('python-dev');
    ctx.localVaults.add('bot-vault');

    const r = await resolveDeploymentConfig(baseDeployment({ vault_ids: ['bot-vault'] }), ctx);
    expect(r.forwardAgentDeps).toEqual(['spec-qa']);
    expect(r.forwardEnvDeps).toEqual(['python-dev']);
    expect(r.forwardVaultDeps).toEqual(['bot-vault']);
    expect(extractPendingAgent(r.config.agent.id)).toBe('spec-qa');
    expect(r.config.environment_id).toContain('python-dev');
    expect(r.missingRefs).toEqual([]);
  });

  it('reports unresolved references as missing', async () => {
    const ctx = makeCtx({ remoteAgents: { 'spec-qa': null } });
    ctx.remoteEnvByName.set('no-such-env', null);
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
});
