import path from 'node:path';

import {
  findAgentByName,
  retrieveAgent,
} from '../lib/agents.js';
import { STATE_PATH } from '../lib/config.js';
import {
  listMemoryStores,
  retrieveMemoryStore,
} from '../lib/memory-stores.js';
import {
  findSkillByDisplayTitle,
  retrieveSkill,
} from '../lib/skills.js';
import { loadState, saveState } from '../lib/state.js';
import { loadAllAgentConfigs } from '../lib/agents.js';
import { loadAllSkillConfigs } from '../lib/skills.js';
import { loadAllMemoryStoreConfigs } from '../lib/memory-stores.js';

/**
 * Update only the local state file to match the current remote. Never writes to remote.
 *
 * - If an entry's remote is archived/missing, remove it from state.
 * - If an entry's version on remote differs, refresh it in state.
 * - If an entry's name on remote differs, rename it in state.
 * - If a local YAML exists without a state entry but a remote with the matching name
 *   exists, discover it and add to state.
 */
export async function cmdRefresh(): Promise<number> {
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
