import path from 'node:path';

import { retrieveAgent } from '../lib/agents.js';
import { STATE_PATH } from '../lib/config.js';
import { loadAllDeploymentConfigs, retrieveDeployment } from '../lib/deployments.js';
import { loadAllEnvironmentConfigs, retrieveEnvironment } from '../lib/environments.js';
import { retrieveMemoryStore } from '../lib/memory-stores.js';
import {
  createRemoteLookup,
  idsTrackedElsewhere,
  type NameLookup,
  type RemoteResourceKind,
} from '../lib/remote-lookup.js';
import { retrieveSkill } from '../lib/skills.js';
import { loadState, saveState, stateFileExists } from '../lib/state.js';
import { UNKNOWN_SKILL_HASH } from '../lib/types.js';
import { loadAllAgentConfigs } from '../lib/agents.js';
import { loadAllSkillConfigs } from '../lib/skills.js';
import { loadAllMemoryStoreConfigs } from '../lib/memory-stores.js';
import { loadAllVaultConfigs, retrieveVault } from '../lib/vaults.js';
import { AMBIGUOUS_REMOTE_HINT, formatAmbiguousSkip } from './ambiguous-remote.js';

/**
 * Initialize / reconcile the local state file against the current remote. Never writes to remote.
 *
 * - If an entry's remote is archived/missing, remove it from state.
 * - If an entry's version on remote differs, refresh it in state.
 * - If an entry's name on remote differs, rename it in state.
 * - If a local YAML exists without a state entry but a remote with the matching name
 *   exists, discover it and add to state.
 *
 * If the state file does not exist yet, an empty one is created even when nothing changed.
 *
 * Equivalent in spirit to `terraform init` — set up the local state so subsequent
 * `plan` / `apply` operate against an accurate view of the world.
 */
