/**
 * cmaform — Terraform-style management CLI for Anthropic Managed Agents.
 *
 * Subcommands:
 *   pull <agent_id|skill_id|memstore_id>
 *                          Import a single remote resource into state (agents and memory_stores
 *                          are also written out as YAML).
 *   sync                   Re-fetch every entry in state from remote and rewrite local YAML.
 *   refresh                Update only the state file to match remote (no remote writes).
 *   plan [target...]       Show the diff between local YAML / state / remote.
 *   apply [--yes|-y] [target...]
 *                          Show plan, prompt for confirmation, apply, save state.
 *   list                   Show local files / state / remote side-by-side.
 *
 * State:
 *   cmaform.state.json     Tracks name -> { id, version } per resource. Updated by pull / apply.
 *
 * Identity:
 *   An agent's identity is its YAML `name` field (must be unique within the workspace).
 *   When state has it, name -> id is looked up directly; otherwise the remote is searched by name.
 *
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   cmaform pull agent_011CaSWc...   # import an existing agent into local files + state
 *   cmaform plan                     # show diff
 *   cmaform apply                    # confirm prompt -> execute -> save state
 *   cmaform apply --yes              # apply without confirmation (for CI)
 */

import * as crypto from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { isDeepStrictEqual } from 'node:util';

import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const SKILLS_BETA = 'skills-2025-10-02';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

interface MultiagentRosterEntry {
  type: 'agent' | 'self';
  id?: string;
  version?: number;
}

interface MultiagentConfig {
  type: 'coordinator';
  agents: MultiagentRosterEntry[];
}

interface AgentConfig {
  name: string;
  model?: unknown;
  description?: string | null;
  system?: string | null;
  tools?: unknown[];
  mcp_servers?: unknown[];
  skills?: unknown[];
  multiagent?: MultiagentConfig;
  metadata?: Record<string, unknown>;
}

interface RemoteAgent {
  id: string;
  version: number;
  name: string;
  archived_at: string | null;
  model?: unknown;
  description?: string | null;
  system?: string | null;
  tools?: unknown[];
  mcp_servers?: unknown[];
  skills?: unknown[];
  multiagent?: MultiagentConfig;
  metadata?: Record<string, unknown>;
}

interface SkillStateEntry {
  id: string;
  version: string; // epoch timestamp string
  hash: string; // SHA256 hash of all local files in the skill directory
  display_title: string;
}

interface MemoryStoreStateEntry {
  id: string;
  name: string;
}

interface State {
  agents: Record<string, { id: string; version: number }>;
  skills: Record<string, SkillStateEntry>;
  memory_stores: Record<string, MemoryStoreStateEntry>;
}

interface RemoteSkill {
  id: string;
  display_title: string;
  source: string;
  latest_version: string;
  created_at?: string;
}

interface MemoryStoreConfig {
  name: string;
  description?: string | null;
  metadata?: Record<string, string>;
}

