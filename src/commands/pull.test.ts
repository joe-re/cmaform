import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/state.js', () => ({
  loadState: vi.fn(),
  saveState: vi.fn(),
}));
vi.mock('../lib/skills.js', () => ({
  retrieveSkill: vi.fn(),
}));

import { retrieveSkill } from '../lib/skills.js';
import { loadState, saveState } from '../lib/state.js';
import { UNKNOWN_SKILL_HASH, type State } from '../lib/types.js';
import { cmdPull } from './pull.js';

function stateWith(skills: State['skills']): State {
  return {
    agents: {},
    skills,
    memory_stores: {},
    environments: {},
    vaults: {},
    deployments: {},
  };
}

describe('cmdPull — skill', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.mocked(saveState).mockReset();
    vi.mocked(retrieveSkill).mockResolvedValue({
      id: 'skill_1',
      display_title: 'my-skill',
      source: 'custom',
      latest_version: '200',
    });
  });

  it('records an unknown hash for a skill that state does not track', async () => {
    vi.mocked(loadState).mockResolvedValue(stateWith({}));

    expect(await cmdPull('skill_1')).toBe(0);

    expect(vi.mocked(saveState).mock.calls[0][0].skills['my-skill']).toEqual({
      id: 'skill_1',
      version: '200',
      hash: UNKNOWN_SKILL_HASH,
      display_title: 'my-skill',
    });
  });

  it('keeps the recorded hash when state already tracks the same skill id', async () => {
    vi.mocked(loadState).mockResolvedValue(
      stateWith({
        'my-skill': {
          id: 'skill_1',
          version: '100',
          hash: 'applied-hash',
          display_title: 'my-skill',
        },
      }),
    );

    expect(await cmdPull('skill_1')).toBe(0);

    expect(vi.mocked(saveState).mock.calls[0][0].skills['my-skill']).toEqual({
      id: 'skill_1',
      version: '200',
      hash: 'applied-hash',
      display_title: 'my-skill',
    });
  });

  it('drops the recorded hash when state tracks a different skill id under that name', async () => {
    vi.mocked(loadState).mockResolvedValue(
      stateWith({
        'my-skill': { id: 'skill_old', version: '1', hash: 'old-hash', display_title: 'my-skill' },
      }),
    );

    expect(await cmdPull('skill_1')).toBe(0);

    expect(vi.mocked(saveState).mock.calls[0][0].skills['my-skill'].hash).toBe(UNKNOWN_SKILL_HASH);
  });
});
