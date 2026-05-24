import * as readline from 'node:readline/promises';

import {
  archiveAgent,
  createAgent,
  toApplyParams,
  updateAgent,
} from './agents.js';
import {
  archiveEnvironment,
  createEnvironment,
  updateEnvironment,
} from './environments.js';
import {
  archiveMemoryStore,
  createMemoryStore,
  updateMemoryStore,
} from './memory-stores.js';
import type { Action } from './plan.js';
import { substitutePendingIds } from './resolve.js';
import {
  archiveSkill,
  createSkill,
  uploadSkillVersion,
} from './skills.js';
import type { State } from './types.js';

export async function executeActions(
  actions: Action[],
  state: State
): Promise<void> {
  // IDs newly minted during this run. Used to resolve forward dependencies
  // (sentinel placeholders in resolved configs) right before sending each
  // action's apply params to the API.
  const createdAgents = new Map<string, string>();
  const createdSkills = new Map<string, string>();

  // For agents/skills that already existed at plan time but are being
  // updated in this run, their ids are already in resolution context →
  // sentinels in their dependents' configs won't exist for them.
  // We still seed the maps with state so that defensive substitution is a no-op.
  for (const [name, entry] of Object.entries(state.agents)) {
    createdAgents.set(name, entry.id);
  }
  for (const [localName, entry] of Object.entries(state.skills)) {
    createdSkills.set(localName, entry.id);
  }

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
    if (a.type === 'env_noop') {
      state.environments[a.localName] = { id: a.id, name: a.name };
      continue;
    }

    try {
      if (a.type === 'create') {
        process.stdout.write(
          `  [+] creating agent ${JSON.stringify(a.name)}...`
        );
        const finalConfig = substitutePendingIds(
          a.config,
          createdAgents,
          createdSkills
        );
        const created = await createAgent(toApplyParams(finalConfig));
        state.agents[a.name] = { id: created.id, version: created.version };
        createdAgents.set(a.name, created.id);
        process.stdout.write(
          ` ok (id=${created.id}, version=${created.version})\n`
        );
      } else if (a.type === 'update') {
        process.stdout.write(
          `  [~] updating agent ${JSON.stringify(a.name)}...`
        );
        const finalConfig = substitutePendingIds(
          a.config,
          createdAgents,
          createdSkills
        );
        const updated = await updateAgent(
          a.id,
          a.currentVersion,
          toApplyParams(finalConfig)
        );
        state.agents[a.name] = { id: updated.id, version: updated.version };
        createdAgents.set(a.name, updated.id);
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
        createdSkills.set(a.localName, created.id);
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
      } else if (a.type === 'env_create') {
        process.stdout.write(
          `  [+] creating environment ${JSON.stringify(a.localName)}...`
        );
        const created = await createEnvironment(a.config);
        state.environments[a.localName] = { id: created.id, name: created.name };
        process.stdout.write(` ok (id=${created.id})\n`);
      } else if (a.type === 'env_update') {
        process.stdout.write(
          `  [~] updating environment ${JSON.stringify(a.localName)}...`
        );
        const updated = await updateEnvironment(a.id, a.config, a.remote);
        state.environments[a.localName] = { id: updated.id, name: updated.name };
        process.stdout.write(` ok\n`);
      } else if (a.type === 'env_archive') {
        process.stdout.write(
          `  [-] archiving environment ${JSON.stringify(a.localName)}...`
        );
        await archiveEnvironment(a.id);
        delete state.environments[a.localName];
        process.stdout.write(` ok\n`);
      }
    } catch (err) {
      process.stdout.write(` failed\n`);
      throw err;
    }
  }
}

export async function confirm(message: string): Promise<boolean> {
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