interface RemoteMemoryStore {
  id: string;
  name: string;
  description?: string | null;
  metadata?: Record<string, string>;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

const COMPARE_FIELDS: (keyof AgentConfig)[] = [
  'name',
  'model',
  'description',
  'system',
  'tools',
  'mcp_servers',
  'skills',
  'multiagent',
  'metadata',
];

const MEMORY_STORE_COMPARE_FIELDS: (keyof MemoryStoreConfig)[] = [
  'name',
  'description',
  'metadata',
];

// Treat the caller's working directory as the config root.
// Set CMAFORM_DIR to point at a different directory if needed.
const CMAFORM_DIR = process.env.CMAFORM_DIR
  ? path.resolve(process.env.CMAFORM_DIR)
  : process.cwd();
const AGENTS_DIR = path.join(CMAFORM_DIR, 'agents');
const SKILLS_DIR = path.join(CMAFORM_DIR, 'skills');
const MEMORY_STORES_DIR = path.join(CMAFORM_DIR, 'memory_stores');
const STATE_PATH = path.join(CMAFORM_DIR, 'cmaform.state.json');

// ---------------- state ----------------

async function loadState(): Promise<State> {
  try {
    const content = await fs.readFile(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(content) as Partial<State> | null;
    return {
      agents: parsed?.agents ?? {},
      skills: parsed?.skills ?? {},
      memory_stores: parsed?.memory_stores ?? {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { agents: {}, skills: {}, memory_stores: {} };
    }
    throw err;
  }
}

async function saveState(state: State): Promise<void> {
  const sorted: State = { agents: {}, skills: {}, memory_stores: {} };
  for (const key of Object.keys(state.agents).sort()) {
    sorted.agents[key] = state.agents[key];
  }
  for (const key of Object.keys(state.skills).sort()) {
    sorted.skills[key] = state.skills[key];
  }
  for (const key of Object.keys(state.memory_stores).sort()) {
    sorted.memory_stores[key] = state.memory_stores[key];
  }
  await fs.writeFile(
    STATE_PATH,
    JSON.stringify(sorted, null, 2) + '\n',
    'utf-8'
  );
}

// ---------------- yaml ----------------

async function readAgentYaml(filePath: string): Promise<AgentConfig> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parseYaml(content) as AgentConfig | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${filePath}: invalid YAML`);
  }
  if (!parsed.name) {
    throw new Error(`${filePath}: missing required field 'name'`);
  }
  return parsed;
}

async function listAgentFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(AGENTS_DIR, { withFileTypes: true });
    return entries
      .filter(
        e => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml'))
      )
      .map(e => path.join(AGENTS_DIR, e.name))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Return the path of an existing YAML file whose `name` field matches.
 * Used by `pull` to overwrite the same file rather than create a new one with a different filename.
 */
async function findFileByName(name: string): Promise<string | null> {
  const files = await listAgentFiles();
  for (const f of files) {
    try {
      const cfg = await readAgentYaml(f);
      if (cfg.name === name) return f;
    } catch {
      // skip unparseable files
    }
  }
  return null;
}

/**
 * Serialize a remote agent to YAML and write it under agents/. Shared by pull and sync.
 * If a YAML file with the same `name` already exists it is overwritten; otherwise a new
 * file is created with a slug-based filename.
 */
async function writeAgentYamlFromRemote(agent: RemoteAgent): Promise<string> {
  const out = {
    name: agent.name,
    model: agent.model,
    description: agent.description ?? undefined,
    system: agent.system ?? undefined,
    mcp_servers: agent.mcp_servers,
    tools: agent.tools,
    skills: agent.skills,
    multiagent: agent.multiagent,
    metadata: agent.metadata,
  };

  const existingPath = await findFileByName(agent.name);
  const slug = agent.name.replace(/[/\\\s]+/g, '-');
  const filePath = existingPath ?? path.join(AGENTS_DIR, `${slug}.yaml`);
  await fs.mkdir(AGENTS_DIR, { recursive: true });
  await fs.writeFile(filePath, stringifyYaml(out), 'utf-8');
  return filePath;
}

// ---------------- skills (filesystem) ----------------

interface LocalSkill {
  /** directory name (state key + upload root) */
  localName: string;
  dirPath: string;
  /** `name` from SKILL.md YAML frontmatter */
  skillName: string;
  /** `description` from SKILL.md YAML frontmatter */
  description: string;
  /** display_title (defaults to localName) */
  displayTitle: string;
  /** hash of all files in the directory */
  hash: string;
  /** relative paths of files included in the skill */
  files: string[];
}

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
async function hashSkillDir(dirPath: string): Promise<string> {
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

async function loadAllSkillConfigs(): Promise<Map<string, LocalSkill>> {
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

// ---------------- memory stores (filesystem) ----------------

const MEMORY_STORE_MANIFEST_FILENAME = 'manifest.yaml';

async function listMemoryStoreDirs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(MEMORY_STORES_DIR, {
      withFileTypes: true,
    });
    return entries
      .filter(e => e.isDirectory())
      .map(e => path.join(MEMORY_STORES_DIR, e.name))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readMemoryStoreManifest(
  dirPath: string
): Promise<MemoryStoreConfig> {
  const manifestPath = path.join(dirPath, MEMORY_STORE_MANIFEST_FILENAME);
  let content: string;
  try {
    content = await fs.readFile(manifestPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${manifestPath}: ${MEMORY_STORE_MANIFEST_FILENAME} not found`
      );
    }
    throw err;
  }
  const parsed = parseYaml(content) as MemoryStoreConfig | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${manifestPath}: invalid YAML`);
  }
  if (!parsed.name) {
    throw new Error(`${manifestPath}: missing required field 'name'`);
  }
  return parsed;
}

async function loadAllMemoryStoreConfigs(): Promise<
  Map<string, { config: MemoryStoreConfig; dirPath: string }>
> {
  const dirs = await listMemoryStoreDirs();
  const map = new Map<string, { config: MemoryStoreConfig; dirPath: string }>();
  for (const dirPath of dirs) {
    const localName = path.basename(dirPath);
    const config = await readMemoryStoreManifest(dirPath);
    map.set(localName, { config, dirPath });
  }
  return map;
}

async function writeMemoryStoreManifestFromRemote(
  remote: RemoteMemoryStore,
  localName: string
): Promise<string> {
  const out: MemoryStoreConfig = {
    name: remote.name,
    description: remote.description ?? undefined,
    metadata: remote.metadata,
  };
  const dirPath = path.join(MEMORY_STORES_DIR, localName);
  await fs.mkdir(dirPath, { recursive: true });
  const manifestPath = path.join(dirPath, MEMORY_STORE_MANIFEST_FILENAME);
  await fs.writeFile(manifestPath, stringifyYaml(out), 'utf-8');
  return manifestPath;
}

// ---------------- agents (SDK) ----------------

async function listAgents(): Promise<RemoteAgent[]> {
  const results: RemoteAgent[] = [];
  for await (const a of anthropic.beta.agents.list({})) {
    results.push(a as unknown as RemoteAgent);
  }
  return results;
}

async function retrieveAgent(id: string): Promise<RemoteAgent | null> {
  try {
    const a = await anthropic.beta.agents.retrieve(id);
    return a as unknown as RemoteAgent;
  } catch (err) {
    if (isSDKNotFound(err)) return null;
    throw err;
  }
}

async function createAgent(
  params: ReturnType<typeof toApplyParams>
): Promise<RemoteAgent> {
  // The SDK types are strict but we pass arbitrary YAML-sourced shapes, so cast via unknown.
  const created = await anthropic.beta.agents.create(
    params as unknown as Parameters<typeof anthropic.beta.agents.create>[0]
  );
  return created as unknown as RemoteAgent;
}

async function updateAgent(
  id: string,
  version: number,
  params: ReturnType<typeof toApplyParams>
): Promise<RemoteAgent> {
  const updated = await anthropic.beta.agents.update(id, {
    version,
    ...params,
  } as unknown as Parameters<typeof anthropic.beta.agents.update>[1]);
  return updated as unknown as RemoteAgent;
}

async function archiveAgent(id: string): Promise<void> {
  await anthropic.beta.agents.archive(id);
}

// ---------------- skills (SDK) ----------------
//
// The multipart filename must be prefixed with the skill folder name
// (the `name` from SKILL.md frontmatter). The `ant` CLI omits this and gets 400,
// so we build it explicitly via `toFile(stream, "<dir>/<rel>")` from @anthropic-ai/sdk.

function isSDKNotFound(err: unknown): boolean {
  return err instanceof Anthropic.APIError && err.status === 404;
}

async function listSkills(source = 'custom'): Promise<RemoteSkill[]> {
  const results: RemoteSkill[] = [];
  for await (const s of anthropic.beta.skills.list({
    source: source as 'custom' | 'anthropic',
    betas: [SKILLS_BETA],
  })) {
    results.push(s as unknown as RemoteSkill);
  }
  return results;
}

async function retrieveSkill(id: string): Promise<RemoteSkill | null> {
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

async function findSkillByDisplayTitle(
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

async function createSkill(skill: LocalSkill): Promise<RemoteSkill> {
  const files = await buildSkillUploadables(skill);
  const created = await anthropic.beta.skills.create({
    display_title: skill.displayTitle,
    files,
    betas: [SKILLS_BETA],
  });
  return created as unknown as RemoteSkill;
}

async function uploadSkillVersion(
  id: string,
  skill: LocalSkill
): Promise<{ version: string }> {
  // Workaround for an SDK 0.91.0 bug: `skills.versions.create` defaults its internal
  // `stripFilenames` to true, which drops the folder prefix from each multipart filename
  // (skills.create explicitly sets it to false). The API requires filenames of the form
  // "<folder>/SKILL.md", so we build the FormData and POST it ourselves here.
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
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': SKILLS_BETA,
      },
      body: form,
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`skill version create failed (${res.status}): ${text}`);
  }
  return (await res.json()) as { version: string };
}

async function archiveSkill(id: string): Promise<void> {
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

// ---------------- ant: memory stores ----------------

async function listMemoryStores(
  _includeArchived = false
): Promise<RemoteMemoryStore[]> {
  const results: RemoteMemoryStore[] = [];
  for await (const m of anthropic.beta.memoryStores.list({})) {
    results.push(m as unknown as RemoteMemoryStore);
  }
  return results;
}

async function retrieveMemoryStore(
  id: string
): Promise<RemoteMemoryStore | null> {
  try {
    const m = await anthropic.beta.memoryStores.retrieve(id);
    return m as unknown as RemoteMemoryStore;
  } catch (err) {
    if (isSDKNotFound(err)) return null;
    throw err;
  }
}

async function createMemoryStore(
  config: MemoryStoreConfig
): Promise<RemoteMemoryStore> {
  const created = await anthropic.beta.memoryStores.create({
    name: config.name,
    description: config.description ?? undefined,
    metadata: config.metadata,
  } as unknown as Parameters<typeof anthropic.beta.memoryStores.create>[0]);
  return created as unknown as RemoteMemoryStore;
}

async function updateMemoryStore(
  id: string,
  config: MemoryStoreConfig,
  remote: RemoteMemoryStore
): Promise<RemoteMemoryStore> {
  // metadata patch: keys missing locally are sent as null (delete); others are upserted.
  const localMeta = config.metadata ?? {};
  const remoteMeta = remote.metadata ?? {};
  const allKeys = new Set([
    ...Object.keys(localMeta),
    ...Object.keys(remoteMeta),
  ]);
  const metadataPatch: Record<string, string | null> = {};
  for (const k of allKeys) {
    if (!(k in localMeta)) {
      metadataPatch[k] = null;
    } else if (localMeta[k] !== remoteMeta[k]) {
      metadataPatch[k] = localMeta[k];
    }
  }

  const updated = await anthropic.beta.memoryStores.update(id, {
    name: config.name !== remote.name ? config.name : undefined,
    description:
      (config.description ?? '') !== (remote.description ?? '')
        ? (config.description ?? '')
        : undefined,
    metadata: Object.keys(metadataPatch).length > 0 ? metadataPatch : undefined,
  } as unknown as Parameters<typeof anthropic.beta.memoryStores.update>[1]);
  return updated as unknown as RemoteMemoryStore;
}

async function archiveMemoryStore(id: string): Promise<void> {
  await anthropic.beta.memoryStores.archive(id);
}

async function loadAllAgentConfigs(): Promise<
  Map<string, { config: AgentConfig; filePath: string }>
> {
  const files = await listAgentFiles();
  const map = new Map<string, { config: AgentConfig; filePath: string }>();
  for (const f of files) {
    const config = await readAgentYaml(f);
    const existing = map.get(config.name);
    if (existing) {
      throw new Error(
        `name "${config.name}" is duplicated in ${existing.filePath} and ${f}`
      );
    }
    map.set(config.name, { config, filePath: f });
  }
  return map;
}

// ---------------- diff ----------------

function nullToUndefined<T>(v: T): T | undefined {
  return v === null ? undefined : (v as T | undefined);
}

interface FieldDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

function fieldDiffs(local: AgentConfig, remote: RemoteAgent): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of COMPARE_FIELDS) {
    const lv = nullToUndefined(local[field] as unknown);
    const rv = nullToUndefined(remote[field] as unknown);
    if (!isDeepStrictEqual(lv, rv)) {
      diffs.push({ field, oldValue: rv, newValue: lv });
    }
  }
  return diffs;
}

function memoryStoreFieldDiffs(
  local: MemoryStoreConfig,
  remote: RemoteMemoryStore
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of MEMORY_STORE_COMPARE_FIELDS) {
    const lv = nullToUndefined(local[field] as unknown);
    const rv = nullToUndefined(remote[field] as unknown);
    if (!isDeepStrictEqual(lv, rv)) {
      diffs.push({ field, oldValue: rv, newValue: lv });
    }
  }
  return diffs;
}

// ---------------- apply params ----------------

function toApplyParams(config: AgentConfig) {
  return {
    name: config.name,
    model: config.model,
    system: config.system ?? null,
    tools: config.tools,
    mcp_servers: config.mcp_servers,
    skills: config.skills,
    multiagent: config.multiagent,
    description: config.description ?? null,
    metadata: config.metadata,
  };
}

// ---------------- remote helpers ----------------

async function findAgentByName(name: string): Promise<RemoteAgent | null> {
  const agents = await listAgents();
  return agents.find(a => a.name === name && !a.archived_at) ?? null;
}

async function resolveRemote(
  name: string,
  state: State
): Promise<RemoteAgent | null> {
  const tracked = state.agents[name];
  if (tracked) {
    const byId = await retrieveAgent(tracked.id);
    if (byId && !byId.archived_at) return byId;
  }
  return findAgentByName(name);
}

// ---------------- plan ----------------

type Action =
  // agents
  | { type: 'create'; name: string; config: AgentConfig; filePath: string }
  | {
      type: 'update';
      name: string;
      id: string;
      config: AgentConfig;
      filePath: string;
      currentVersion: number;
      diffs: FieldDiff[];
    }
  | { type: 'noop'; name: string; id: string; version: number }
  | { type: 'delete'; name: string; id: string }
  // skills
  | { type: 'skill_create'; localName: string; skill: LocalSkill }
  | {
      type: 'skill_update';
      localName: string;
      id: string;
      skill: LocalSkill;
      currentVersion: string;
      currentHash: string;
    }
  | {
      type: 'skill_noop';
      localName: string;
      id: string;
      version: string;
      hash: string;
      displayTitle: string;
    }
  | {
      type: 'skill_delete';
      localName: string;
      id: string;
    }
  // memory stores
  | {
      type: 'memstore_create';
      localName: string;
      config: MemoryStoreConfig;
      dirPath: string;
    }
  | {
      type: 'memstore_update';
      localName: string;
      id: string;
      config: MemoryStoreConfig;
      remote: RemoteMemoryStore;
      dirPath: string;
      diffs: FieldDiff[];
    }
  | {
      type: 'memstore_noop';
      localName: string;
      id: string;
      name: string;
    }
  | {
      type: 'memstore_archive';
      localName: string;
      id: string;
    };

async function computePlan(
  state: State,
  configs: Map<string, { config: AgentConfig; filePath: string }>,
  skills: Map<string, LocalSkill>,
  memoryStores: Map<string, { config: MemoryStoreConfig; dirPath: string }>
): Promise<Action[]> {
  const actions: Action[] = [];

  // ----- agents -----
  for (const [name, { config, filePath }] of configs) {
    const remote = await resolveRemote(name, state);
    if (!remote || remote.archived_at) {
      actions.push({ type: 'create', name, config, filePath });
      continue;
    }
    const diffs = fieldDiffs(config, remote);
    if (diffs.length === 0) {
      actions.push({
        type: 'noop',
        name,
        id: remote.id,
        version: remote.version,
      });
    } else {
      actions.push({
        type: 'update',
        name,
        id: remote.id,
        config,
        filePath,
        currentVersion: remote.version,
        diffs,
      });
    }
  }
  for (const [name, entry] of Object.entries(state.agents)) {
    if (!configs.has(name)) {
      actions.push({ type: 'delete', name, id: entry.id });
    }
  }

  // ----- skills -----
  for (const [localName, skill] of skills) {
    const tracked = state.skills[localName];
    if (!tracked) {
      // Not tracked in state, but if a remote skill with the same display_title exists, treat as update.
      const remote = await findSkillByDisplayTitle(skill.displayTitle);
      if (remote) {
        actions.push({
          type: 'skill_update',
          localName,
          id: remote.id,
          skill,
          currentVersion: remote.latest_version,
          currentHash: '(unknown)',
        });
      } else {
        actions.push({ type: 'skill_create', localName, skill });
      }
      continue;
    }

    if (tracked.hash === skill.hash) {
      actions.push({
        type: 'skill_noop',
        localName,
        id: tracked.id,
        version: tracked.version,
        hash: tracked.hash,
        displayTitle: tracked.display_title,
      });
    } else {
      actions.push({
        type: 'skill_update',
        localName,
        id: tracked.id,
        skill,
        currentVersion: tracked.version,
        currentHash: tracked.hash,
      });
    }
  }
  for (const [localName, entry] of Object.entries(state.skills)) {
    if (!skills.has(localName)) {
      actions.push({ type: 'skill_delete', localName, id: entry.id });
    }
  }

  // ----- memory stores -----
  for (const [localName, { config, dirPath }] of memoryStores) {
    const tracked = state.memory_stores[localName];
    const remote = tracked ? await retrieveMemoryStore(tracked.id) : null;
    if (!remote || remote.archived_at) {
      actions.push({ type: 'memstore_create', localName, config, dirPath });
      continue;
    }
    const diffs = memoryStoreFieldDiffs(config, remote);
    if (diffs.length === 0) {
      actions.push({
        type: 'memstore_noop',
        localName,
        id: remote.id,
        name: remote.name,
      });
    } else {
      actions.push({
        type: 'memstore_update',
        localName,
        id: remote.id,
        config,
        remote,
        dirPath,
        diffs,
      });
    }
  }
  for (const [localName, entry] of Object.entries(state.memory_stores)) {
    if (!memoryStores.has(localName)) {
      actions.push({ type: 'memstore_archive', localName, id: entry.id });
    }
  }

  return actions;
}

// ---------------- diff rendering ----------------

const ANSI = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
} as const;

function colorize(code: keyof typeof ANSI, text: string): string {
  if (!process.stdout.isTTY) return text;
  return ANSI[code] + text + ANSI.reset;
}

function serializeForDiff(v: unknown): string[] {
  if (v === undefined || v === null) return ['(unset)'];
  if (typeof v === 'string')
    return v.length === 0 ? ['(empty)'] : v.split('\n');
  if (typeof v !== 'object') return [String(v)];
  try {
    return stringifyYaml(v, { lineWidth: 0 }).trimEnd().split('\n');
  } catch {
    return JSON.stringify(v, null, 2).split('\n');
  }
}

type DiffOp = { type: ' ' | '-' | '+'; text: string };
type RenderOp = DiffOp | { type: '...'; count: number };

function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: ' ', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: '-', text: a[i++] });
    } else {
      out.push({ type: '+', text: b[j++] });
    }
  }
  while (i < m) out.push({ type: '-', text: a[i++] });
  while (j < n) out.push({ type: '+', text: b[j++] });
  return out;
}

function collapseUnchanged(ops: DiffOp[], context: number): RenderOp[] {
  const result: RenderOp[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type !== ' ') {
      result.push(ops[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j].type === ' ') j++;
    const runLen = j - i;
    const isHead = result.length === 0;
    const isTail = j >= ops.length;
    const keepBefore = isHead ? 0 : context;
    const keepAfter = isTail ? 0 : context;
    if (runLen <= keepBefore + keepAfter + 1) {
      for (let k = i; k < j; k++) result.push(ops[k]);
    } else {
      for (let k = i; k < i + keepBefore; k++) result.push(ops[k]);
      result.push({ type: '...', count: runLen - keepBefore - keepAfter });
      for (let k = j - keepAfter; k < j; k++) result.push(ops[k]);
    }
    i = j;
  }
  return result;
}

function formatFieldDiff(diff: FieldDiff, indent: string): string {
  const oldLines = serializeForDiff(diff.oldValue);
  const newLines = serializeForDiff(diff.newValue);

  // Short single-line scalars are rendered inline.
  if (
    oldLines.length === 1 &&
    newLines.length === 1 &&
    oldLines[0].length + newLines[0].length + diff.field.length < 80
  ) {
    return (
      `${indent}~ ${diff.field}: ` +
      `${colorize('red', oldLines[0])} -> ${colorize('green', newLines[0])}\n`
    );
  }

  const ops = collapseUnchanged(lcsDiff(oldLines, newLines), 2);
  const lines: string[] = [`${indent}~ ${diff.field}:`];
  for (const op of ops) {
    if (op.type === '...') {
      lines.push(
        `${indent}    ${colorize('dim', `... (${op.count} unchanged line${op.count === 1 ? '' : 's'})`)}`
      );
    } else if (op.type === '-') {
      lines.push(`${indent}  ${colorize('red', `- ${op.text}`)}`);
    } else if (op.type === '+') {
      lines.push(`${indent}  ${colorize('green', `+ ${op.text}`)}`);
    } else {
      lines.push(`${indent}    ${op.text}`);
    }
  }
  return lines.join('\n') + '\n';
}

function actionResourceName(a: Action): string {
  if (
    a.type === 'create' ||
    a.type === 'update' ||
    a.type === 'noop' ||
    a.type === 'delete'
  ) {
    return a.name;
  }
  return a.localName;
}

type ResourceKind = 'agent' | 'skill' | 'memory_store';

function actionResourceKind(a: Action): ResourceKind {
  if (a.type.startsWith('skill_')) return 'skill';
  if (a.type.startsWith('memstore_')) return 'memory_store';
  return 'agent';
}

const RESOURCE_KIND_ALIASES: Record<string, ResourceKind> = {
  agent: 'agent',
  agents: 'agent',
  skill: 'skill',
  skills: 'skill',
  memory_store: 'memory_store',
  memory_stores: 'memory_store',
  memstore: 'memory_store',
  memstores: 'memory_store',
};

function filterActionsByTargets(
  actions: Action[],
  targets: string[]
): { filtered: Action[]; unmatched: string[] } {
  const kindTargets = new Set<ResourceKind>();
  const nameTargets = new Set<string>();
  for (const t of targets) {
    const kind = RESOURCE_KIND_ALIASES[t];
    if (kind) {
      kindTargets.add(kind);
    } else {
      nameTargets.add(t);
    }
  }

  const matchedNames = new Set<string>();
  const filtered: Action[] = [];
  for (const a of actions) {
    const kind = actionResourceKind(a);
    const name = actionResourceName(a);
    if (kindTargets.has(kind) || nameTargets.has(name)) {
      if (nameTargets.has(name)) matchedNames.add(name);
      filtered.push(a);
    }
  }

  const unmatched = [...nameTargets].filter(n => !matchedNames.has(n));
  return { filtered, unmatched };
}

function printPlan(actions: Action[]): void {
  let creates = 0;
  let updates = 0;
  let deletes = 0;
  let noops = 0;
  let skillCreates = 0;
  let skillUpdates = 0;
  let skillDeletes = 0;
  let skillNoops = 0;
  let memCreates = 0;
  let memUpdates = 0;
  let memArchives = 0;
  let memNoops = 0;

  for (const a of actions) {
    switch (a.type) {
      case 'create':
        process.stdout.write(
          `  [+] create agent  ${JSON.stringify(a.name)}\n` +
            `       file: ${path.relative(CMAFORM_DIR, a.filePath)}\n`
        );
        creates++;
        break;
      case 'update':
        process.stdout.write(
          `  [~] update agent  ${JSON.stringify(a.name)} (id=${a.id}, version=${a.currentVersion})\n` +
            `       file: ${path.relative(CMAFORM_DIR, a.filePath)}\n`
        );
        for (const d of a.diffs) {
          process.stdout.write(formatFieldDiff(d, '       '));
        }
        updates++;
        break;
      case 'delete':
        process.stdout.write(
          `  [-] archive agent ${JSON.stringify(a.name)} (id=${a.id})\n` +
            `       reason: present in state but no local YAML\n`
        );
        deletes++;
        break;
      case 'noop':
        noops++;
        break;
      case 'skill_create':
        process.stdout.write(
          `  [+] create skill  ${JSON.stringify(a.localName)}\n` +
            `       dir:  ${path.relative(CMAFORM_DIR, a.skill.dirPath)}\n` +
            `       hash: ${a.skill.hash.slice(0, 12)}...\n`
        );
        skillCreates++;
        break;
      case 'skill_update':
        process.stdout.write(
          `  [~] update skill  ${JSON.stringify(a.localName)} (id=${a.id})\n` +
            `       dir:  ${path.relative(CMAFORM_DIR, a.skill.dirPath)}\n` +
            `       hash: ${a.currentHash.slice(0, 12)}... -> ${a.skill.hash.slice(0, 12)}...\n`
        );
        skillUpdates++;
        break;
      case 'skill_delete':
        process.stdout.write(
          `  [-] delete skill  ${JSON.stringify(a.localName)} (id=${a.id})\n` +
            `       reason: present in state but no local skill directory\n` +
            `       NOTE: skills cannot be archived; all versions will be permanently deleted\n`
        );
        skillDeletes++;
        break;
      case 'skill_noop':
        skillNoops++;
        break;
      case 'memstore_create':
        process.stdout.write(
          `  [+] create memory_store ${JSON.stringify(a.localName)}\n` +
            `       dir:  ${path.relative(CMAFORM_DIR, a.dirPath)}\n` +
            `       name: ${JSON.stringify(a.config.name)}\n`
        );
        memCreates++;
        break;
      case 'memstore_update':
        process.stdout.write(
          `  [~] update memory_store ${JSON.stringify(a.localName)} (id=${a.id})\n` +
            `       dir:  ${path.relative(CMAFORM_DIR, a.dirPath)}\n`
        );
        for (const d of a.diffs) {
          process.stdout.write(formatFieldDiff(d, '       '));
        }
        memUpdates++;
        break;
      case 'memstore_archive':
        process.stdout.write(
          `  [-] archive memory_store ${JSON.stringify(a.localName)} (id=${a.id})\n` +
            `       reason: present in state but no local directory\n` +
            `       NOTE: archive is one-way (cannot be undone); the store's memory data is preserved\n`
        );
        memArchives++;
        break;
      case 'memstore_noop':
        memNoops++;
        break;
    }
  }

  process.stdout.write(
    `\nPlan (agents):         ${creates} to add, ${updates} to change, ${deletes} to archive, ${noops} unchanged.\n` +
      `Plan (skills):         ${skillCreates} to add, ${skillUpdates} to change, ${skillDeletes} to delete, ${skillNoops} unchanged.\n` +
      `Plan (memory_stores):  ${memCreates} to add, ${memUpdates} to change, ${memArchives} to archive, ${memNoops} unchanged.\n`
  );
}

