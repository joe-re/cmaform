import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agents.js', () => ({ listAgents: vi.fn() }));
vi.mock('./skills.js', () => ({ listSkills: vi.fn() }));
vi.mock('./memory-stores.js', () => ({ listMemoryStores: vi.fn() }));
vi.mock('./environments.js', () => ({ listEnvironments: vi.fn() }));
vi.mock('./vaults.js', () => ({ listVaults: vi.fn() }));
vi.mock('./deployments.js', () => ({ listDeployments: vi.fn() }));

import { listMemoryStores } from './memory-stores.js';
import { listSkills } from './skills.js';
import {
  AmbiguousRemoteNameError,
  createRemoteLookup,
  requireUnique,
  type NameLookup,
} from './remote-lookup.js';
import type { RemoteMemoryStore, RemoteSkill } from './types.js';

function store(id: string, name: string, archived_at: string | null = null): RemoteMemoryStore {
  return { id, name, archived_at, created_at: `2026-01-0${id.length}` } as RemoteMemoryStore;
}

beforeEach(() => {
  vi.mocked(listMemoryStores).mockReset();
  vi.mocked(listSkills).mockReset();
});

describe('createRemoteLookup', () => {
  it('lists each kind only once and serves later queries from the cache', async () => {
    vi.mocked(listMemoryStores).mockResolvedValue([store('ms_1', 'a'), store('ms_2', 'b')]);
    const lookup = createRemoteLookup();
    expect(await lookup.memoryStoreByName('a')).toMatchObject({ kind: 'one' });
    expect(await lookup.memoryStoreByName('b')).toMatchObject({ kind: 'one' });
    expect(await lookup.memoryStoreByName('c')).toEqual({ kind: 'none' });
    expect(listMemoryStores).toHaveBeenCalledTimes(1);
  });

  it('ignores archived resources', async () => {
    vi.mocked(listMemoryStores).mockResolvedValue([store('ms_1', 'a', '2026-01-01')]);
    expect(await createRemoteLookup().memoryStoreByName('a')).toEqual({ kind: 'none' });
  });

  it('reports ambiguity when two active resources share a name', async () => {
    vi.mocked(listMemoryStores).mockResolvedValue([store('ms_1', 'a'), store('ms_22', 'a')]);
    const res = await createRemoteLookup().memoryStoreByName('a');
    expect(res.kind).toBe('ambiguous');
    if (res.kind === 'ambiguous')
      expect(res.candidates.map((c) => c.id)).toEqual(['ms_1', 'ms_22']);
  });

  it('narrows candidates with excludeIds', async () => {
    vi.mocked(listMemoryStores).mockResolvedValue([store('ms_1', 'a'), store('ms_22', 'a')]);
    const res = await createRemoteLookup().memoryStoreByName('a', {
      excludeIds: new Set(['ms_1']),
    });
    expect(res).toMatchObject({ kind: 'one', remote: { id: 'ms_22' } });
  });

  it('matches skills by display_title without an archive check', async () => {
    vi.mocked(listSkills).mockResolvedValue([
      { id: 'skill_1', display_title: 'S', source: 'custom', latest_version: '1' } as RemoteSkill,
    ]);
    const res = await createRemoteLookup().skillByDisplayTitle('S');
    expect(res).toMatchObject({ kind: 'one', remote: { id: 'skill_1' } });
    expect(listSkills).toHaveBeenCalledWith('custom');
  });
});

describe('requireUnique', () => {
  it('returns null / the remote for none / one', () => {
    expect(requireUnique('memory_store', 'a', { kind: 'none' })).toBeNull();
    const remote = store('ms_1', 'a');
    expect(requireUnique('memory_store', 'a', { kind: 'one', remote })).toBe(remote);
  });

  it('throws AmbiguousRemoteNameError for ambiguous lookups', () => {
    const lookup: NameLookup<RemoteMemoryStore> = {
      kind: 'ambiguous',
      candidates: [store('ms_1', 'a'), store('ms_22', 'a')],
    };
    try {
      requireUnique('memory_store', 'a', lookup);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousRemoteNameError);
      const e = err as AmbiguousRemoteNameError;
      expect(e.resourceKind).toBe('memory_store');
      expect(e.resourceName).toBe('a');
      expect(e.candidates.map((c) => c.id)).toEqual(['ms_1', 'ms_22']);
    }
  });
});
