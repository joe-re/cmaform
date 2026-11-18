import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCmaformDir = process.env.CMAFORM_DIR;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (originalCmaformDir === undefined) {
    delete process.env.CMAFORM_DIR;
  } else {
    process.env.CMAFORM_DIR = originalCmaformDir;
  }
});

describe('plan/apply state precondition', () => {
  it.each(['plan', 'apply'])('fails %s when cmaform.state.json is missing', async (cmd) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cmaform-missing-state-'));
    process.env.CMAFORM_DIR = dir;
    vi.resetModules();

    let stdout = '';
    let stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    });

    const code =
      cmd === 'plan'
        ? await (await import('./commands/plan.js')).cmdPlan()
        : await (await import('./commands/apply.js')).cmdApply(true);

    expect(code).toBe(2);
    expect(stderr).toContain('cmaform.state.json is missing');
    expect(stderr).toContain('cmaform init');
    expect(stdout).toBe('');
  });
});

describe('init state bootstrap', () => {
  function captureOutput() {
    const out = { stdout: '', stderr: '' };
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.stdout += chunk.toString();
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.stderr += chunk.toString();
      return true;
    });
    return out;
  }

  async function useTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'cmaform-init-state-'));
    process.env.CMAFORM_DIR = dir;
    vi.resetModules();
    return dir;
  }

  it('creates an empty state file on init in a fresh project, and plan then succeeds', async () => {
    const dir = await useTempDir();
    const out = captureOutput();

    const initCode = await (await import('./commands/init.js')).cmdInit();
    expect(initCode).toBe(0);
    expect(out.stdout).toContain('Initialized empty state');
    const state = JSON.parse(await readFile(path.join(dir, 'cmaform.state.json'), 'utf-8'));
    expect(state).toEqual({
      agents: {},
      skills: {},
      memory_stores: {},
      environments: {},
      vaults: {},
      deployments: {},
    });

    out.stdout = '';
    out.stderr = '';
    const planCode = await (await import('./commands/plan.js')).cmdPlan();
    expect(planCode).toBe(0);
    expect(out.stderr).not.toContain('cmaform.state.json is missing');
  });

  it('leaves an existing state file untouched when nothing changed', async () => {
    const dir = await useTempDir();
    const statePath = path.join(dir, 'cmaform.state.json');
    const original =
      '{"agents":{},"skills":{},"memory_stores":{},"environments":{},"vaults":{},"deployments":{}}';
    await writeFile(statePath, original);
    const out = captureOutput();

    const code = await (await import('./commands/init.js')).cmdInit();

    expect(code).toBe(0);
    expect(out.stdout).toContain('No state changes.');
    expect(out.stdout).not.toContain('Initialized empty state');
    expect(await readFile(statePath, 'utf-8')).toBe(original);
  });
});
