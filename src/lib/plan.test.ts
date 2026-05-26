import { describe, expect, it } from 'vitest';

import { filterActionsByTargets, hasChanges, type Action } from './plan.js';

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
