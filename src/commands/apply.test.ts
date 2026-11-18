import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/apply.js', () => ({ confirm: vi.fn(), executeActions: vi.fn() }));
vi.mock('../lib/state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/state.js')>()),
  saveState: vi.fn(),
}));
vi.mock('./state-precondition.js', () => ({ loadStateForPlanApply: vi.fn() }));
vi.mock('../lib/agents.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/agents.js')>()),
  loadAllAgentConfigs: vi.fn(async () => new Map()),
  listAgents: vi.fn(async () => []),
  retrieveAgent: vi.fn(async () => null),
}));
vi.mock('../lib/skills.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/skills.js')>()),
  loadAllSkillConfigs: vi.fn(async () => new Map()),
  listSkills: vi.fn(async () => []),
}));
vi.mock('../lib/memory-stores.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/memory-stores.js')>()),
  loadAllMemoryStoreConfigs: vi.fn(async () => new Map()),
  listMemoryStores: vi.fn(async () => []),
  retrieveMemoryStore: vi.fn(async () => null),
}));
vi.mock('../lib/environments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/environments.js')>()),
  loadAllEnvironmentConfigs: vi.fn(async () => new Map()),
  listEnvironments: vi.fn(async () => []),
  retrieveEnvironment: vi.fn(async () => null),
}));
vi.mock('../lib/vaults.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/vaults.js')>()),
  loadAllVaultConfigs: vi.fn(async () => new Map()),
  listVaults: vi.fn(async () => []),
  retrieveVault: vi.fn(async () => null),
}));
vi.mock('../lib/deployments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/deployments.js')>()),
  loadAllDeploymentConfigs: vi.fn(async () => new Map()),
  listDeployments: vi.fn(async () => []),
  retrieveDeployment: vi.fn(async () => null),
}));

import { confirm, executeActions } from '../lib/apply.js';
import { listMemoryStores, loadAllMemoryStoreConfigs } from '../lib/memory-stores.js';
import { loadAllSkillConfigs } from '../lib/skills.js';
import { saveState } from '../lib/state.js';
import type { State } from '../lib/types.js';
import { cmdApply } from './apply.js';
import { loadStateForPlanApply } from './state-precondition.js';

describe('cmdApply — ambiguous remote names outside the targets', () => {
  let stdout: string;
  let stderr: string;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    const state: State = {
      agents: {},
      skills: {},
      memory_stores: {},
      environments: {},
      vaults: {},
      deployments: {},
    };
    vi.mocked(loadStateForPlanApply).mockResolvedValue(state);
    vi.mocked(loadAllSkillConfigs).mockResolvedValue(
      new Map([
        [
          'lint',
          {
            localName: 'lint',
            dirPath: 'skills/lint',
            skillName: 'lint',
            description: '',
            displayTitle: 'lint',
            hash: 'h',
            files: ['SKILL.md'],
          },
        ],
      ]),
    );
    vi.mocked(loadAllMemoryStoreConfigs).mockResolvedValue(
      new Map([['notes', { config: { name: 'notes' }, dirPath: 'memory_stores/notes' }]]),
    );
    vi.mocked(listMemoryStores).mockResolvedValue([
      { id: 'memstore_1', name: 'notes' },
      { id: 'memstore_2', name: 'notes' },
    ]);
    vi.mocked(confirm).mockReset();
    vi.mocked(executeActions).mockReset();
    vi.mocked(saveState).mockReset();
  });

  it('shows the warning before the confirmation prompt and applies only the targets', async () => {
    let shownBeforePrompt = false;
    vi.mocked(confirm).mockImplementation(async () => {
      shownBeforePrompt = stdout.includes('WARN: skipped memory_store "notes"');
      return true;
    });
    expect(await cmdApply(false, ['skills'])).toBe(0);
    expect(shownBeforePrompt).toBe(true);
    const applied = vi.mocked(executeActions).mock.calls[0][0];
    expect(applied.map((a) => a.type)).toEqual(['skill_create']);
  });

  it('stops before anything is applied when the target is the ambiguous resource', async () => {
    expect(await cmdApply(true, ['memory_store:notes'])).toBe(2);
    expect(stderr).toContain('named "notes"');
    expect(executeActions).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
  });

  it('stops without targets', async () => {
    expect(await cmdApply(true, [])).toBe(2);
    expect(executeActions).not.toHaveBeenCalled();
  });
});
