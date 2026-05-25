import path from 'node:path';

import {
  retrieveAgent,
  writeAgentYamlFromRemote,
} from '../lib/agents.js';
import { CMAFORM_DIR, STATE_PATH } from '../lib/config.js';
import {
  listEnvironments,
  loadAllEnvironmentConfigs,
  retrieveEnvironment,
  writeEnvironmentManifestFromRemote,
} from '../lib/environments.js';
import {
  listMemoryStores,
  loadAllMemoryStoreConfigs,
  retrieveMemoryStore,
  writeMemoryStoreManifestFromRemote,
} from '../lib/memory-stores.js';
import {
  listVaults,
  loadAllVaultConfigs,
  retrieveVault,
  writeVaultManifestFromRemote,
} from '../lib/vaults.js';
import {
  findSkillByDisplayTitle,
  loadAllSkillConfigs,
  retrieveSkill,
} from '../lib/skills.js';
import { loadState, saveState } from '../lib/state.js';

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
export async function cmdSync(): Promise<number> {
  const state = await loadState();
  const skills = await loadAllSkillConfigs();
  const memoryStores = await loadAllMemoryStoreConfigs();
  const environments = await loadAllEnvironmentConfigs();
  const vaults = await loadAllVaultConfigs();

  const hasAnything =
    Object.keys(state.agents).length > 0 ||
    Object.keys(state.skills).length > 0 ||
    Object.keys(state.memory_stores).length > 0 ||
    Object.keys(state.environments).length > 0 ||
    Object.keys(state.vaults).length > 0 ||
    skills.size > 0 ||
    memoryStores.size > 0 ||
    environments.size > 0 ||
    vaults.size > 0;

  if (!hasAnything) {
    process.stdout.write(
      'Both state and local are empty. Run `cmaform pull <agent_id|skill_id|memstore_id|env_id|vlt_id>` to import.\n'
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
  let envWritten = 0;
  let envSkipped = 0;
  let envDiscovered = 0;
  let vaultWritten = 0;
  let vaultSkipped = 0;
  let vaultDiscovered = 0;
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

    const filePath = await writeAgentYamlFromRemote(remote, state);
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

  // ----- environments -----
  for (const localName of Object.keys(state.environments)) {
    const entry = state.environments[localName];
    const remote = await retrieveEnvironment(entry.id);
    if (!remote || remote.archived_at) {
      process.stdout.write(
        `  [!] skip environment ${JSON.stringify(localName)}: remote is archived or missing (id=${entry.id})\n`
      );
      envSkipped++;
      continue;
    }
    const manifestPath = await writeEnvironmentManifestFromRemote(
      remote,
      localName
    );
    process.stdout.write(
      `  [+] wrote ${path.relative(CMAFORM_DIR, manifestPath)} (id=${remote.id})\n`
    );
    envWritten++;
    if (entry.name !== remote.name) {
      state.environments[localName] = { id: entry.id, name: remote.name };
      stateChanged = true;
    }
  }
  for (const [localName, { config }] of environments) {
    if (state.environments[localName]) continue;
    const remotes = await listEnvironments();
    const remote = remotes.find(r => r.name === config.name && !r.archived_at);
    if (remote) {
      state.environments[localName] = { id: remote.id, name: remote.name };
      process.stdout.write(
        `  [+] discovered environment: ${JSON.stringify(localName)} (id=${remote.id})\n`
      );
      envDiscovered++;
      stateChanged = true;
    } else {
      process.stdout.write(
        `  [?] not found on remote: environment ${JSON.stringify(localName)} (name=${JSON.stringify(config.name)})\n`
      );
    }
  }

  // ----- vaults (manifest only — cmaform does not manage credentials yet) -----
  for (const localName of Object.keys(state.vaults)) {
    const entry = state.vaults[localName];
    const remote = await retrieveVault(entry.id);
    if (!remote || remote.archived_at) {
      process.stdout.write(
        `  [!] skip vault ${JSON.stringify(localName)}: remote is archived or missing (id=${entry.id})\n`
      );
      vaultSkipped++;
      continue;
    }
    const manifestPath = await writeVaultManifestFromRemote(remote, localName);
    process.stdout.write(
      `  [+] wrote ${path.relative(CMAFORM_DIR, manifestPath)} (id=${remote.id})\n`
    );
    vaultWritten++;
    if (entry.display_name !== remote.display_name) {
      state.vaults[localName] = {
        ...entry,
        display_name: remote.display_name,
      };
      stateChanged = true;
    }
  }
  for (const [localName, vault] of vaults) {
    if (state.vaults[localName]) continue;
    const remotes = await listVaults();
    const remote = remotes.find(
      r => r.display_name === vault.config.display_name && !r.archived_at
    );
    if (remote) {
      state.vaults[localName] = {
        id: remote.id,
        display_name: remote.display_name,
      };
      process.stdout.write(
        `  [+] discovered vault: ${JSON.stringify(localName)} (id=${remote.id})\n`
      );
      vaultDiscovered++;
      stateChanged = true;
    } else {
      process.stdout.write(
        `  [?] not found on remote: vault ${JSON.stringify(localName)} (display_name=${JSON.stringify(vault.config.display_name)})\n`
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
      `  environments:  ${envWritten} written, ${envDiscovered} discovered, ${envSkipped} skipped\n` +
      `  vaults:        ${vaultWritten} written, ${vaultDiscovered} discovered, ${vaultSkipped} skipped\n` +
      `  (skill content files such as SKILL.md cannot be fetched from the API and are not regenerated)\n`
  );
  return 0;
}
