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

  describe('model', () => {
    const id = 'claude-opus-5';

    it('ignores server-default effort when local omits it', () => {
      const [l, r] = normalizeFieldPair(
        'model',
        { id, speed: 'standard' },
        { id, speed: 'standard', effort: { type: 'high' } },
      );
      expect(l).toEqual(r);
    });

    it('keeps explicit local effort differences', () => {
      const [l, r] = normalizeFieldPair(
        'model',
        { id, speed: 'standard', effort: { type: 'low' } },
        { id, speed: 'standard', effort: { type: 'high' } },
      );
      expect(l).not.toEqual(r);
    });

    it('expands a string model to an object', () => {
      const [l, r] = normalizeFieldPair('model', id, { id, speed: 'standard' });
      expect(l).toEqual(r);
    });

    it('defaults speed to standard but detects a different remote speed', () => {
      const [l, r] = normalizeFieldPair('model', { id }, { id, speed: 'fast' });
      expect(l).not.toEqual(r);
    });

    it('is idempotent', () => {
      const once = normalizeFieldPair('model', id, {
        id,
        speed: 'standard',
        effort: { type: 'high' },
      });
      expect(normalizeFieldPair('model', once[0], once[1])).toEqual(once);
    });
  });

  it('treats an explicit local effort: null as omitted', () => {
    const [l, r] = normalizeFieldPair(
      'model',
      { id: 'claude-opus-5', effort: null },
      { id: 'claude-opus-5', speed: 'standard', effort: { type: 'high' } },
    );
    expect(l).toEqual(r);
    expect(l).toEqual({ id: 'claude-opus-5', speed: 'standard' });
  });

  it('treats configs: null as equivalent to an empty configs array', () => {
    const [l, r] = normalizeFieldPair(
      'tools',
      [{ type: 'agent_toolset_20260401', configs: null }],
      [{ type: 'agent_toolset_20260401', configs: [] }],
    );
    expect(l).toEqual(r);
  });

  describe('tools configs echoes', () => {
    const local = [
      {
        type: 'agent_toolset_20260401',
        default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
        configs: [
          { name: 'web_fetch', enabled: false },
          { name: 'web_search', enabled: false },
        ],
      },
    ];
    const remote = [
      {
        type: 'agent_toolset_20260401',
        default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
        configs: [
          {
            name: 'web_fetch',
            type: 'web_fetch',
            enabled: false,
            permission_policy: { type: 'always_allow' },
            url_sources: null,
          },
          {
            name: 'web_search',
            type: 'web_search',
            enabled: false,
            permission_policy: { type: 'always_allow' },
          },
        ],
      },
    ];

    it('treats echoed type and null url_sources as equivalent to omitted', () => {
      const [l, r] = normalizeFieldPair('tools', local, remote);
      expect(l).toEqual(r);
    });

    it('strips echoed type and nulls without default_config', () => {
      const [l, r] = normalizeFieldPair(
        'tools',
        [{ type: 'x', configs: [{ name: 'a', enabled: false }] }],
        [{ type: 'x', configs: [{ name: 'a', type: 'a', enabled: false, url_sources: null }] }],
      );
      expect(l).toEqual(r);
      expect(r).toEqual([{ type: 'x', configs: [{ name: 'a', enabled: false }] }]);
    });

    it('keeps differing non-null url_sources', () => {
      const [l, r] = normalizeFieldPair(
        'tools',
        [{ type: 'x', configs: [{ name: 'a', url_sources: ['https://a.example'] }] }],
        [{ type: 'x', configs: [{ name: 'a', url_sources: ['https://b.example'] }] }],
      );
      expect(l).not.toEqual(r);
    });

    it('is idempotent', () => {
      const once = normalizeFieldPair('tools', local, remote);
      expect(normalizeFieldPair('tools', once[0], once[1])).toEqual(once);
    });
  });
});
