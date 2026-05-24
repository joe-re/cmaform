import { loadAllAgentConfigs } from '../lib/agents.js';
import {
  formatErrorDetail,
  formatErrorHeadline,
} from '../lib/ansi.js';
import { printPlan, type PrintPlanOptions } from '../lib/diff-render.js';
import { loadAllEnvironmentConfigs } from '../lib/environments.js';
import { loadAllMemoryStoreConfigs } from '../lib/memory-stores.js';
import { computePlan, filterActionsByTargets } from '../lib/plan.js';
import { attachDanglingReferenceWarnings } from '../lib/warnings.js';
import {
  buildResolutionContext,
  resolveAgentConfig,
  type ResolvedConfig,
} from '../lib/resolve.js';
import { loadAllSkillConfigs } from '../lib/skills.js';
import { loadState } from '../lib/state.js';
import { topoSortActions } from '../lib/topo-sort.js';

export async function cmdPlan(
  targets: string[] = [],
  opts: PrintPlanOptions = {}
): Promise<number> {
  const state = await loadState();
  const configs = await loadAllAgentConfigs();
  const skills = await loadAllSkillConfigs();
  const memoryStores = await loadAllMemoryStoreConfigs();
  const environments = await loadAllEnvironmentConfigs();

  // Resolve every agent's `multiagent.agents[]` and `skills[]` references
  // (name → id, with forward-dep sentinels for refs that point inside this
  // apply set). Done before computePlan so that diff comparison sees the
  // resolved id form against remote.
  const ctx = buildResolutionContext(state, configs, skills);
  const resolutions = new Map<string, ResolvedConfig>();
  const missing: string[] = [];
  for (const [name, { config }] of configs) {
    const r = await resolveAgentConfig(config, ctx);
    resolutions.set(name, r);
    for (const m of r.missingAgentRefs)
      missing.push(`agent "${name}" -> agent "${m}"`);
    for (const m of r.missingSkillRefs)
      missing.push(`agent "${name}" -> skill "${m}"`);
  }
  if (missing.length > 0) {
    process.stderr.write(
      formatErrorHeadline(
        'the following name-based references could not be resolved (not in state, remote, or local config):'
      ) + '\n'
    );
    for (const m of missing) {
      process.stderr.write('  ' + formatErrorDetail(m) + '\n');
    }
    return 2;
  }

  const allActions = await computePlan(
    state,
    configs,
    skills,
    memoryStores,
    environments,
    resolutions
  );

  let actions = allActions;
  if (targets.length > 0) {
    const { filtered, unmatched } = filterActionsByTargets(allActions, targets);
    if (unmatched.length > 0) {
      process.stderr.write(
        formatErrorHeadline(
          `the following resource names were not found in local YAML, state, or remote: ${unmatched.map(t => JSON.stringify(t)).join(', ')}`
        ) + '\n'
      );
      return 2;
    }
    actions = filtered;
    process.stdout.write(
      `(filter: ${targets.map(t => JSON.stringify(t)).join(', ')})\n`
    );
  }

  // Print in apply order — surfaces dependency-induced ordering during
  // bootstrap (skills/sub-agents before their dependents).
  actions = topoSortActions(actions);

  // Flag delete / archive actions whose target is still referenced by
  // another local agent (would create a dangling reference).
  attachDanglingReferenceWarnings(actions, resolutions);

  printPlan(actions, opts);
  return 0;
}
