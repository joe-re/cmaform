import path from 'node:path';

import { colorizeMany, formatErrorDetail, formatErrorHeadline } from '../lib/ansi.js';
import { confirm, executeActions } from '../lib/apply.js';
import { STATE_PATH } from '../lib/config.js';
import { printPlan, type PrintPlanOptions } from '../lib/diff-render.js';
import { actionKey, hasChanges } from '../lib/plan.js';
import { saveState } from '../lib/state.js';
import { topoSortActions } from '../lib/topo-sort.js';
import { attachDanglingReferenceWarnings, hasDanglingWarnings } from '../lib/warnings.js';
import { runPlanPipeline } from './plan-pipeline.js';
import { loadStateForPlanApply } from './state-precondition.js';

export async function cmdApply(
  autoApprove: boolean,
  targets: string[] = [],
  opts: PrintPlanOptions = {},
): Promise<number> {
  const state = await loadStateForPlanApply('apply');
  if (!state) return 2;
  const planned = await runPlanPipeline(state, targets);
  if (!planned.ok) return planned.exitCode;
  const { resolutions } = planned;
  let actions = planned.actions;
  if (targets.length > 0) {
    // Target filtering can drop forward dependencies. Surface them as a
    // hard error so the user adds them to the target list explicitly
    // (rather than failing late inside executeActions).
    const inTarget = new Set(actions.map(actionKey));
    const droppedDeps: string[] = [];
    for (const a of actions) {
      if (a.type === 'create' || a.type === 'update') {
        for (const dep of a.forwardAgentDeps) {
          if (!inTarget.has(`agent:${dep}`)) {
            droppedDeps.push(`agent "${a.name}" -> agent "${dep}"`);
          }
        }
        for (const dep of a.forwardSkillDeps) {
          if (!inTarget.has(`skill:${dep}`)) {
            droppedDeps.push(`agent "${a.name}" -> skill "${dep}"`);
          }
        }
      } else if (a.type === 'deploy_create' || a.type === 'deploy_update') {
        for (const dep of a.forwardAgentDeps) {
          if (!inTarget.has(`agent:${dep}`)) {
            droppedDeps.push(`deployment "${a.localName}" -> agent "${dep}"`);
          }
        }
        for (const dep of a.forwardEnvDeps) {
          if (!inTarget.has(`environment:${dep}`)) {
            droppedDeps.push(`deployment "${a.localName}" -> environment "${dep}"`);
          }
        }
        for (const dep of a.forwardVaultDeps) {
          if (!inTarget.has(`vault:${dep}`)) {
            droppedDeps.push(`deployment "${a.localName}" -> vault "${dep}"`);
          }
        }
        for (const dep of a.forwardMemoryStoreDeps) {
          if (!inTarget.has(`memory_store:${dep}`)) {
            droppedDeps.push(`deployment "${a.localName}" -> memory store "${dep}"`);
          }
        }
      }
    }
    if (droppedDeps.length > 0) {
      process.stderr.write(
        formatErrorHeadline(
          'target set is missing forward dependencies (they will be created in this run):',
        ) + '\n',
      );
      for (const d of droppedDeps) {
        process.stderr.write('  ' + formatErrorDetail(d) + '\n');
      }
      process.stderr.write(
        formatErrorDetail('Add the dependency to your target list, or omit the target filter.') +
          '\n',
      );
      return 2;
    }
  }

  actions = topoSortActions(actions);
  attachDanglingReferenceWarnings(actions, resolutions);
  const agentIdToName = new Map<string, string>();
  for (const [name, e] of Object.entries(state.agents)) agentIdToName.set(e.id, name);
  const skillIdToName = new Map<string, string>();
  for (const [localName, e] of Object.entries(state.skills)) skillIdToName.set(e.id, localName);
  printPlan(actions, { ...opts, agentIdToName, skillIdToName });

  if (!hasChanges(actions)) {
    // No remote operations, but refresh stale state with noop id/version values.
    let stateChanged = false;
    for (const a of actions) {
      if (a.type === 'noop') {
        const existing = state.agents[a.name];
        if (!existing || existing.id !== a.id || existing.version !== a.version) {
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
      } else if (a.type === 'env_noop') {
        const existing = state.environments[a.localName];
        if (!existing || existing.id !== a.id || existing.name !== a.name) {
          state.environments[a.localName] = { id: a.id, name: a.name };
          stateChanged = true;
        }
      } else if (a.type === 'vault_noop') {
        const existing = state.vaults[a.localName];
        if (!existing || existing.id !== a.id || existing.display_name !== a.display_name) {
          state.vaults[a.localName] = {
            id: a.id,
            display_name: a.display_name,
          };
          stateChanged = true;
        }
      } else if (a.type === 'deploy_noop') {
        const existing = state.deployments[a.localName];
        if (!existing || existing.id !== a.id || existing.name !== a.name) {
          state.deployments[a.localName] = { id: a.id, name: a.name };
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
    const message = hasDanglingWarnings(actions)
      ? '\n' +
        colorizeMany(['bold', 'yellow'], 'WARN:') +
        ' one or more deletes / archives leave dangling references.\nProceed with these dangling deletes?'
      : '\nDo you want to perform these actions?';
    const ok = await confirm(message);
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
    `\nApply complete. State saved: ${path.relative(process.cwd(), STATE_PATH)}\n`,
  );
  return 0;
}
