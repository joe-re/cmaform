import { loadAllAgentConfigs } from '../lib/agents.js';
import { printPlan } from '../lib/diff-render.js';
import { loadAllMemoryStoreConfigs } from '../lib/memory-stores.js';
import { computePlan, filterActionsByTargets } from '../lib/plan.js';
import { loadAllSkillConfigs } from '../lib/skills.js';
import { loadState } from '../lib/state.js';

export async function cmdPlan(targets: string[] = []): Promise<number> {
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
