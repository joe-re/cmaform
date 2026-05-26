import { describe, expect, it } from 'vitest';

import { normalizeFieldPair } from './normalize.js';

describe('normalizeFieldPair', () => {
  it('treats empty array fields as equivalent to undefined', () => {
    expect(normalizeFieldPair('mcp_servers', [], undefined)).toEqual([undefined, undefined]);
  });

  it('treats empty metadata objects as equivalent to undefined', () => {
    expect(normalizeFieldPair('metadata', {}, undefined)).toEqual([undefined, undefined]);
  });

  it('fills tool config entries from default_config before comparison', () => {
    const local = [
      {
        type: 'bash',
        default_config: { enabled: true, permission_policy: 'ask' },
        configs: [{ name: 'shell' }],
      },
    ];
    const remote = [
      {
        type: 'bash',
        default_config: { enabled: true, permission_policy: 'ask' },
        configs: [{ name: 'shell', enabled: true, permission_policy: 'ask' }],
      },
    ];

    expect(normalizeFieldPair('tools', local, remote)).toEqual([remote, remote]);
  });

  it('fills omitted multiagent agent versions from matching remote entries', () => {
    const local = {
      type: 'coordinator',
      agents: [{ type: 'agent', id: 'agent_123' }],
    };
    const remote = {
      type: 'coordinator',
      agents: [{ type: 'agent', id: 'agent_123', version: 7 }],
    };

    expect(normalizeFieldPair('multiagent', local, remote)).toEqual([remote, remote]);
  });

  it('fills omitted custom skill versions from matching remote entries', () => {
    const local = [{ type: 'custom', skill_id: 'skill_123' }];
    const remote = [{ type: 'custom', skill_id: 'skill_123', version: 'v3' }];

    expect(normalizeFieldPair('skills', local, remote)).toEqual([remote, remote]);
  });
});
