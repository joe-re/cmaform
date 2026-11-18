import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./memory-stores.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memory-stores.js')>()),
  createMemoryStore: vi.fn(),
}));

vi.mock('./deployments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./deployments.js')>()),
  createDeployment: vi.fn(),
}));

import { executeActions } from './apply.js';
import { createDeployment } from './deployments.js';
import type { Action } from './plan.js';
import {
  pendingEnvironmentSentinel,
  pendingMemoryStoreSentinel,
  pendingVaultSentinel,
} from './resolve.js';
import { createMemoryStore } from './memory-stores.js';
import type { State } from './types.js';

function emptyState(): State {
  return {
    agents: { spec: { id: 'agent_1', version: 1 } },
    skills: {},
    memory_stores: {},
    environments: {},
    vaults: {},
    deployments: {},
  };
}

describe('executeActions — adopted noops feed forward references', () => {
  beforeEach(() => {
    vi.mocked(createDeployment).mockReset();
    vi.mocked(createDeployment).mockResolvedValue({ id: 'dep_1', name: 'nightly' } as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('substitutes environment and vault sentinels that point at adopted noops', async () => {
    const state = emptyState();
    const actions: Action[] = [
      { type: 'env_noop', localName: 'py', id: 'env_adopted', name: 'py', adopted: true },
      {
        type: 'vault_noop',
        localName: 'bot',
        id: 'vlt_adopted',
        display_name: 'Bot',
        adopted: true,
      },
      {
        type: 'deploy_create',
        localName: 'nightly',
        dirPath: 'deployments/nightly',
        config: {
          name: 'nightly',
          agent: { id: 'agent_1' },
          environment_id: pendingEnvironmentSentinel('py'),
          initial_events: [],
          vault_ids: [pendingVaultSentinel('bot')],
        },
        forwardAgentDeps: [],
        forwardEnvDeps: ['py'],
        forwardVaultDeps: ['bot'],
        forwardMemoryStoreDeps: [],
      },
    ];

    await executeActions(actions, state);

    expect(createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ environment_id: 'env_adopted', vault_ids: ['vlt_adopted'] }),
    );
    expect(state.environments.py).toEqual({ id: 'env_adopted', name: 'py' });
    expect(state.vaults.bot).toEqual({ id: 'vlt_adopted', display_name: 'Bot' });
  });

  it('substitutes memory store sentinels from created and adopted stores', async () => {
    vi.mocked(createMemoryStore).mockResolvedValue({ id: 'memstore_new', name: 'Fresh' } as never);
    const state = emptyState();
    const deployment: Action = {
      type: 'deploy_create',
      localName: 'nightly',
      dirPath: 'deployments/nightly',
      config: {
        name: 'nightly',
        agent: { id: 'agent_1' },
        environment_id: 'env_1',
        initial_events: [],
        resources: [
          { type: 'memory_store', memory_store_id: pendingMemoryStoreSentinel('fresh') },
          { type: 'memory_store', memory_store_id: pendingMemoryStoreSentinel('adopted') },
        ],
      },
      forwardAgentDeps: [],
      forwardEnvDeps: [],
      forwardVaultDeps: [],
      forwardMemoryStoreDeps: ['fresh', 'adopted'],
    };
    const actions: Action[] = [
      {
        type: 'memstore_create',
        localName: 'fresh',
        config: { name: 'Fresh' },
        dirPath: 'memory_stores/fresh',
      },
      {
        type: 'memstore_noop',
        localName: 'adopted',
        id: 'memstore_adopted',
        name: 'Adopted',
        adopted: true,
      },
      deployment,
    ];

    await executeActions(actions, state);

    expect(createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: [
          { type: 'memory_store', memory_store_id: 'memstore_new' },
          { type: 'memory_store', memory_store_id: 'memstore_adopted' },
        ],
      }),
    );
  });
});
