import type { Action, PlanWarning } from './plan.js';
import type { ResolvedConfig } from './resolve.js';

/**
 * Walk every local agent config and find references to resources that are
 * about to be deleted in the current plan. Mutates the matching delete
 * actions in place to attach `warnings: PlanWarning[]`.
 *
 * Why this matters: skill deletion in particular is irreversible on the
 * Anthropic side. If an agent's `skills[]` still points at the deleted
 * skill_id, the agent ends up with a dangling reference that breaks at
 * session creation time. Same logic applies to agent archive for any
 * referrer that lists it in `multiagent.agents[]`.
 *
 * Inspect after-resolution configs so that name-based references
 * (`{ name: ping-skill }`) and id-based references
 * (`{ skill_id: skill_017... }`) are both detected via their canonical id.
 */
export function attachDanglingReferenceWarnings(
  actions: Action[],
  resolutions: Map<string, ResolvedConfig>,
): void {
  const skillIdToLocalName = new Map<string, string>();
  const agentIdToName = new Map<string, string>();

  for (const a of actions) {
    if (a.type === 'skill_delete') skillIdToLocalName.set(a.id, a.localName);
    else if (a.type === 'delete') agentIdToName.set(a.id, a.name);
  }

  if (skillIdToLocalName.size === 0 && agentIdToName.size === 0) return;

  // Build warning lists keyed by the *target* resource (the thing being deleted).
  const skillWarnings = new Map<string, PlanWarning[]>();
  const agentWarnings = new Map<string, PlanWarning[]>();

  for (const [referrerName, resolved] of resolutions) {
    const cfg = resolved.config;

    if (Array.isArray(cfg.skills)) {
      cfg.skills.forEach((entry, idx) => {
        if (!entry || typeof entry !== 'object') return;
        const skillId = (entry as { skill_id?: unknown }).skill_id;
        if (typeof skillId !== 'string') return;
        const targetLocalName = skillIdToLocalName.get(skillId);
        if (!targetLocalName) return;
        addWarning(skillWarnings, targetLocalName, {
          referrer: referrerName,
          fieldPath: `skills[${idx}]`,
        });
      });
    }

    if (cfg.multiagent && Array.isArray(cfg.multiagent.agents)) {
      cfg.multiagent.agents.forEach((entry, idx) => {
        if (!entry || typeof entry !== 'object') return;
        const agentId = (entry as { id?: unknown }).id;
        if (typeof agentId !== 'string') return;
        const targetName = agentIdToName.get(agentId);
        if (!targetName) return;
        addWarning(agentWarnings, targetName, {
          referrer: referrerName,
          fieldPath: `multiagent.agents[${idx}]`,
        });
      });
    }
  }

  for (const a of actions) {
    if (a.type === 'skill_delete') {
      const w = skillWarnings.get(a.localName);
      if (w && w.length > 0) a.warnings = w;
    } else if (a.type === 'delete') {
      const w = agentWarnings.get(a.name);
      if (w && w.length > 0) a.warnings = w;
    }
  }
}

function addWarning(map: Map<string, PlanWarning[]>, key: string, warning: PlanWarning): void {
  const existing = map.get(key);
  if (existing) existing.push(warning);
  else map.set(key, [warning]);
}

export function hasDanglingWarnings(actions: Action[]): boolean {
  return actions.some(
    (a) =>
      (a.type === 'delete' || a.type === 'skill_delete') &&
      a.warnings !== undefined &&
      a.warnings.length > 0,
  );
}
