import { describe, expect, it } from 'vitest';

import { deploymentFieldDiffs } from './deployments.js';
import type { RemoteDeployment, ResolvedDeployment } from './types.js';

function remote(overrides: Partial<RemoteDeployment> = {}): RemoteDeployment {
  return {
    id: 'deploy_1',
    name: 'nightly',
    description: null,
    agent: { id: 'agent_1', type: 'agent', version: 4 },
    environment_id: 'env_1',
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'go' }] }],
    schedule: {
      type: 'cron',
      expression: '0 9 * * 1-5',
      timezone: 'UTC',
      last_run_at: '2026-06-15T09:00:00Z',
      upcoming_runs_at: ['2026-06-16T09:00:00Z'],
    },
    metadata: {},
    status: 'active',
    archived_at: null,
    ...overrides,
  };
}

function local(overrides: Partial<ResolvedDeployment> = {}): ResolvedDeployment {
  return {
    name: 'nightly',
    agent: { id: 'agent_1' },
    environment_id: 'env_1',
    initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'go' }] }],
    schedule: { type: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' },
    ...overrides,
  };
}

describe('deploymentFieldDiffs', () => {
  it('is idempotent: no diff when local matches remote (computed schedule fields ignored)', () => {
    expect(deploymentFieldDiffs(local(), remote())).toEqual([]);
  });

  it('ignores agent version drift when the local manifest does not pin a version', () => {
    // local.agent has no version; remote moved to a newer version.
    const r = remote({ agent: { id: 'agent_1', type: 'agent', version: 9 } });
    expect(deploymentFieldDiffs(local(), r)).toEqual([]);
  });

  it('detects an agent version change when a version is pinned', () => {
    const diffs = deploymentFieldDiffs(local({ agent: { id: 'agent_1', version: 4 } }), remote());
    expect(diffs).toEqual([]);
    const changed = deploymentFieldDiffs(local({ agent: { id: 'agent_1', version: 5 } }), remote());
    expect(changed.map((d) => d.field)).toEqual(['agent']);
  });

  it('detects a schedule expression change', () => {
    const diffs = deploymentFieldDiffs(
      local({ schedule: { type: 'cron', expression: '30 9 * * 1-5', timezone: 'UTC' } }),
      remote(),
    );
    expect(diffs.map((d) => d.field)).toEqual(['schedule']);
  });

  it('treats a removed schedule (cron -> none) as a change', () => {
    const diffs = deploymentFieldDiffs(local({ schedule: null }), remote());
    expect(diffs.map((d) => d.field)).toEqual(['schedule']);
  });

  it('strips write-only github authorization_token before comparing resources', () => {
    const r = remote({
      resources: [{ type: 'github_repository', url: 'https://github.com/o/r' }],
    });
    const l = local({
      resources: [
        { type: 'github_repository', url: 'https://github.com/o/r', authorization_token: 'ghp_x' },
      ],
    });
    expect(deploymentFieldDiffs(l, r)).toEqual([]);
  });

  it('treats vault_ids as an unordered set', () => {
    const r = remote({ vault_ids: ['vlt_a', 'vlt_b'] });
    const l = local({ vault_ids: ['vlt_b', 'vlt_a'] });
    expect(deploymentFieldDiffs(l, r)).toEqual([]);
  });

  it('detects a vault_ids membership change', () => {
    const r = remote({ vault_ids: ['vlt_a'] });
    const l = local({ vault_ids: ['vlt_a', 'vlt_b'] });
    expect(deploymentFieldDiffs(l, r).map((d) => d.field)).toEqual(['vault_ids']);
  });
});
