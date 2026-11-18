import { loadAllAgentConfigs } from '../lib/agents.js';
import { formatErrorDetail, formatErrorHeadline } from '../lib/ansi.js';
import { loadAllDeploymentConfigs } from '../lib/deployments.js';
import { loadAllEnvironmentConfigs } from '../lib/environments.js';
import { loadAllMemoryStoreConfigs } from '../lib/memory-stores.js';
import { computePlan, filterActionsByTargets, type Action } from '../lib/plan.js';
import { createRemoteLookup } from '../lib/remote-lookup.js';
import {
  buildResolutionContext,
  resolveAgentConfig,
  resolveDeploymentConfig,
  type ResolvedConfig,
  type ResolvedDeploymentConfig,
} from '../lib/resolve.js';
import { loadAllSkillConfigs } from '../lib/skills.js';
import type { State } from '../lib/types.js';
import { loadAllVaultConfigs } from '../lib/vaults.js';
import { reportAmbiguousRemoteName } from './ambiguous-remote.js';

export type PlanPipelineResult =
  | { ok: false; exitCode: number }
  | {
      ok: true;
      /** Actions selected by the targets (all actions when there are none). */
      actions: Action[];
      resolutions: Map<string, ResolvedConfig>;
    };

/**
 * The steps `plan` and `apply` share: load every local manifest, resolve
 * name-based references, compute the plan and narrow it to the targets.
 * Problems are reported on stderr and surface as `{ ok: false, exitCode }`.
 */
export async function runPlanPipeline(
  state: State,
  targets: string[],
): Promise<PlanPipelineResult> {
  const configs = await loadAllAgentConfigs();
  const skills = await loadAllSkillConfigs();
  const memoryStores = await loadAllMemoryStoreConfigs();
  const environments = await loadAllEnvironmentConfigs();
  const vaults = await loadAllVaultConfigs();
  const deployments = await loadAllDeploymentConfigs();

  // Resolve every agent's `multiagent.agents[]` and `skills[]` references
  // (name → id, with forward-dep sentinels for refs that point inside this
  // apply set). Done before computePlan so that diff comparison sees the
  // resolved id form against remote.
  // One lookup is shared by reference resolution and the plan so each remote
  // kind is listed at most once.
  const lookup = createRemoteLookup();
  let allActions: Action[];
  const resolutions = new Map<string, ResolvedConfig>();
  const deploymentResolutions = new Map<string, ResolvedDeploymentConfig>();
  try {
    const ctx = buildResolutionContext({
      state,
      agents: configs,
      skills,
      environments,
      vaults,
      memoryStores,
      lookup,
    });
    const missing: string[] = [];
    const idMismatches: string[] = [];
    for (const [name, { config }] of configs) {
      const r = await resolveAgentConfig(config, ctx);
      resolutions.set(name, r);
      for (const m of r.missingAgentRefs) missing.push(`agent "${name}" -> agent "${m}"`);
      for (const m of r.missingSkillRefs) missing.push(`agent "${name}" -> skill "${m}"`);
      for (const m of r.idMismatches) idMismatches.push(`agent "${name}" -> ${m}`);
    }
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
      return { ok: false, exitCode: 2 };
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
      return { ok: false, exitCode: 2 };
    }

    allActions = await computePlan(
      state,
      configs,
      skills,
      memoryStores,
      environments,
      vaults,
      deployments,
      resolutions,
      deploymentResolutions,
      { targets, lookup },
    );
  } catch (err) {
    reportAmbiguousRemoteName(err);
    return { ok: false, exitCode: 2 };
  }

  let actions = allActions;
  if (targets.length > 0) {
    const { filtered, unmatched } = filterActionsByTargets(allActions, targets);
    if (unmatched.length > 0) {
      process.stderr.write(
        formatErrorHeadline(
          `the following resource names were not found in local YAML, state, or remote: ${unmatched.map((t) => JSON.stringify(t)).join(', ')}`,
        ) + '\n',
      );
      return { ok: false, exitCode: 2 };
    }
    actions = filtered;
    process.stdout.write(`(filter: ${targets.map((t) => JSON.stringify(t)).join(', ')})\n`);
  }

  return { ok: true, actions, resolutions };
}
