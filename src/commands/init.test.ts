import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/state.js', () => ({
  loadState: vi.fn(),
  saveState: vi.fn(),
  stateFileExists: vi.fn(async () => true),
}));
vi.mock('../lib/agents.js', () => ({
  loadAllAgentConfigs: vi.fn(async () => new Map()),
  listAgents: vi.fn(async () => []),
  retrieveAgent: vi.fn(),
}));
vi.mock('../lib/skills.js', () => ({
  loadAllSkillConfigs: vi.fn(async () => new Map()),
  listSkills: vi.fn(async () => []),
  retrieveSkill: vi.fn(),
}));
vi.mock('../lib/memory-stores.js', () => ({
  loadAllMemoryStoreConfigs: vi.fn(),
  listMemoryStores: vi.fn(),
  retrieveMemoryStore: vi.fn(),
}));
vi.mock('../lib/environments.js', () => ({
  loadAllEnvironmentConfigs: vi.fn(),
  listEnvironments: vi.fn(),
  retrieveEnvironment: vi.fn(),
}));
vi.mock('../lib/vaults.js', () => ({
  loadAllVaultConfigs: vi.fn(async () => new Map()),
  listVaults: vi.fn(async () => []),
  retrieveVault: vi.fn(),
}));
vi.mock('../lib/deployments.js', () => ({
  loadAllDeploymentConfigs: vi.fn(async () => new Map()),
  listDeployments: vi.fn(async () => []),
  retrieveDeployment: vi.fn(),
}));

import { loadAllEnvironmentConfigs, listEnvironments } from '../lib/environments.js';
import { listMemoryStores, loadAllMemoryStoreConfigs } from '../lib/memory-stores.js';
import { loadState, saveState } from '../lib/state.js';
import type { State } from '../lib/types.js';
import { cmdInit } from './init.js';

describe('cmdInit — ambiguous remote names', () => {
  let output: string;

  beforeEach(() => {
    output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    vi.mocked(saveState).mockReset();
    const state: State = {
      agents: {},
      skills: {},
      memory_stores: {},
      environments: {},
      vaults: {},
      deployments: {},
    };
    vi.mocked(loadState).mockResolvedValue(state);
    vi.mocked(loadAllMemoryStoreConfigs).mockResolvedValue(
      new Map([
        ['dup', { config: { name: 'Dup' }, dirPath: 'memory_stores/dup' }],
        ['solo', { config: { name: 'Solo' }, dirPath: 'memory_stores/solo' }],
      ]),
    );
    vi.mocked(listMemoryStores).mockResolvedValue([
      { id: 'ms_1', name: 'Dup' },
      { id: 'ms_2', name: 'Dup' },
      { id: 'ms_3', name: 'Solo' },
    ]);
    vi.mocked(loadAllEnvironmentConfigs).mockResolvedValue(
      new Map([
        ['py', { config: { name: 'py', config: {} } as never, dirPath: 'environments/py' }],
      ]),
    );
    vi.mocked(listEnvironments).mockResolvedValue([
      { id: 'env_1', name: 'py', config: {} } as never,
    ]);
  });

  it('skips the ambiguous resource, still discovers the rest, and returns 1', async () => {
    const code = await cmdInit();

    expect(code).toBe(1);
    expect(output).toContain(
      '[!] skipped memory_store "dup": 2 active remote resources are named "Dup" (id=ms_1, id=ms_2)',
    );
    expect(output).toContain('cmaform pull <id>');
    expect(listMemoryStores).toHaveBeenCalledTimes(1);

    expect(saveState).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveState).mock.calls[0][0];
    expect(saved.memory_stores).toEqual({ solo: { id: 'ms_3', name: 'Solo' } });
    expect(saved.environments).toEqual({ py: { id: 'env_1', name: 'py' } });
  });
});