function hasChanges(actions: Action[]): boolean {
  return actions.some(
    a =>
      a.type !== 'noop' && a.type !== 'skill_noop' && a.type !== 'memstore_noop'
  );
}

// ---------------- apply ----------------

async function executeActions(actions: Action[], state: State): Promise<void> {
  for (const a of actions) {
    if (a.type === 'noop') {
      // Existing agent already matching remote — just record it in state, skip API calls.
      state.agents[a.name] = { id: a.id, version: a.version };
      continue;
    }
    if (a.type === 'skill_noop') {
      state.skills[a.localName] = {
        id: a.id,
        version: a.version,
        hash: a.hash,
        display_title: a.displayTitle,
      };
      continue;
    }
    if (a.type === 'memstore_noop') {
      state.memory_stores[a.localName] = { id: a.id, name: a.name };
      continue;
    }

    try {
      if (a.type === 'create') {
        process.stdout.write(
          `  [+] creating agent ${JSON.stringify(a.name)}...`
        );
        const created = await createAgent(toApplyParams(a.config));
        state.agents[a.name] = { id: created.id, version: created.version };
        process.stdout.write(
          ` ok (id=${created.id}, version=${created.version})\n`
        );
      } else if (a.type === 'update') {
        process.stdout.write(
          `  [~] updating agent ${JSON.stringify(a.name)}...`
        );
        const updated = await updateAgent(
          a.id,
          a.currentVersion,
          toApplyParams(a.config)
        );
        state.agents[a.name] = { id: updated.id, version: updated.version };
        process.stdout.write(
          ` ok (version ${a.currentVersion} -> ${updated.version})\n`
        );
      } else if (a.type === 'delete') {
        process.stdout.write(
          `  [-] archiving agent ${JSON.stringify(a.name)}...`
        );
        await archiveAgent(a.id);
        delete state.agents[a.name];
        process.stdout.write(` ok\n`);
      } else if (a.type === 'skill_create') {
        process.stdout.write(
          `  [+] creating skill ${JSON.stringify(a.localName)}...`
        );
        const created = await createSkill(a.skill);
        state.skills[a.localName] = {
          id: created.id,
          version: created.latest_version,
          hash: a.skill.hash,
          display_title: created.display_title,
        };
        process.stdout.write(
          ` ok (id=${created.id}, version=${created.latest_version})\n`
        );
      } else if (a.type === 'skill_update') {
        process.stdout.write(
          `  [~] uploading new version for skill ${JSON.stringify(a.localName)}...`
        );
        const result = await uploadSkillVersion(a.id, a.skill);
        state.skills[a.localName] = {
          id: a.id,
          version: result.version,
          hash: a.skill.hash,
          display_title: a.skill.displayTitle,
        };
        process.stdout.write(
          ` ok (version ${a.currentVersion} -> ${result.version})\n`
        );
      } else if (a.type === 'skill_delete') {
        process.stdout.write(
          `  [-] deleting skill ${JSON.stringify(a.localName)} (and all versions)...`
        );
        await archiveSkill(a.id);
        delete state.skills[a.localName];
        process.stdout.write(` ok\n`);
      } else if (a.type === 'memstore_create') {
        process.stdout.write(
          `  [+] creating memory_store ${JSON.stringify(a.localName)}...`
        );
        const created = await createMemoryStore(a.config);
        state.memory_stores[a.localName] = {
          id: created.id,
          name: created.name,
        };
        process.stdout.write(` ok (id=${created.id})\n`);
      } else if (a.type === 'memstore_update') {
        process.stdout.write(
          `  [~] updating memory_store ${JSON.stringify(a.localName)}...`
        );
        const updated = await updateMemoryStore(a.id, a.config, a.remote);
        state.memory_stores[a.localName] = {
          id: updated.id,
          name: updated.name,
        };
        process.stdout.write(` ok\n`);
      } else if (a.type === 'memstore_archive') {
        process.stdout.write(
          `  [-] archiving memory_store ${JSON.stringify(a.localName)}...`
        );
        await archiveMemoryStore(a.id);
        delete state.memory_stores[a.localName];
        process.stdout.write(` ok\n`);
      }
    } catch (err) {
      process.stdout.write(` failed\n`);
      throw err;
    }
  }
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(`${message} (yes/no): `))
      .trim()
      .toLowerCase();
    return answer === 'yes' || answer === 'y';
  } finally {
    rl.close();
  }
}

