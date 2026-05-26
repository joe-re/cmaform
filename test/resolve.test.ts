import { describe, expect, it, vi } from 'vitest';

// Safety net: every name lookup in these tests goes through the per-run cache
// (`ResolutionContext.remoteAgentByName` / `remoteSkillByTitle`), which is
// pre-populated by `makeCtx`. If a test ever asks `resolveAgentConfig` about
// a name we didn't pre-cache, the code under test would fall through to the
// real SDK call — which would either hit the network or fail auth. Mock those
// two helpers so any such accidental fall-through throws a loud, descriptive
// error instead.
vi.mock('../src/lib/agents.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/lib/agents.js')>();
  return {
    ...actual,
    findAgentByName: vi.fn((name: string) => {
      throw new Error(
        `findAgentByName(${JSON.stringify(name)}) should not be reached in tests — pre-populate remoteAgentByName in makeCtx().`
      );
    }),
  };
});
vi.mock('../src/lib/skills.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/lib/skills.js')>();
  return {
    ...actual,
    findSkillByDisplayTitle: vi.fn((title: string) => {
      throw new Error(
        `findSkillByDisplayTitle(${JSON.stringify(title)}) should not be reached in tests — pre-populate remoteSkillByTitle in makeCtx().`
      );
    }),
  };
});

import {
  extractPendingAgent,
  extractPendingSkill,
  pendingAgentSentinel,
  pendingSkillSentinel,
  resolveAgentConfig,
  rewriteAgentRefsToNameForm,
  rewriteSkillRefsToNameForm,
  substitutePendingIds,
  type ResolutionContext,
} from '../src/lib/resolve.js';
import type {
  AgentConfig,
  LocalSkill,
  RemoteAgent,
  RemoteSkill,
  State,
} from '../src/lib/types.js';

function emptyState(): State {
  return {
    agents: {},
    skills: {},
    memory_stores: {},
    environments: {},
    vaults: {},
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
  } = {}
): ResolutionContext {
  return {
    state: opts.state ?? emptyState(),
    localAgents: new Map(Object.entries(opts.localAgents ?? {})),
    localSkills: new Map(Object.entries(opts.localSkills ?? {})),
    remoteAgentByName: new Map(Object.entries(opts.remoteAgents ?? {})),
    remoteSkillByTitle: new Map(Object.entries(opts.remoteSkills ?? {})),
  };
}

describe('resolveAgentConfig — agent refs', () => {
  it('resolves a name to the id tracked in state', async () => {
    const ctx = makeCtx({
      state: {
        ...emptyState(),
        agents: { 'spec-qa': { id: 'agent_real_001', version: 1 } },
      },
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
      { type: 'agent', id: 'agent_real_001' },
    ]);
  });

  it('resolves a name via the pre-cached remote lookup (no SDK call needed)', async () => {
    const remote = { id: 'agent_remote_002' } as RemoteAgent;
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
      { type: 'agent', id: 'agent_remote_002' },
    ]);
    expect(r.forwardAgentDeps).toEqual([]);
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
    expect(r.config.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_real_009' },
    ]);
    expect(r.forwardAgentDeps).toEqual([]);
    expect(r.idMismatches).toEqual([]);
  });

  it('records an idMismatch when name+id pin-form disagrees with the resolved id', async () => {
    const ctx = makeCtx({
      state: {
        ...emptyState(),
        agents: { 'spec-qa': { id: 'agent_real_001', version: 1 } },
      },
    });
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [
          { type: 'agent', name: 'spec-qa', id: 'agent_stale_xxx' },
        ],
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
    });
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [
          { type: 'agent', name: 'spec-qa', id: 'agent_real_001' },
        ],
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
    expect(r.config.skills).toEqual([
      { type: 'custom', skill_id: 'skill_real_001' },
    ]);
  });

  it('produces a forward dep + sentinel when the skill only exists locally', async () => {
    const ctx = makeCtx({
      remoteSkills: { 'my-skill': null },
      localSkills: { 'my-skill': { localName: 'my-skill' } as LocalSkill },
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
      new Map([['my-skill', 'skill_just_created']])
    );
    expect(substituted.multiagent?.agents).toEqual([
      { type: 'agent', id: 'agent_just_created' },
    ]);
    expect(substituted.skills).toEqual([
      { type: 'custom', skill_id: 'skill_just_created' },
    ]);
  });

  it('throws if a sentinel still points at a not-yet-created resource', () => {
    const config: AgentConfig = {
      name: 'coordinator',
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: pendingAgentSentinel('spec-qa') }],
      },
    };
    expect(() =>
      substitutePendingIds(config, new Map(), new Map())
    ).toThrow(/spec-qa/);
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
      state
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
      state
    );
    expect(rewritten).toEqual([
      { type: 'custom', name: 'slack-mention-lookup' },
      { type: 'anthropic', skill_id: 'xlsx' },
    ]);
  });
});
