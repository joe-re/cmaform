import { describe, expect, it } from 'vitest';

import { fieldDiffs, toApplyParams } from './agents.js';
import type { AgentConfig, RemoteAgent } from './types.js';

function remoteAgent(overrides: Partial<RemoteAgent> = {}): RemoteAgent {
  return {
    id: 'agent_123',
    version: 1,
    name: 'agent',
    archived_at: null,
    ...overrides,
  };
}

describe('fieldDiffs', () => {
  it('does not report diffs for server-filled defaults normalized by field', () => {
    const local: AgentConfig = {
      name: 'agent',
      tools: [
        {
          type: 'bash',
          default_config: { enabled: true, permission_policy: 'ask' },
          configs: [{ name: 'shell' }],
        },
      ],
      skills: [{ type: 'custom', skill_id: 'skill_123' }],
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: 'agent_child' }],
      },
      metadata: {},
      mcp_servers: [],
    };
    const remote = remoteAgent({
      tools: [
        {
          type: 'bash',
          default_config: { enabled: true, permission_policy: 'ask' },
          configs: [{ name: 'shell', enabled: true, permission_policy: 'ask' }],
        },
      ],
      skills: [{ type: 'custom', skill_id: 'skill_123', version: 'v1' }],
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: 'agent_child', version: 4 }],
      },
    });

    expect(fieldDiffs(local, remote)).toEqual([]);
  });

  it('reports changed comparable fields after normalization', () => {
    const local: AgentConfig = {
      name: 'agent',
      description: 'new description',
    };
    const remote = remoteAgent({ description: 'old description' });

    expect(fieldDiffs(local, remote)).toEqual([
      {
        field: 'description',
        oldValue: 'old description',
        newValue: 'new description',
      },
    ]);
  });
});

describe('toApplyParams', () => {
  it('converts nullable text fields to null for the API payload', () => {
    expect(toApplyParams({ name: 'agent' })).toMatchObject({
      name: 'agent',
      system: null,
      description: null,
    });
  });
});