export async function cmdInit(): Promise<number> {
  const stateExisted = await stateFileExists();
  const state = await loadState();
  const configs = await loadAllAgentConfigs();
  const skills = await loadAllSkillConfigs();
  const memoryStores = await loadAllMemoryStoreConfigs();
  const environments = await loadAllEnvironmentConfigs();
  const vaults = await loadAllVaultConfigs();
  const deployments = await loadAllDeploymentConfigs();

  const lookup = createRemoteLookup();
  let changed = 0;
  let skipped = 0;

  // A name matching several active remote resources is never resolved by
  // picking one: the resource is skipped and reported, and init exits non-zero.
  const unique = <T extends { id: string }>(
    kind: RemoteResourceKind,
    localName: string,
    name: string,
    found: NameLookup<T>,
  ): T | null => {
    if (found.kind === 'one') return found.remote;
    if (found.kind === 'ambiguous') {
      process.stdout.write(formatAmbiguousSkip(kind, localName, name, found.candidates));
      skipped++;
    }
    return null;
  };

  // ----- agents -----
  for (const [name, entry] of Object.entries(state.agents)) {
    const remote = await retrieveAgent(entry.id);
    if (!remote || remote.archived_at) {
      delete state.agents[name];
      process.stdout.write(
        `  [-] removed from state: agent ${JSON.stringify(name)} (id=${entry.id} is archived or missing)\n`,
      );
      changed++;
      continue;
    }
    if (remote.name !== name) {
      delete state.agents[name];
      state.agents[remote.name] = { id: remote.id, version: remote.version };
      process.stdout.write(
        `  [~] renamed agent in state: ${JSON.stringify(name)} -> ${JSON.stringify(remote.name)}\n`,
      );
      changed++;
      continue;
    }
    if (remote.version !== entry.version) {
      state.agents[name] = { id: remote.id, version: remote.version };
      process.stdout.write(
        `  [~] agent version refreshed: ${JSON.stringify(name)} ${entry.version} -> ${remote.version}\n`,
      );
      changed++;
    }
  }
  for (const [name] of configs) {
    if (state.agents[name]) continue;
    const remote = unique('agent', name, name, await lookup.agentByName(name));
    if (remote) {
      state.agents[name] = { id: remote.id, version: remote.version };
      process.stdout.write(
        `  [+] discovered agent: ${JSON.stringify(name)} (id=${remote.id}, version=${remote.version})\n`,
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
        `  [-] removed from state: skill ${JSON.stringify(localName)} (id=${entry.id} is missing)\n`,
      );
      changed++;
      continue;
    }
    if (remote.latest_version !== entry.version || remote.display_title !== entry.display_title) {
      state.skills[localName] = {
        id: remote.id,
        version: remote.latest_version,
        hash: entry.hash, // keep the existing hash because the API does not return skill content
        display_title: remote.display_title,
      };
      process.stdout.write(
        `  [~] skill version refreshed: ${JSON.stringify(localName)} ${entry.version} -> ${remote.latest_version}\n`,
      );
      changed++;
    }
  }
  for (const [localName, skill] of skills) {
    if (state.skills[localName]) continue;
    const remote = unique(
      'skill',
      localName,
      skill.displayTitle,
      await lookup.skillByDisplayTitle(skill.displayTitle, {
        excludeIds: idsTrackedElsewhere(state.skills, localName),
      }),
    );
    if (remote) {
      state.skills[localName] = {
        id: remote.id,
        version: remote.latest_version,
        hash: UNKNOWN_SKILL_HASH,
        display_title: remote.display_title,
      };
      process.stdout.write(
        `  [+] discovered skill: ${JSON.stringify(localName)} (id=${remote.id}, version=${remote.latest_version})\n`,
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
        `  [-] removed from state: memory_store ${JSON.stringify(localName)} (id=${entry.id} is archived or missing)\n`,
      );
      changed++;
      continue;
    }
    if (remote.name !== entry.name) {
      state.memory_stores[localName] = { id: entry.id, name: remote.name };
      process.stdout.write(
        `  [~] memory_store name refreshed: ${JSON.stringify(localName)} (${JSON.stringify(entry.name)} -> ${JSON.stringify(remote.name)})\n`,
      );
      changed++;
    }
  }
  // For local manifests without a state entry, discover via name match on remote.
  for (const [localName, { config }] of memoryStores) {
    if (state.memory_stores[localName]) continue;
    const remote = unique(
      'memory_store',
      localName,
      config.name,
      await lookup.memoryStoreByName(config.name, {
        excludeIds: idsTrackedElsewhere(state.memory_stores, localName),
      }),
    );
    if (remote) {
      state.memory_stores[localName] = { id: remote.id, name: remote.name };
      process.stdout.write(
        `  [+] discovered memory_store: ${JSON.stringify(localName)} (id=${remote.id})\n`,
      );
      changed++;
    }
  }

  // ----- environments -----
  for (const [localName, entry] of Object.entries(state.environments)) {
    const remote = await retrieveEnvironment(entry.id);
    if (!remote || remote.archived_at) {
      delete state.environments[localName];
      process.stdout.write(
        `  [-] removed from state: environment ${JSON.stringify(localName)} (id=${entry.id} is archived or missing)\n`,
      );
      changed++;
      continue;
    }
    if (remote.name !== entry.name) {
      state.environments[localName] = { id: entry.id, name: remote.name };
      process.stdout.write(
        `  [~] environment name refreshed: ${JSON.stringify(localName)} (${JSON.stringify(entry.name)} -> ${JSON.stringify(remote.name)})\n`,
      );
      changed++;
    }
  }
  for (const [localName, { config }] of environments) {
    if (state.environments[localName]) continue;
    const remote = unique(
      'environment',
      localName,
      config.name,
      await lookup.environmentByName(config.name, {
        excludeIds: idsTrackedElsewhere(state.environments, localName),
      }),
    );
    if (remote) {
      state.environments[localName] = { id: remote.id, name: remote.name };
      process.stdout.write(
        `  [+] discovered environment: ${JSON.stringify(localName)} (id=${remote.id})\n`,
      );
      changed++;
    }
  }

  // ----- vaults -----
  for (const [localName, entry] of Object.entries(state.vaults)) {
    const remote = await retrieveVault(entry.id);
    if (!remote || remote.archived_at) {
      delete state.vaults[localName];
      process.stdout.write(
        `  [-] removed from state: vault ${JSON.stringify(localName)} (id=${entry.id} is archived or missing)\n`,
      );
      changed++;
      continue;
    }
    if (remote.display_name !== entry.display_name) {
      state.vaults[localName] = {
        ...entry,
        display_name: remote.display_name,
      };
      process.stdout.write(
        `  [~] vault display_name refreshed: ${JSON.stringify(localName)} (${JSON.stringify(entry.display_name)} -> ${JSON.stringify(remote.display_name)})\n`,
      );
      changed++;
    }
  }
  for (const [localName, vault] of vaults) {
    if (state.vaults[localName]) continue;
    const remote = unique(
      'vault',
      localName,
      vault.config.display_name,
      await lookup.vaultByDisplayName(vault.config.display_name, {
        excludeIds: idsTrackedElsewhere(state.vaults, localName),
      }),
    );
    if (remote) {
      state.vaults[localName] = {
        id: remote.id,
        display_name: remote.display_name,
      };
      process.stdout.write(
        `  [+] discovered vault: ${JSON.stringify(localName)} (id=${remote.id})\n`,
      );
      changed++;
    }
  }

  // ----- deployments -----
  for (const [localName, entry] of Object.entries(state.deployments)) {
    const remote = await retrieveDeployment(entry.id);
    if (!remote || remote.archived_at) {
      delete state.deployments[localName];
      process.stdout.write(
        `  [-] removed from state: deployment ${JSON.stringify(localName)} (id=${entry.id} is archived or missing)\n`,
      );
      changed++;
      continue;
    }
    if (remote.name !== entry.name) {
      state.deployments[localName] = { id: entry.id, name: remote.name };
      process.stdout.write(
        `  [~] deployment name refreshed: ${JSON.stringify(localName)} (${JSON.stringify(entry.name)} -> ${JSON.stringify(remote.name)})\n`,
      );
      changed++;
    }
  }
  for (const [localName, { config }] of deployments) {
    if (state.deployments[localName]) continue;
    const remote = unique(
      'deployment',
      localName,
      config.name,
      await lookup.deploymentByName(config.name, {
        excludeIds: idsTrackedElsewhere(state.deployments, localName),
      }),
    );
    if (remote) {
      state.deployments[localName] = { id: remote.id, name: remote.name };
      process.stdout.write(
        `  [+] discovered deployment: ${JSON.stringify(localName)} (id=${remote.id})\n`,
      );
      changed++;
    }
  }

  if (skipped > 0) process.stdout.write(`\n${AMBIGUOUS_REMOTE_HINT}\n`);
  const exitCode = skipped > 0 ? 1 : 0;

  if (changed === 0 && stateExisted) {
    process.stdout.write('No state changes.\n');
    return exitCode;
  }
  await saveState(state);
  if (changed === 0) {
    process.stdout.write(`Initialized empty state: ${path.relative(process.cwd(), STATE_PATH)}\n`);
    return exitCode;
  }
  process.stdout.write(
    `\nState refreshed: ${changed} change(s). Saved to ${path.relative(process.cwd(), STATE_PATH)}\n`,
  );
  return exitCode;
}
