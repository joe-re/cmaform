import * as crypto from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

import { toFile } from '@anthropic-ai/sdk';
import { parse as parseYaml } from 'yaml';

import { SKILLS_BETA, SKILLS_DIR } from './config.js';
import { anthropic, isSDKNotFound } from './sdk.js';
import type { LocalSkill, RemoteSkill } from './types.js';

// ---------------- filesystem ----------------

/**
 * Recursively list files under the directory, sorted by relative path.
 */
async function listFilesRecursive(dirPath: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        result.push(full);
      }
    }
  }
  await walk(dirPath);
  return result.sort();
}

/**
 * Compute a stable hash from all files in a skill directory.
 * Tab-joins (relative path, file SHA256) sorted lines and hashes the result with SHA256.
 */
export async function hashSkillDir(dirPath: string): Promise<string> {
  const files = await listFilesRecursive(dirPath);
  const lines: string[] = [];
  for (const f of files) {
    const content = await fs.readFile(f);
    const fileHash = crypto.createHash('sha256').update(content).digest('hex');
    const rel = path.relative(dirPath, f);
    lines.push(`${rel}\t${fileHash}`);
  }
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Extract `name` and `description` from the YAML frontmatter of SKILL.md. */
function parseSkillFrontmatter(content: string): {
  name: string;
  description: string;
} {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) {
    throw new Error('SKILL.md: YAML frontmatter not found');
  }
  const fm = parseYaml(m[1]) as {
    name?: unknown;
    description?: unknown;
  } | null;
  if (
    !fm ||
    typeof fm.name !== 'string' ||
    typeof fm.description !== 'string'
  ) {
    throw new Error('SKILL.md frontmatter requires both `name` and `description`');
  }
  return { name: fm.name, description: fm.description };
}

async function loadLocalSkill(dirPath: string): Promise<LocalSkill> {
  const localName = path.basename(dirPath);
  const skillMdPath = path.join(dirPath, 'SKILL.md');
  let skillMdContent: string;
  try {
    skillMdContent = await fs.readFile(skillMdPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${dirPath}: SKILL.md is missing`);
    }
    throw err;
  }
  const fm = parseSkillFrontmatter(skillMdContent);
  const files = await listFilesRecursive(dirPath);
  const hash = await hashSkillDir(dirPath);

  return {
    localName,
    dirPath,
    skillName: fm.name,
    description: fm.description,
    displayTitle: localName,
    hash,
    files: files.map(f => path.relative(dirPath, f)),
  };
}

async function listSkillDirs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => path.join(SKILLS_DIR, e.name))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function loadAllSkillConfigs(): Promise<Map<string, LocalSkill>> {
  const dirs = await listSkillDirs();
  const map = new Map<string, LocalSkill>();
  for (const d of dirs) {
    const skill = await loadLocalSkill(d);
    if (map.has(skill.localName)) {
      throw new Error(`duplicate skill directory name: "${skill.localName}"`);
    }
    map.set(skill.localName, skill);
  }
  return map;
}

// ---------------- SDK ----------------
//
// The multipart filename must be prefixed with the skill folder name
// (the `name` from SKILL.md frontmatter). The `ant` CLI omits this and gets 400,
// so we build it explicitly via `toFile(stream, "<dir>/<rel>")` from @anthropic-ai/sdk.

export async function listSkills(source = 'custom'): Promise<RemoteSkill[]> {
  const results: RemoteSkill[] = [];
  for await (const s of anthropic.beta.skills.list({
    source: source as 'custom' | 'anthropic',
    betas: [SKILLS_BETA],
  })) {
    results.push(s as unknown as RemoteSkill);
  }
  return results;
}

export async function retrieveSkill(id: string): Promise<RemoteSkill | null> {
  try {
    const s = await anthropic.beta.skills.retrieve(id, {
      betas: [SKILLS_BETA],
    });
    return s as unknown as RemoteSkill;
  } catch (err) {
    if (isSDKNotFound(err)) return null;
    throw err;
  }
}

export async function findSkillByDisplayTitle(
  title: string
): Promise<RemoteSkill | null> {
  const skills = await listSkills('custom');
  return skills.find(s => s.display_title === title) ?? null;
}

async function buildSkillUploadables(skill: LocalSkill) {
  // Form the multipart filename as "<skillName>/<rel>".
  // The API requires the SKILL.md frontmatter `name` to be used as skillName.
  const files = [];
  for (const rel of skill.files) {
    const fullPath = path.join(skill.dirPath, rel);
    const stream = createReadStream(fullPath);
    const multipartName = `${skill.skillName}/${rel}`;
    files.push(await toFile(stream, multipartName));
  }
  return files;
}

export async function createSkill(skill: LocalSkill): Promise<RemoteSkill> {
  const files = await buildSkillUploadables(skill);
  const created = await anthropic.beta.skills.create({
    display_title: skill.displayTitle,
    files,
    betas: [SKILLS_BETA],
  });
  return created as unknown as RemoteSkill;
}

export async function uploadSkillVersion(
  id: string,
  skill: LocalSkill
): Promise<{ version: string }> {
  // Workaround for an SDK bug still present in @anthropic-ai/sdk 0.98:
  // `skills.versions.create` defaults its internal `stripFilenames` flag to
  // true, which drops the folder prefix from each multipart filename, while
  // `skills.create` explicitly passes false. The API requires filenames of
  // the form "<folder>/SKILL.md", so we build the FormData and POST it
  // ourselves here. Re-test against future SDK releases.
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'uploadSkillVersion requires ANTHROPIC_API_KEY to be set'
    );
  }

  const form = new FormData();
  for (const rel of skill.files) {
    const fullPath = path.join(skill.dirPath, rel);
    const buf = await fs.readFile(fullPath);
    const multipartName = `${skill.skillName}/${rel}`;
    form.append('files[]', new Blob([new Uint8Array(buf)]), multipartName);
  }

  const res = await fetch(
    `https://api.anthropic.com/v1/skills/${id}/versions?beta=true`,
    {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': SKILLS_BETA,
      },
      body: form,
    }
  );
  if (!res.ok) {
    // Truncate the response body before surfacing it so we don't bubble up
    // any unexpectedly long server payload (or, hypothetically, an echoed
    // request snippet) into the user's terminal.
    const text = await res.text();
    const truncated =
      text.length > 500 ? text.slice(0, 500) + '… (truncated)' : text;
    throw new Error(
      `skill version create failed (HTTP ${res.status}): ${truncated}`
    );
  }
  return (await res.json()) as { version: string };
}

export async function archiveSkill(id: string): Promise<void> {
  // Skills have no archive concept, so we delete all versions and then the skill itself.
  // This is destructive — only call it from the `apply` delete action.
  for await (const v of anthropic.beta.skills.versions.list(id, {
    betas: [SKILLS_BETA],
  })) {
    const version = (v as unknown as { version: string }).version;
    await anthropic.beta.skills.versions.delete(version, {
      skill_id: id,
      betas: [SKILLS_BETA],
    });
  }
  await anthropic.beta.skills.delete(id, { betas: [SKILLS_BETA] });
}