// ---------------- commands ----------------

/**
 * Update only the local state file to match the current remote. Never writes to remote.
 *
 * - If an entry's remote is archived/missing, remove it from state.
 * - If an entry's version on remote differs, refresh it in state.
 * - If an entry's name on remote differs, rename it in state.
 * - If a local YAML exists without a state entry but a remote with the matching name
 *   exists, discover it and add to state.
 */
async function cmdRefresh(): Promise<number> {
  const state = await loadState();
  const configs = await loadAllAgentConfigs();
  const skills = await loadAllSkillConfigs();
  const memoryStores = await loadAllMemoryStoreConfigs();

  let changed = 0;

  // ----- agents -----
  for (const [name, entry] of Object.entries(state.agents)) {
    const remote = await retrieveAgent(entry.id);
    if (!remote || remote.archived_at) {
      delete state.agents[name];
      process.stdout.write(
        `  [-] removed from state: agent ${JSON.stringify(name)} (id=${entry.id} is archived or missing)\n`
      );
      changed++;
      continue;
    }
    if (remote.name !== name) {
      delete state.agents[name];
      state.agents[remote.name] = { id: remote.id, version: remote.version };
      process.stdout.write(
        `  [~] renamed agent in state: ${JSON.stringify(name)} -> ${JSON.stringify(remote.name)}\n`
      );
      changed++;
      continue;
    }
    if (remote.version !== entry.version) {
      state.agents[name] = { id: remote.id, version: remote.version };
      process.stdout.write(
        `  [~] agent version refreshed: ${JSON.stringify(name)} ${entry.version} -> ${remote.version}\n`
      );
      changed++;
    }
  }
  for (const [name] of configs) {
    if (state.agents[name]) continue;
    const remote = await findAgentByName(name);
    if (remote) {
      state.agents[name] = { id: remote.id, version: remote.version };
      process.stdout.write(
        `  [+] discovered agent: ${JSON.stringify(name)} (id=${remote.id}, version=${remote.version})\n`
      );
      changed++;
    }
  }

  // ----- skills -----
  for (const [localName, entry] of Object.entries(state.skills)) {
    const remote = await retrieveSkill(entry.id);
    if (!remote) {
      delete state.skills[localName];
      process.stdout.write(
        `  [-] removed from state: skill ${JSON.stringify(localName)} (id=${entry.id} is missing)\n`
      );
      changed++;
      continue;
    }
    if (
      remote.latest_version !== entry.version ||
      remote.display_title !== entry.display_title
    ) {
      state.skills[localName] = {
        id: remote.id,
        version: remote.latest_version,
        hash: entry.hash, // keep the existing hash because the API does not return skill content
        display_title: remote.display_title,
      };
      process.stdout.write(
        `  [~] skill version refreshed: ${JSON.stringify(localName)} ${entry.version} -> ${remote.latest_version}\n`
      );
      changed++;
    }
  }
  for (const [localName, skill] of skills) {
    if (state.skills[localName]) continue;
    const remote = await findSkillByDisplayTitle(skill.displayTitle);
    if (remote) {
      state.skills[localName] = {
        id: remote.id,
        version: remote.latest_version,
        hash: skill.hash,
        display_title: remote.display_title,
      };
      process.stdout.write(
        `  [+] discovered skill: ${JSON.stringify(localName)} (id=${remote.id}, version=${remote.latest_version})\n`
      );
      changed++;
    }
  }

  // ----- memory stores -----
  for (const [localName, entry] of Object.entries(state.memory_stores)) {
    const remote = await retrieveMemoryStore(entry.id);
    if (!remote || remote.archived_at) {
      delete state.memory_stores[localName];
      process.stdout.write(
        `  [-] removed from state: memory_store ${JSON.stringify(localName)} (id=${entry.id} is archived or missing)\n`
      );
      changed++;
      continue;
    }
    if (remote.name !== entry.name) {
      state.memory_stores[localName] = { id: entry.id, name: remote.name };
      process.stdout.write(
        `  [~] memory_store name refreshed: ${JSON.stringify(localName)} (${JSON.stringify(entry.name)} -> ${JSON.stringify(remote.name)})\n`
      );
      changed++;
    }
  }
  // For local manifests without a state entry, discover via name match on remote.
  for (const [localName, { config }] of memoryStores) {
    if (state.memory_stores[localName]) continue;
    const remotes = await listMemoryStores();
    const remote = remotes.find(r => r.name === config.name && !r.archived_at);
    if (remote) {
      state.memory_stores[localName] = { id: remote.id, name: remote.name };
      process.stdout.write(
        `  [+] discovered memory_store: ${JSON.stringify(localName)} (id=${remote.id})\n`
      );
      changed++;
    }
  }

  if (changed === 0) {
    process.stdout.write('No state changes.\n');
    return 0;
  }
  await saveState(state);
  process.stdout.write(
    `\nState refreshed: ${changed} change(s). Saved to ${path.relative(process.cwd(), STATE_PATH)}\n`
  );
  return 0;
}

