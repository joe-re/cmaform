import { printPlan, type PrintPlanOptions } from '../lib/diff-render.js';
import { topoSortActions } from '../lib/topo-sort.js';
import { attachDanglingReferenceWarnings } from '../lib/warnings.js';
import { runPlanPipeline } from './plan-pipeline.js';
import { loadStateForPlanApply } from './state-precondition.js';

export async function cmdPlan(
  targets: string[] = [],
  opts: PrintPlanOptions = {},
): Promise<number> {
  const state = await loadStateForPlanApply('plan');
  if (!state) return 2;
  const planned = await runPlanPipeline(state, targets);
  if (!planned.ok) return planned.exitCode;
  const { resolutions } = planned;
  let actions = planned.actions;

  // Print in apply order — surfaces dependency-induced ordering during
  // bootstrap (skills/sub-agents before their dependents).
  actions = topoSortActions(actions);

  // Flag delete / archive actions whose target is still referenced by
  // another local agent (would create a dangling reference).
  attachDanglingReferenceWarnings(actions, resolutions);

  printPlan(actions, {
    ...opts,
    agentIdToName: buildIdToNameMap(state.agents),
    skillIdToName: buildIdToNameMap(state.skills),
  });
  process.stdout.write(planned.ambiguityWarnings);
  return 0;
}

function buildIdToNameMap(entries: Record<string, { id: string }>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [name, entry] of Object.entries(entries)) m.set(entry.id, name);
  return m;
}
