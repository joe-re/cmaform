import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { listEnvironments } from '../lib/environments.js';
import { listMemoryStores, loadAllMemoryStoreConfigs } from '../lib/memory-stores.js';
import { loadAllDeploymentConfigs } from '../lib/deployments.js';
import { loadAllSkillConfigs } from '../lib/skills.js';
import type { State } from '../lib/types.js';
import { cmdPlan } from './plan.js';
import { loadStateForPlanApply } from './state-precondition.js';

describe('cmdPlan — ambiguous remote names and targets', () => {
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
    vi.mocked(loadAllMemoryStoreConfigs).mockResolvedValue(new Map());
    vi.mocked(loadAllDeploymentConfigs).mockResolvedValue(new Map());
    vi.mocked(listMemoryStores).mockResolvedValue([]);
    vi.mocked(listEnvironments).mockResolvedValue([]);
  });

  function ambiguousMemoryStore() {
    vi.mocked(loadAllMemoryStoreConfigs).mockResolvedValue(
      new Map([['notes', { config: { name: 'notes' }, dirPath: 'memory_stores/notes' }]]),
    );
    vi.mocked(listMemoryStores).mockResolvedValue([
      { id: 'memstore_1', name: 'notes' },
      { id: 'memstore_2', name: 'notes' },
    ]);
  }

  function deploymentReferencingAmbiguousEnvironment() {
    vi.mocked(loadAllDeploymentConfigs).mockResolvedValue(
      new Map([
        [
          'nightly',
          {
            config: {
              name: 'nightly',
              agent: { id: 'agent_raw' },
              environment: 'py',
              initial_events: [],
            },
            dirPath: 'deployments/nightly',
          },
        ],
      ]),
    );
    vi.mocked(listEnvironments).mockResolvedValue([
      { id: 'env_1', name: 'py' },
      { id: 'env_2', name: 'py' },
    ] as never);
  }

  it('plans an unrelated target and only warns about an ambiguous memory store', async () => {
    ambiguousMemoryStore();
    expect(await cmdPlan(['skills'])).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain(
      'WARN: skipped memory_store "notes" (not in the target set): 2 active remote resources are named "notes" (id=memstore_1, id=memstore_2)',
    );
    expect(stdout).toContain('Archive the ones you do not need');
    // The warning comes after the plan, and the hint appears once.
    expect(stdout.indexOf('WARN:')).toBeGreaterThan(stdout.indexOf('lint'));
    expect(stdout.match(/Archive the ones/g)).toHaveLength(1);
    // The ambiguous store is not planned as a create.
    expect(stdout).toContain('Plan (memory_stores):  0 to add');
  });

  it.each([['memory_store:notes'], ['memstores'], ['notes']])(
    'fails when the target %s selects the ambiguous memory store',
    async (target) => {
      ambiguousMemoryStore();
      expect(await cmdPlan([target])).toBe(2);
      expect(stderr).toContain(
        'multiple active memory_store resources on remote are named "notes"',
      );
      expect(stderr).toContain('id=memstore_1');
      expect(stderr).not.toContain('not found');
    },
  );

  it('fails without targets and lists every ambiguity', async () => {
    ambiguousMemoryStore();
    deploymentReferencingAmbiguousEnvironment();
    expect(await cmdPlan([])).toBe(2);
    expect(stderr).toContain('named "notes"');
    expect(stderr).toContain('named "py"');
    expect(stderr).toContain('referenced by deployment "nightly"');
    expect(stderr.match(/Archive the ones/g)).toHaveLength(1);
  });

  it('fails when a targeted deployment references an ambiguous environment', async () => {
    deploymentReferencingAmbiguousEnvironment();
    expect(await cmdPlan(['deployment:nightly'])).toBe(2);
    expect(stderr).toContain('multiple active environment resources on remote are named "py"');
    expect(stderr).toContain('referenced by deployment "nightly"');
  });

  it('warns when the deployment that references an ambiguous name is not targeted', async () => {
    deploymentReferencingAmbiguousEnvironment();
    expect(await cmdPlan(['skills'])).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain(
      'WARN: deployment "nightly" (not in the target set) references environment "py": 2 active remote resources are named "py" (id=env_1, id=env_2)',
    );
    expect(stdout).toContain('Plan (deployments):    0 to add');
  });
});