async function cmdPlan(targets: string[] = []): Promise<number> {
  const state = await loadState();
  const configs = await loadAllAgentConfigs();
  const skills = await loadAllSkillConfigs();
  const memoryStores = await loadAllMemoryStoreConfigs();
  const allActions = await computePlan(state, configs, skills, memoryStores);

  let actions = allActions;
  if (targets.length > 0) {
    const { filtered, unmatched } = filterActionsByTargets(allActions, targets);
    if (unmatched.length > 0) {
      process.stderr.write(
        `error: the following resource names were not found in local YAML, state, or remote: ${unmatched.map(t => JSON.stringify(t)).join(', ')}\n`
      );
      return 2;
    }
    actions = filtered;
    process.stdout.write(
      `(filter: ${targets.map(t => JSON.stringify(t)).join(', ')})\n`
    );
  }

  printPlan(actions);
  return 0;
}

async function cmdApply(
  autoApprove: boolean,
  targets: string[] = []
): Promise<number> {
  const state = await loadState();
  const configs = await loadAllAgentConfigs();
  const skills = await loadAllSkillConfigs();
  const memoryStores = await loadAllMemoryStoreConfigs();
  const allActions = await computePlan(state, configs, skills, memoryStores);

  let actions = allActions;
  if (targets.length > 0) {
    const { filtered, unmatched } = filterActionsByTargets(allActions, targets);
    if (unmatched.length > 0) {
      process.stderr.write(
        `error: the following resource names were not found in local YAML, state, or remote: ${unmatched.map(t => JSON.stringify(t)).join(', ')}\n`
      );
      return 2;
    }
    actions = filtered;
    process.stdout.write(
      `(filter: ${targets.map(t => JSON.stringify(t)).join(', ')})\n`
    );
  }

  printPlan(actions);

  if (!hasChanges(actions)) {
    // No remote operations, but refresh stale state with noop id/version values.
    let stateChanged = false;
    for (const a of actions) {
      if (a.type === 'noop') {
        const existing = state.agents[a.name];
        if (
          !existing ||
          existing.id !== a.id ||
          existing.version !== a.version
        ) {
          state.agents[a.name] = { id: a.id, version: a.version };
          stateChanged = true;
        }
      } else if (a.type === 'skill_noop') {
        const existing = state.skills[a.localName];
        if (
          !existing ||
          existing.id !== a.id ||
          existing.version !== a.version ||
          existing.hash !== a.hash
        ) {
          state.skills[a.localName] = {
            id: a.id,
            version: a.version,
            hash: a.hash,
            display_title: a.displayTitle,
          };
          stateChanged = true;
        }
      } else if (a.type === 'memstore_noop') {
        const existing = state.memory_stores[a.localName];
        if (!existing || existing.id !== a.id || existing.name !== a.name) {
          state.memory_stores[a.localName] = { id: a.id, name: a.name };
          stateChanged = true;
        }
      }
    }
    if (stateChanged) {
      await saveState(state);
      process.stdout.write('\nNo remote changes. State refreshed.\n');
    } else {
      process.stdout.write('\nNo changes. Apply skipped.\n');
    }
    return 0;
  }

  if (!autoApprove) {
    const ok = await confirm('\nDo you want to perform these actions?');
    if (!ok) {
      process.stdout.write('Aborted.\n');
      return 1;
    }
  }

  process.stdout.write('\nApplying...\n');
  try {
    await executeActions(actions, state);
  } finally {
    // Save state even on partial failure (to record what already succeeded).
    await saveState(state);
  }
  process.stdout.write(
    `\nApply complete. State saved: ${path.relative(process.cwd(), STATE_PATH)}\n`
  );
  return 0;
}

