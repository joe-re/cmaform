import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SKILLS_BETA } from './config.js';
import type { LocalSkill } from './types.js';

/**
 * These tests pin what goes over the wire on Skills API calls. cmaform depends
 * on the `skills-2025-10-02` shapes, and the SDK types cannot catch a call that
 * stops asking for them, so a real SDK client is run against a fake `fetch`.
 */

interface RecordedCall {
  method: string;
  path: string;
  beta: string | null;
  form: [string, string][] | null;
}

const API_ORIGIN = 'https://api.anthropic.com';

let calls: RecordedCall[];
let responses: Record<string, unknown>;
let tmpDir: string;

function recordForm(body: unknown): [string, string][] | null {
  if (!(body instanceof FormData)) return null;
  return [...body.entries()].map(([key, value]) => [
    key,
    typeof value === 'string' ? value : `file:${value.name}`,
  ]);
}

async function loadSkillsModule() {
  vi.resetModules();
  return import('./skills.js');
}

async function makeLocalSkill(): Promise<LocalSkill> {
  const dirPath = path.join(tmpDir, 'demo-dir');
  await fs.mkdir(path.join(dirPath, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(dirPath, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n');
  await fs.writeFile(path.join(dirPath, 'scripts', 'run.sh'), 'echo hi\n');
  return {
    localName: 'demo-dir',
    dirPath,
    skillName: 'demo',
    description: 'd',
    displayTitle: 'demo-dir',
    hash: 'h',
    files: ['SKILL.md', 'scripts/run.sh'],
  };
}

beforeEach(async () => {
  calls = [];
  responses = {};
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmaform-skills-'));
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    // The SDK probes `fetch` with a `data:` URL before a multipart upload.
    if (url.origin !== API_ORIGIN) return new Response('');
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({
      method,
      path: url.pathname,
      beta: new Headers(init.headers).get('anthropic-beta'),
      form: recordForm(init.body),
    });
    const body = responses[`${method} ${url.pathname}`] ?? {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Skills API requests', () => {
  it('createSkill sends display_title, folder-prefixed filenames and the beta header', async () => {
    const { createSkill } = await loadSkillsModule();
    responses['POST /v1/skills'] = {
      id: 'skill_1',
      display_title: 'demo-dir',
      latest_version: '1759178010641129',
      source: 'custom',
    };

    const created = await createSkill(await makeLocalSkill());

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/skills',
        beta: SKILLS_BETA,
        form: [
          ['display_title', 'demo-dir'],
          ['files[]', 'file:demo/SKILL.md'],
          ['files[]', 'file:demo/scripts/run.sh'],
        ],
      },
    ]);
    expect(created.latest_version).toBe('1759178010641129');
  });

  it('uploadSkillVersion sends folder-prefixed filenames and the beta header', async () => {
    const { uploadSkillVersion } = await loadSkillsModule();
    responses['POST /v1/skills/skill_1/versions'] = { version: '1759178010641130' };

    const uploaded = await uploadSkillVersion('skill_1', await makeLocalSkill());

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/skills/skill_1/versions',
        beta: SKILLS_BETA,
        form: [
          ['files[]', 'file:demo/SKILL.md'],
          ['files[]', 'file:demo/scripts/run.sh'],
        ],
      },
    ]);
    expect(uploaded.version).toBe('1759178010641130');
  });

  it('listSkills and retrieveSkill ask for the beta shape', async () => {
    const { listSkills, retrieveSkill } = await loadSkillsModule();
    const remote = {
      id: 'skill_1',
      display_title: 'demo-dir',
      latest_version: '1759178010641129',
      source: 'custom',
    };
    responses['GET /v1/skills'] = { data: [remote], has_more: false, next_page: null };
    responses['GET /v1/skills/skill_1'] = remote;

    expect(await listSkills()).toEqual([remote]);
    expect(await retrieveSkill('skill_1')).toEqual(remote);

    expect(calls.map((c) => [c.method, c.path, c.beta])).toEqual([
      ['GET', '/v1/skills', SKILLS_BETA],
      ['GET', '/v1/skills/skill_1', SKILLS_BETA],
    ]);
  });

  it('archiveSkill deletes each version by its timestamp, then the skill', async () => {
    const { archiveSkill } = await loadSkillsModule();
    responses['GET /v1/skills/skill_1/versions'] = {
      data: [{ version: '1759178010641129' }, { version: '1759178010641130' }],
      has_more: false,
      next_page: null,
    };

    await archiveSkill('skill_1');

    expect(calls.map((c) => [c.method, c.path, c.beta])).toEqual([
      ['GET', '/v1/skills/skill_1/versions', SKILLS_BETA],
      ['DELETE', '/v1/skills/skill_1/versions/1759178010641129', SKILLS_BETA],
      ['DELETE', '/v1/skills/skill_1/versions/1759178010641130', SKILLS_BETA],
      ['DELETE', '/v1/skills/skill_1', SKILLS_BETA],
    ]);
  });
});
