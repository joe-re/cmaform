import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  retrieveAgent,
  writeAgentYamlFromRemote,
} from '../lib/agents.js';
import {
  CMAFORM_DIR,
  SKILLS_DIR,
  STATE_PATH,
} from '../lib/config.js';
import {
  retrieveMemoryStore,
  writeMemoryStoreManifestFromRemote,
} from '../lib/memory-stores.js';
import { hashSkillDir, retrieveSkill } from '../lib/skills.js';
import { loadState, saveState } from '../lib/state.js';

export async function cmdPull(query: string): Promise<number> {
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

  const state = await loadState();
  // Pre-register so that ref-rewriting can see this agent's own state (rare,
  // but harmless if multiagent.agents references itself).
  state.agents[agent.name] = { id: agent.id, version: agent.version };
  const filePath = await writeAgentYamlFromRemote(agent, state);
  process.stderr.write(
    `==> wrote ${path.relative(CMAFORM_DIR, filePath)} (id=${agent.id}, version=${agent.version})\n`
  );
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