async function cmdPull(query: string): Promise<number> {
  if (query.startsWith('skill_')) {
    return cmdPullSkill(query);
  }
  if (query.startsWith('memstore_')) {
    return cmdPullMemoryStore(query);
  }
  if (!query.startsWith('agent_')) {
    process.stderr.write(
      `pull expects an ID starting with 'agent_', 'skill_', or 'memstore_' (got: ${JSON.stringify(query)})\n`
    );
    return 2;
  }

  const agent = await retrieveAgent(query);
  if (!agent) {
    process.stderr.write(`agent not found: ${query}\n`);
    return 1;
  }

  const filePath = await writeAgentYamlFromRemote(agent);
  process.stderr.write(
    `==> wrote ${path.relative(CMAFORM_DIR, filePath)} (id=${agent.id}, version=${agent.version})\n`
  );

  const state = await loadState();
  state.agents[agent.name] = { id: agent.id, version: agent.version };
  await saveState(state);
  process.stderr.write(
    `==> state updated: ${path.relative(CMAFORM_DIR, STATE_PATH)}\n`
  );

  return 0;
}

/**
 * Register a remote skill (by skill_id) into state.
 * The API does not return skill content, so SKILL.md is never generated.
 * If a local skill directory exists, its hash is also recorded in state.
 */
