import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { AGENTS_DIR } from './config.js';
import {
  rewriteAgentRefsToNameForm,
  rewriteSkillRefsToNameForm,
} from './resolve.js';
import { anthropic, isSDKNotFound } from './sdk.js';
import type {
  AgentConfig,
  FieldDiff,
  RemoteAgent,
  State,
} from './types.js';

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

// ---------------- yaml I/O ----------------

export async function readAgentYaml(filePath: string): Promise<AgentConfig> {
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

export async function listAgentFiles(): Promise<string[]> {
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
export async function findFileByName(name: string): Promise<string | null> {
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
 *
 * When a `state` is supplied, any `multiagent.agents[]` / `skills[]` entry whose ID is
 * tracked in state is rewritten back to the human-friendly `name:` form. Pass `null`
 * (or omit) to keep raw IDs.
 */
export async function writeAgentYamlFromRemote(
  agent: RemoteAgent,
  state: State | null = null
): Promise<string> {
  const multiagent =
    state && agent.multiagent
      ? {
          ...agent.multiagent,
          agents:
            (rewriteAgentRefsToNameForm(
              agent.multiagent.agents,
              state
            ) as typeof agent.multiagent.agents) ?? agent.multiagent.agents,
        }
      : agent.multiagent;

  const skills = state
    ? (rewriteSkillRefsToNameForm(agent.skills, state) ?? agent.skills)
    : agent.skills;

  const out = {
    name: agent.name,
    model: agent.model,
    description: agent.description ?? undefined,
    system: agent.system ?? undefined,
    mcp_servers: agent.mcp_servers,
    tools: agent.tools,
    skills,
    multiagent,
    metadata: agent.metadata,
  };

  const existingPath = await findFileByName(agent.name);
  const slug = agent.name.replace(/[/\\\s]+/g, '-');
  const filePath = existingPath ?? path.join(AGENTS_DIR, `${slug}.yaml`);
  await fs.mkdir(AGENTS_DIR, { recursive: true });
  await fs.writeFile(filePath, stringifyYaml(out), 'utf-8');
  return filePath;
}

export async function loadAllAgentConfigs(): Promise<
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

// ---------------- SDK ----------------

export async function listAgents(): Promise<RemoteAgent[]> {
  const results: RemoteAgent[] = [];
  for await (const a of anthropic.beta.agents.list({})) {
    results.push(a as unknown as RemoteAgent);
  }
  return results;
}

export async function retrieveAgent(id: string): Promise<RemoteAgent | null> {
  try {
    const a = await anthropic.beta.agents.retrieve(id);
    return a as unknown as RemoteAgent;
  } catch (err) {
    if (isSDKNotFound(err)) return null;
    throw err;
  }
}

export async function createAgent(
  params: ReturnType<typeof toApplyParams>
): Promise<RemoteAgent> {
  // The SDK types are strict but we pass arbitrary YAML-sourced shapes, so cast via unknown.
  const created = await anthropic.beta.agents.create(
    params as unknown as Parameters<typeof anthropic.beta.agents.create>[0]
  );
  return created as unknown as RemoteAgent;
}

export async function updateAgent(
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

export async function archiveAgent(id: string): Promise<void> {
  await anthropic.beta.agents.archive(id);
}

// ---------------- diff + helpers ----------------

function nullToUndefined<T>(v: T): T | undefined {
  return v === null ? undefined : (v as T | undefined);
}

export function fieldDiffs(
  local: AgentConfig,
  remote: RemoteAgent
): FieldDiff[] {
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

export function toApplyParams(config: AgentConfig) {
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

export async function findAgentByName(
  name: string
): Promise<RemoteAgent | null> {
  const agents = await listAgents();
  return agents.find(a => a.name === name && !a.archived_at) ?? null;
}

export async function resolveRemote(
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
