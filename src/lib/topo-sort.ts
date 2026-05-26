import type { Action } from './plan.js';

/**
 * Reorder actions so that every action's forward dependencies (other actions
 * within the same apply set, referenced by name) appear earlier.
 *
 * - Skills are sorted before any agent that depends on them.
 * - Agents that depend on other agents (sub-agents in `multiagent.agents[]`)
 *   are sorted after their dependencies.
 * - Cycles are detected defensively and surfaced as errors. The platform's
 *   "delegation depth = 1" rule should preclude cycles in practice.
 *
 * Stable: actions without dependency relationships keep their original order.
 */
/**
 * The canonical id used by `topoSortActions` to address one action. Returned
 * in the form `agent:<name>` / `skill:<localName>` / `memstore:<localName>`.
 * Exported so callers (especially tests) can refer to an action by the same
 * identifier the sorter uses internally.
 */
export function actionId(action: Action): string {
  if (
    action.type === 'create' ||
    action.type === 'update' ||
    action.type === 'noop' ||
    action.type === 'delete'
  ) {
    return `agent:${action.name}`;
  }
  if (action.type.startsWith('skill_')) {
    return `skill:${(action as { localName: string }).localName}`;
  }
  return `memstore:${(action as { localName: string }).localName}`;
}

export function topoSortActions(actions: Action[]): Action[] {
  type Node = {
    index: number; // original index, used as tiebreaker for stability
    action: Action;
    /** ids in the form `agent:<name>` or `skill:<localName>` */
    deps: string[];
    id: string;
  };

  const nodes: Node[] = actions.map((action, index) => {
    const id = actionId(action);
    let deps: string[] = [];
    if (action.type === 'create' || action.type === 'update') {
      deps = [
        ...action.forwardAgentDeps.map((n) => `agent:${n}`),
        ...action.forwardSkillDeps.map((n) => `skill:${n}`),
      ];
    }
    return { index, action, deps, id };
  });

  const byId = new Map<string, Node>();
  for (const n of nodes) byId.set(n.id, n);

  // Filter deps to those that actually exist as nodes in the current action
  // set. Dependencies pointing outside the set are already resolved (via
  // state or remote) at this stage and don't need ordering.
  for (const n of nodes) {
    n.deps = n.deps.filter((d) => byId.has(d));
  }

  // Kahn's algorithm. Outgoing edge: `dep -> dependent`. Initial nodes are
  // those with zero deps. To preserve stability, pick the smallest original
  // index among ready nodes each step.
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const n of nodes) {
    incoming.set(n.id, new Set(n.deps));
    if (!outgoing.has(n.id)) outgoing.set(n.id, new Set());
    for (const d of n.deps) {
      if (!outgoing.has(d)) outgoing.set(d, new Set());
      outgoing.get(d)!.add(n.id);
    }
  }

  const ready: Node[] = nodes
    .filter((n) => (incoming.get(n.id)?.size ?? 0) === 0)
    .sort((a, b) => a.index - b.index);

  const sorted: Action[] = [];
  const visited = new Set<string>();

  while (ready.length > 0) {
    const n = ready.shift()!;
    if (visited.has(n.id)) continue;
    visited.add(n.id);
    sorted.push(n.action);

    for (const downstream of outgoing.get(n.id) ?? []) {
      const inc = incoming.get(downstream)!;
      inc.delete(n.id);
      if (inc.size === 0) {
        const node = byId.get(downstream)!;
        ready.push(node);
        ready.sort((a, b) => a.index - b.index);
      }
    }
  }

  if (sorted.length !== nodes.length) {
    const remaining = nodes
      .filter((n) => !visited.has(n.id))
      .map((n) => n.id)
      .join(', ');
    throw new Error(
      `dependency cycle detected among: ${remaining}. ` +
        `Sub-agent / skill references must form a DAG.`,
    );
  }

  return sorted;
}