async function cmdPullSkill(skillId: string): Promise<number> {
  const remote = await retrieveSkill(skillId);
  if (!remote) {
    process.stderr.write(`skill not found: ${skillId}\n`);
    return 1;
  }

  const localName = remote.display_title;
  const dirPath = path.join(SKILLS_DIR, localName);

  let hash = '';
  let dirExists = false;
  try {
    const stat = await fs.stat(dirPath);
    dirExists = stat.isDirectory();
    if (dirExists) {
      hash = await hashSkillDir(dirPath);
    }
  } catch {
    /* not exists */
  }

  const state = await loadState();
  state.skills[localName] = {
    id: remote.id,
    version: remote.latest_version,
    hash,
    display_title: remote.display_title,
  };
  await saveState(state);

  process.stderr.write(
    `==> imported skill into state: localName=${JSON.stringify(localName)} id=${remote.id} version=${remote.latest_version}\n`
  );
  if (!dirExists) {
    process.stderr.write(
      `==> NOTE: no local skill directory at ${path.relative(CMAFORM_DIR, dirPath)}.\n` +
        `    SKILL.md cannot be fetched from the API; create it manually before running plan/apply.\n`
    );
  }
  process.stderr.write(
    `==> state updated: ${path.relative(CMAFORM_DIR, STATE_PATH)}\n`
  );
  return 0;
}

/**
 * Import a remote memory_store (by memstore_id), generating
 * `memory_stores/<localName>/manifest.yaml` and registering it in state.
 * `localName` is derived by slugifying the store's name (spaces and slashes become hyphens).
 * If an existing directory already tracks this id, its localName is preserved.
 */
async function cmdPullMemoryStore(memstoreId: string): Promise<number> {
  const remote = await retrieveMemoryStore(memstoreId);
  if (!remote) {
    process.stderr.write(`memory_store not found: ${memstoreId}\n`);
    return 1;
  }

  // Preserve the existing localName if state already tracks the same id.
  const state = await loadState();
  let localName: string | null = null;
  for (const [name, entry] of Object.entries(state.memory_stores)) {
    if (entry.id === remote.id) {
      localName = name;
      break;
    }
  }
  if (!localName) {
    localName = remote.name.replace(/[/\\\s]+/g, '-');
  }

  const manifestPath = await writeMemoryStoreManifestFromRemote(
    remote,
    localName
  );
  process.stderr.write(
    `==> wrote ${path.relative(CMAFORM_DIR, manifestPath)} (id=${remote.id})\n`
  );

  state.memory_stores[localName] = { id: remote.id, name: remote.name };
  await saveState(state);
  process.stderr.write(
    `==> state updated: ${path.relative(CMAFORM_DIR, STATE_PATH)}\n`
  );
  return 0;
}

/**
 * Re-fetch every agent / skill / memory_store recorded in state from remote.
 *
 * agents: fetch from remote, rewrite YAML, refresh the version in state (renames propagate).
 * skills: the API does not return content, so only the version / display_title in state are
 *         refreshed. Local SKILL.md files are NOT regenerated (rebuild manually).
 *
 * Use cases: bulk-generate YAML in an environment that received only a shared state file,
 * or rebuild after accidentally deleting local YAML.
 */
async function cmdSync(): Promise<number> {
  const state = await loadState();
  const skills = await loadAllSkillConfigs();
  const memoryStores = await loadAllMemoryStoreConfigs();

  const hasAnything =
    Object.keys(state.agents).length > 0 ||
    Object.keys(state.skills).length > 0 ||
    Object.keys(state.memory_stores).length > 0 ||
    skills.size > 0 ||
    memoryStores.size > 0;

  if (!hasAnything) {
    process.stdout.write(
      'Both state and local are empty. Run `cmaform pull <agent_id|skill_id|memstore_id>` to import.\n'
    );
    return 0;
  }

  let agentWritten = 0;
  let agentSkipped = 0;
  let skillUpdated = 0;
  let skillSkipped = 0;
  let skillDiscovered = 0;
  let memWritten = 0;
  let memSkipped = 0;
  let memDiscovered = 0;
  let stateChanged = false;

  // ----- agents -----
  for (const name of Object.keys(state.agents)) {
    const entry = state.agents[name];
    const remote = await retrieveAgent(entry.id);
    if (!remote || remote.archived_at) {
      process.stdout.write(
        `  [!] skip agent ${JSON.stringify(name)}: remote is archived or missing (id=${entry.id})\n`
      );
      agentSkipped++;
      continue;
    }

    const filePath = await writeAgentYamlFromRemote(remote);
    process.stdout.write(
      `  [+] wrote ${path.relative(CMAFORM_DIR, filePath)} (id=${remote.id}, version=${remote.version})\n`
    );
    agentWritten++;

    if (remote.name !== name) {
      delete state.agents[name];
      stateChanged = true;
    }
    const current = state.agents[remote.name];
    if (
      !current ||
      current.id !== remote.id ||
      current.version !== remote.version
    ) {
      state.agents[remote.name] = { id: remote.id, version: remote.version };
      stateChanged = true;
    }
  }

  // ----- skills (metadata-only) -----
  for (const localName of Object.keys(state.skills)) {
    const entry = state.skills[localName];
    const remote = await retrieveSkill(entry.id);
    if (!remote) {
      process.stdout.write(
        `  [!] skip skill ${JSON.stringify(localName)}: remote not found (id=${entry.id})\n`
      );
      skillSkipped++;
      continue;
    }
    if (
      remote.latest_version !== entry.version ||
      remote.display_title !== entry.display_title
    ) {
      state.skills[localName] = {
        id: entry.id,
        version: remote.latest_version,
        // The API does not return content, so we keep the existing hash.
        // The next `plan` will compare against local files via this hash.
        hash: entry.hash,
        display_title: remote.display_title,
      };
      process.stdout.write(
        `  [~] skill metadata updated: ${JSON.stringify(localName)} (version ${entry.version} -> ${remote.latest_version})\n`
      );
      skillUpdated++;
      stateChanged = true;
    } else {
      process.stdout.write(
        `  [=] skill up-to-date: ${JSON.stringify(localName)} (version=${entry.version})\n`
      );
    }
  }

  // ----- skills (discover) -----
  // Skills that have a local directory but no state entry: try to find a matching remote and register it.
  for (const [localName, skill] of skills) {
    if (state.skills[localName]) continue;
    const remote = await findSkillByDisplayTitle(skill.displayTitle);
    if (remote) {
      state.skills[localName] = {
        id: remote.id,
        version: remote.latest_version,
        hash: skill.hash,
        display_title: remote.display_title,
      };
      process.stdout.write(
        `  [+] discovered skill: ${JSON.stringify(localName)} (id=${remote.id}, version=${remote.latest_version})\n`
      );
      skillDiscovered++;
      stateChanged = true;
    } else {
      process.stdout.write(
        `  [?] not found on remote: skill ${JSON.stringify(localName)} (display_title=${JSON.stringify(skill.displayTitle)})\n`
      );
    }
  }

  // ----- memory stores -----
  for (const localName of Object.keys(state.memory_stores)) {
    const entry = state.memory_stores[localName];
    const remote = await retrieveMemoryStore(entry.id);
    if (!remote || remote.archived_at) {
      process.stdout.write(
        `  [!] skip memory_store ${JSON.stringify(localName)}: remote is archived or missing (id=${entry.id})\n`
      );
      memSkipped++;
      continue;
    }
    const manifestPath = await writeMemoryStoreManifestFromRemote(
      remote,
      localName
    );
    process.stdout.write(
      `  [+] wrote ${path.relative(CMAFORM_DIR, manifestPath)} (id=${remote.id})\n`
    );
    memWritten++;
    if (entry.name !== remote.name) {
      state.memory_stores[localName] = { id: entry.id, name: remote.name };
      stateChanged = true;
    }
  }
  // For local manifests without state entries, discover via name match.
  for (const [localName, { config }] of memoryStores) {
    if (state.memory_stores[localName]) continue;
    const remotes = await listMemoryStores();
    const remote = remotes.find(r => r.name === config.name && !r.archived_at);
    if (remote) {
      state.memory_stores[localName] = { id: remote.id, name: remote.name };
      process.stdout.write(
        `  [+] discovered memory_store: ${JSON.stringify(localName)} (id=${remote.id})\n`
      );
      memDiscovered++;
      stateChanged = true;
    } else {
      process.stdout.write(
        `  [?] not found on remote: memory_store ${JSON.stringify(localName)} (name=${JSON.stringify(config.name)})\n`
      );
    }
  }

  if (stateChanged) {
    await saveState(state);
    process.stdout.write(
      `\nState updated: ${path.relative(CMAFORM_DIR, STATE_PATH)}\n`
    );
  }
  process.stdout.write(
    `\nSync complete:\n` +
      `  agents:        ${agentWritten} written, ${agentSkipped} skipped\n` +
      `  skills:        ${skillUpdated} updated, ${skillDiscovered} discovered, ${skillSkipped} skipped\n` +
      `  memory_stores: ${memWritten} written, ${memDiscovered} discovered, ${memSkipped} skipped\n` +
      `  (skill content files such as SKILL.md cannot be fetched from the API and are not regenerated)\n`
  );
  return 0;
}

