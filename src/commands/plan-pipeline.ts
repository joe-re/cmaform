import { loadAllAgentConfigs } from '../lib/agents.js';
import { formatErrorDetail, formatErrorHeadline } from '../lib/ansi.js';
import { loadAllDeploymentConfigs } from '../lib/deployments.js';
import { loadAllEnvironmentConfigs } from '../lib/environments.js';
import { loadAllMemoryStoreConfigs } from '../lib/memory-stores.js';
import {
  actionKey,
  actionResourceKind,
  actionResourceName,
  classifyUnmatchedTargets,
  computePlan,
  filterActionsByTargets,
  validResourceKinds,
  type Action,
  type PlanAmbiguity,
  type ResourceRef,
} from '../lib/plan.js';
import { createRemoteLookup, type AmbiguousRemoteNameError } from '../lib/remote-lookup.js';
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
import {
  describeAmbiguousName,
  formatAmbiguityWarnings,
  reportAmbiguousRemoteName,
  reportAmbiguousRemoteNames,
  type FatalAmbiguity,
} from './ambiguous-remote.js';

export type PlanPipelineResult =
  | { ok: false; exitCode: number }
  | {
      ok: true;
      /** Actions selected by the targets (all actions when there are none). */
      actions: Action[];
      resolutions: Map<string, ResolvedConfig>;
      /**
       * Ambiguous remote names the targets do not touch, formatted for stdout.
       * Print it after the plan; empty when there are none.
       */
      ambiguityWarnings: string;
    };

/** A name-based reference that matches several remote resources, with its source. */
interface AmbiguousReference {
  referrer: ResourceRef;
  error: AmbiguousRemoteNameError;
}

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
  const ambiguities: PlanAmbiguity[] = [];
  const ambiguousRefs: AmbiguousReference[] = [];
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
      for (const error of r.ambiguousRefs) {
        ambiguousRefs.push({ referrer: { kind: 'agent', name }, error });
      }
    }
    for (const [localName, { config }] of deployments) {
      const r = await resolveDeploymentConfig(config, ctx);
      deploymentResolutions.set(localName, r);
      for (const m of r.missingRefs) missing.push(`deployment "${localName}" -> ${m}`);
      for (const m of r.idMismatches) idMismatches.push(`deployment "${localName}" -> ${m}`);
      for (const error of r.ambiguousRefs) {
        ambiguousRefs.push({ referrer: { kind: 'deployment', name: localName }, error });
      }
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
      { targets, lookup, ambiguities },
    );
  } catch (err) {
    reportAmbiguousRemoteName(err);
    return { ok: false, exitCode: 2 };
  }

  let actions = allActions;
  let selectedAmbiguities: PlanAmbiguity[] = ambiguities;
  let failed = false;
  if (targets.length > 0) {
    const { filtered, unmatched, selectedExtra } = filterActionsByTargets(
      allActions,
      targets,
      ambiguities,
    );
    if (unmatched.length > 0) {
      reportUnmatchedTargets(unmatched, [
        ...allActions.map((a) => ({ kind: actionResourceKind(a), name: actionResourceName(a) })),
        ...ambiguities,
      ]);
      failed = true;
    }
    actions = filtered;
    selectedAmbiguities = selectedExtra;
    if (!failed) {
      process.stdout.write(`(filter: ${targets.map((t) => JSON.stringify(t)).join(', ')})\n`);
    }
  }

  // A reference only matters when the action that holds it is going to run.
  // Out-of-target actions are dropped, so their placeholder never reaches the API.
  const selectedKeys = new Set(actions.map(actionKey));
  const referrerSelected = (r: ResourceRef): boolean =>
    targets.length === 0 || selectedKeys.has(`${r.kind}:${r.name}`);
  const fatalRefs = ambiguousRefs.filter((r) => referrerSelected(r.referrer));
  const ignoredRefs = ambiguousRefs.filter((r) => !referrerSelected(r.referrer));
  const ignoredAmbiguities =
    targets.length === 0 ? [] : ambiguities.filter((a) => !selectedAmbiguities.includes(a));

  const fatal = collectFatalAmbiguities(selectedAmbiguities, fatalRefs);
  if (fatal.length > 0) {
    reportAmbiguousRemoteNames(fatal);
    failed = true;
  }
  if (failed) return { ok: false, exitCode: 2 };

  const warnings = [
    ...ignoredAmbiguities.map(
      (a) =>
        `skipped ${a.kind} ${JSON.stringify(a.name)} (not in the target set): ${describeAmbiguousName(a.error)}`,
    ),
    ...ignoredRefs.map(
      (r) =>
        `${r.referrer.kind} ${JSON.stringify(r.referrer.name)} (not in the target set) references ${r.error.resourceKind} ${JSON.stringify(r.error.resourceName)}: ${describeAmbiguousName(r.error)}`,
    ),
  ];
  const text = formatAmbiguityWarnings(warnings);
  return { ok: true, actions, resolutions, ambiguityWarnings: text ? '\n' + text : '' };
}

/** Group by remote name so a name referenced by several resources is listed once. */
function collectFatalAmbiguities(
  own: PlanAmbiguity[],
  refs: AmbiguousReference[],
): FatalAmbiguity[] {
  const byName = new Map<string, FatalAmbiguity>();
  const entry = (error: AmbiguousRemoteNameError): FatalAmbiguity => {
    const key = `${error.resourceKind}:${error.resourceName}`;
    let e = byName.get(key);
    if (!e) {
      e = { error, referencedBy: [] };
      byName.set(key, e);
    }
    return e;
  };
  for (const a of own) entry(a.error);
  for (const r of refs) {
    const label = `${r.referrer.kind} ${JSON.stringify(r.referrer.name)}`;
    const e = entry(r.error);
    if (!e.referencedBy.includes(label)) e.referencedBy.push(label);
  }
  return [...byName.values()];
}

function reportUnmatchedTargets(unmatched: string[], known: ResourceRef[]): void {
  const { notFound, unknownKind } = classifyUnmatchedTargets(unmatched, known);
  if (notFound.length > 0) {
    process.stderr.write(
      formatErrorHeadline(
        `the following resource names were not found in local YAML, state, or remote: ${notFound.map((t) => JSON.stringify(t)).join(', ')}`,
      ) + '\n',
    );
  }
  const { canonical, aliases } = validResourceKinds();
  for (const u of unknownKind) {
    process.stderr.write(
      formatErrorHeadline(
        `unknown resource kind ${JSON.stringify(u.kind)} in target ${JSON.stringify(u.target)}`,
      ) + '\n',
    );
    process.stderr.write(
      '  ' +
        formatErrorDetail(`valid kinds: ${canonical.join(', ')} (aliases: ${aliases.join(', ')})`) +
        '\n',
    );
    if (u.suggestions.length > 0) {
      const list =
        u.suggestions.length === 1
          ? u.suggestions[0]
          : `${u.suggestions.slice(0, -1).join(', ')} or ${u.suggestions[u.suggestions.length - 1]}`;
      process.stderr.write('  ' + formatErrorDetail(`did you mean ${list}?`) + '\n');
    }
  }
}
