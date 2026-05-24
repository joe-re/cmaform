import path from 'node:path';

import { loadAllAgentConfigs } from '../lib/agents.js';
import { confirm, executeActions } from '../lib/apply.js';
import { STATE_PATH } from '../lib/config.js';
import { printPlan } from '../lib/diff-render.js';
import { loadAllMemoryStoreConfigs } from '../lib/memory-stores.js';
import {
  computePlan,
  filterActionsByTargets,
  hasChanges,
} from '../lib/plan.js';
import { loadAllSkillConfigs } from '../lib/skills.js';
import { loadState, saveState } from '../lib/state.js';

export async function cmdApply(
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