async function cmdList(): Promise<number> {
  const state = await loadState();
  const configs = await loadAllAgentConfigs();
  const skills = await loadAllSkillConfigs();
  const memoryStores = await loadAllMemoryStoreConfigs();

  console.log('=== local agents ===');
  if (configs.size === 0) console.log('  (none)');
  for (const [name, { filePath }] of configs) {
    const tracked = state.agents[name];
    const idStr = tracked
      ? `id=${tracked.id} version=${tracked.version}`
      : 'untracked';
    console.log(
      `  ${path.relative(CMAFORM_DIR, filePath)}  name=${JSON.stringify(name)}  ${idStr}`
    );
  }

  console.log('\n=== remote agents ===');
  const remoteAgents = await listAgents();
  let remoteCount = 0;
  for (const a of remoteAgents) {
    if (a.archived_at) continue;
    const tracked = Object.values(state.agents).some(s => s.id === a.id);
    console.log(
      `  ${JSON.stringify(a.name)}  id=${a.id}  version=${a.version}${tracked ? '' : '  (untracked)'}`
    );
    remoteCount++;
  }
  if (remoteCount === 0) console.log('  (none)');

  console.log('\n=== local skills ===');
  if (skills.size === 0) console.log('  (none)');
  for (const [localName, skill] of skills) {
    const tracked = state.skills[localName];
    const idStr = tracked
      ? `id=${tracked.id} version=${tracked.version} hash_match=${tracked.hash === skill.hash}`
      : 'untracked';
    console.log(
      `  ${path.relative(CMAFORM_DIR, skill.dirPath)}  ${idStr}`
    );
  }

  console.log('\n=== remote skills (custom) ===');
  let remoteSkillCount = 0;
  try {
    const remoteSkills = await listSkills('custom');
    for (const s of remoteSkills) {
      const tracked = Object.values(state.skills).some(e => e.id === s.id);
      console.log(
        `  ${JSON.stringify(s.display_title)}  id=${s.id}  version=${s.latest_version}${tracked ? '' : '  (untracked)'}`
      );
      remoteSkillCount++;
    }
  } catch (err) {
    console.log(`  (fetch failed: ${(err as Error).message})`);
  }
  if (remoteSkillCount === 0) console.log('  (none)');

  console.log('\n=== local memory_stores ===');
  if (memoryStores.size === 0) console.log('  (none)');
  for (const [localName, { config, dirPath }] of memoryStores) {
    const tracked = state.memory_stores[localName];
    const idStr = tracked ? `id=${tracked.id}` : 'untracked';
    console.log(
      `  ${path.relative(CMAFORM_DIR, dirPath)}  name=${JSON.stringify(config.name)}  ${idStr}`
    );
  }

  console.log('\n=== remote memory_stores ===');
  let remoteMemCount = 0;
  try {
    const remoteMems = await listMemoryStores();
    for (const m of remoteMems) {
      if (m.archived_at) continue;
      const tracked = Object.values(state.memory_stores).some(
        e => e.id === m.id
      );
      console.log(
        `  ${JSON.stringify(m.name)}  id=${m.id}${tracked ? '' : '  (untracked)'}`
      );
      remoteMemCount++;
    }
  } catch (err) {
    console.log(`  (fetch failed: ${(err as Error).message})`);
  }
  if (remoteMemCount === 0) console.log('  (none)');

  return 0;
}

function showHelp(): void {
  process.stderr.write(
    `cmaform — Terraform-style management for Anthropic Managed Agents / Skills / Memory Stores.\n\n` +
      `Usage:\n` +
      `  cmaform pull <agent_id>           # import a remote agent (writes YAML + state)\n` +
      `  cmaform pull <skill_id>           # import a remote skill into state only (SKILL.md is not generated)\n` +
      `  cmaform pull <memstore_id>        # import a remote memory_store (writes manifest.yaml + state)\n` +
      `  cmaform sync                      # rewrite YAML for every entry in state from remote\n` +
      `  cmaform refresh                   # update the state file to match remote (no remote writes)\n` +
      `  cmaform plan [target...]          # show diff (target = agents/skills/memory_stores or resource name)\n` +
      `  cmaform apply [--yes|-y] [target...]\n` +
      `                                    # show plan, prompt for confirmation, apply (target = kind or resource name)\n` +
      `  cmaform list                      # show local files / state / remote side-by-side\n` +
      `\n` +
      `Environment:\n` +
      `  ANTHROPIC_API_KEY                 (required) Anthropic API key\n` +
      `  CMAFORM_DIR                       (optional) config root directory (default: cwd)\n` +
      `\n` +
      `Resolved paths:\n` +
      `  cmaform dir:   ${CMAFORM_DIR}\n` +
      `  state file:    ${STATE_PATH}\n`
  );
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);

  // Branch on help first so it works without an API key.
  if (cmd === '--help' || cmd === '-h' || cmd === 'help' || cmd === undefined) {
    showHelp();
    return cmd === undefined ? 2 : 0;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY environment variable is not set');
    return 2;
  }

  switch (cmd) {
    case 'plan': {
      const targets = args.filter(a => !a.startsWith('-'));
      return cmdPlan(targets);
    }
    case 'apply': {
      const autoApprove = args.includes('--yes') || args.includes('-y');
      const targets = args.filter(a => !a.startsWith('-'));
      return cmdApply(autoApprove, targets);
    }
    case 'pull':
      if (!args[0]) {
        showHelp();
        return 2;
      }
      return cmdPull(args[0]);
    case 'refresh':
      return cmdRefresh();
    case 'sync':
      return cmdSync();
    case 'list':
      return cmdList();
    case '--help':
    case '-h':
    case 'help':
      showHelp();
      return 0;
    default:
      showHelp();
      return 2;
  }
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
