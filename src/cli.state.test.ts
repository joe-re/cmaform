import { mkdtemp } from 'node:fs/promises';
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
