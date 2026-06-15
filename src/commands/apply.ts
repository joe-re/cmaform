import path from 'node:path';

import { loadAllAgentConfigs } from '../lib/agents.js';
import { colorizeMany, formatErrorDetail, formatErrorHeadline } from '../lib/ansi.js';
import { confirm, executeActions } from '../lib/apply.js';
import { STATE_PATH } from '../lib/config.js';
import { loadAllDeploymentConfigs } from '../lib/deployments.js';
import { printPlan, type PrintPlanOptions } from '../lib/diff-render.js';
import { loadAllEnvironmentConfigs } from '../lib/environments.js';
import { loadAllMemoryStoreConfigs } from '../lib/memory-stores.js';
import { computePlan, filterActionsByTargets, hasChanges } from '../lib/plan.js';
import { attachDanglingReferenceWarnings, hasDanglingWarnings } from '../lib/warnings.js';
import {
  buildResolutionContext,
  resolveAgentConfig,
  resolveDeploymentConfig,
  type ResolvedConfig,
  type ResolvedDeploymentConfig,
} from '../lib/resolve.js';
import { loadAllSkillConfigs } from '../lib/skills.js';
import { saveState } from '../lib/state.js';
import { topoSortActions } from '../lib/topo-sort.js';
import { loadAllVaultConfigs } from '../lib/vaults.js';
import { loadStateForPlanApply } from './state-precondition.js';

export async function cmdApply(
  autoApprove: boolean,
  targets: string[] = [],
  opts: PrintPlanOptions = {},
): Promise<number> {
  const state = await loadStateForPlanApply('apply');
  if (!state) return 2;
  const configs = await loadAllAgentConfigs();
  const skills = await loadAllSkillConfigs();
  const memoryStores = await loadAllMemoryStoreConfigs();
  const environments = await loadAllEnvironmentConfigs();
  const vaults = await loadAllVaultConfigs();
  const deployments = await loadAllDeploymentConfigs();

  const ctx = buildResolutionContext(state, configs, skills, environments.keys(), vaults.keys());
  const resolutions = new Map<string, ResolvedConfig>();
  const missing: string[] = [];
  const idMismatches: string[] = [];
  for (const [name, { config }] of configs) {
    const r = await resolveAgentConfig(config, ctx);
    resolutions.set(name, r);
    for (const m of r.missingAgentRefs) missing.push(`agent "${name}" -> agent "${m}"`);
    for (const m of r.missingSkillRefs) missing.push(`agent "${name}" -> skill "${m}"`);
    for (const m of r.idMismatches) idMismatches.push(`agent "${name}" -> ${m}`);
  }
  const deploymentResolutions = new Map<string, ResolvedDeploymentConfig>();
  for (const [localName, { config }] of deployments) {
    const r = await resolveDeploymentConfig(config, ctx);
    deploymentResolutions.set(localName, r);
    for (const m of r.missingRefs) missing.push(`deployment "${localName}" -> ${m}`);
    for (const m of r.idMismatches) idMismatches.push(`deployment "${localName}" -> ${m}`);
  }
  if (missing.length > 0) {
    process.stderr.write(
      formatErrorHeadline(
        'the following name-based references could not be resolved (not in state, remote, or local config):',
      ) + '\n',
    );
    for (const m of missing) {
      process.stderr.write('  ' + formatErrorDetail(m) + '\n');
    }
    return 2;
  }
  if (idMismatches.length > 0) {
    process.stderr.write(
      formatErrorHeadline(
        'pinned IDs in local YAML do not match the resolved IDs (either the name was reassigned or the pinned ID is stale):',
      ) + '\n',
    );
    for (const m of idMismatches) {
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
    vaults,
    deployments,
    resolutions,
    deploymentResolutions,
    { targets },
  );

  let actions = allActions;
  if (targets.length > 0) {
    const { filtered, unmatched } = filterActionsByTargets(allActions, targets);
    if (unmatched.length > 0) {
      process.stderr.write(
        formatErrorHeadline(
          `the following resource names were not found in local YAML, state, or remote: ${unmatched.map((t) => JSON.stringify(t)).join(', ')}`,
        ) + '\n',
      );
      return 2;
    }
    actions = filtered;
    process.stdout.write(`(filter: ${targets.map((t) => JSON.stringify(t)).join(', ')})\n`);

    // Target filtering can drop forward dependencies. Surface them as a
    // hard error so the user adds them to the target list explicitly
    // (rather than failing late inside executeActions).
    const inTarget = new Set<string>();
    for (const a of actions) {
      if (a.type === 'create' || a.type === 'update' || a.type === 'noop' || a.type === 'delete') {
        inTarget.add(`agent:${a.name}`);
      } else if (a.type.startsWith('skill_')) {
        inTarget.add(`skill:${(a as { localName: string }).localName}`);
      } else if (a.type.startsWith('env_')) {
        inTarget.add(`environment:${(a as { localName: string }).localName}`);
      } else if (a.type.startsWith('vault_')) {
        inTarget.add(`vault:${(a as { localName: string }).localName}`);
      } else if (a.type.startsWith('deploy_')) {
        inTarget.add(`deployment:${(a as { localName: string }).localName}`);
      }
    }
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
