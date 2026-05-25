import { findAgentByName } from './agents.js';
import { findSkillByDisplayTitle } from './skills.js';
import type {
  AgentConfig,
  LocalSkill,
  RemoteAgent,
  RemoteSkill,
  State,
} from './types.js';

/**
 * Build-time context for resolving name-based references in agent YAML.
 *
 * Lookup order:
 *   1. cmaform.state.json (`state.agents[name]` / `state.skills[localName]`)
 *   2. Remote (cached after first lookup)
 *   3. Local apply set (agents in local YAML / skills as local directories)
 *      → treated as a "forward dependency": replaced with a sentinel ID and
 *        resolved at apply time after the dependency is actually created.
 *   4. Otherwise: unresolved (surfaced as an error by callers).
 */
export interface ResolutionContext {
  state: State;
  /** Local agent configs keyed by `name` field. */
  localAgents: Map<string, AgentConfig>;
  /** Local skills keyed by local directory name (= state key). */
  localSkills: Map<string, LocalSkill>;
  /** Per-run cache for remote lookups by name / display_title. */
  remoteAgentByName: Map<string, RemoteAgent | null>;
  remoteSkillByTitle: Map<string, RemoteSkill | null>;
}

export function buildResolutionContext(
  state: State,
  localAgents: Map<string, { config: AgentConfig; filePath: string }>,
  localSkills: Map<string, LocalSkill>
): ResolutionContext {
  return {
    state,
    localAgents: new Map([...localAgents].map(([k, v]) => [k, v.config])),
    localSkills,
    remoteAgentByName: new Map(),
    remoteSkillByTitle: new Map(),
  };
}

// ---------------- sentinels ----------------
//
// When a name-based reference points to a resource that is itself in the
// current apply set (i.e. about to be created), we don't know its real ID
// yet. We substitute a sentinel string and replace it just before sending
// apply params to the API. The sentinel uses a prefix that is impossible
// to collide with a real Anthropic ID.

const PENDING_AGENT_ID_PREFIX = '__cmaform_pending_agent__:';
const PENDING_SKILL_ID_PREFIX = '__cmaform_pending_skill__:';

export function pendingAgentSentinel(name: string): string {
  return `${PENDING_AGENT_ID_PREFIX}${name}`;
}

export function pendingSkillSentinel(name: string): string {
  return `${PENDING_SKILL_ID_PREFIX}${name}`;
}

export function extractPendingAgent(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (!v.startsWith(PENDING_AGENT_ID_PREFIX)) return null;
  return v.slice(PENDING_AGENT_ID_PREFIX.length);
}

export function extractPendingSkill(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (!v.startsWith(PENDING_SKILL_ID_PREFIX)) return null;
  return v.slice(PENDING_SKILL_ID_PREFIX.length);
}

// ---------------- single-name resolution ----------------

export type AgentResolution =
  | { kind: 'resolved'; id: string }
  | { kind: 'forward'; name: string; sentinel: string }
  | { kind: 'missing' };

export async function resolveAgentName(
  name: string,
  ctx: ResolutionContext
): Promise<AgentResolution> {
  const tracked = ctx.state.agents[name];
  if (tracked) return { kind: 'resolved', id: tracked.id };

  let remote: RemoteAgent | null;
  if (ctx.remoteAgentByName.has(name)) {
    remote = ctx.remoteAgentByName.get(name)!;
  } else {
    remote = await findAgentByName(name);
    ctx.remoteAgentByName.set(name, remote);
  }
  if (remote) return { kind: 'resolved', id: remote.id };

  if (ctx.localAgents.has(name)) {
    return { kind: 'forward', name, sentinel: pendingAgentSentinel(name) };
  }

  return { kind: 'missing' };
}

export type SkillResolution =
  | { kind: 'resolved'; id: string }
  | { kind: 'forward'; name: string; sentinel: string }
  | { kind: 'missing' };

export async function resolveSkillName(
  name: string,
  ctx: ResolutionContext
): Promise<SkillResolution> {
  const tracked = ctx.state.skills[name];
  if (tracked) return { kind: 'resolved', id: tracked.id };

  let remote: RemoteSkill | null;
  if (ctx.remoteSkillByTitle.has(name)) {
    remote = ctx.remoteSkillByTitle.get(name)!;
  } else {
    remote = await findSkillByDisplayTitle(name);
    ctx.remoteSkillByTitle.set(name, remote);
  }
  if (remote) return { kind: 'resolved', id: remote.id };

  if (ctx.localSkills.has(name)) {
    return { kind: 'forward', name, sentinel: pendingSkillSentinel(name) };
  }

  return { kind: 'missing' };
}

// ---------------- config transformation ----------------

export interface ResolvedConfig {
  config: AgentConfig;
  /** Names of agents that must be created before this one in the apply set. */
  forwardAgentDeps: string[];
  /** Local skill names that must be created before this one. */
  forwardSkillDeps: string[];
  /** Name-based agent refs that could not be resolved anywhere — fatal. */
  missingAgentRefs: string[];
  /** Name-based skill refs that could not be resolved anywhere — fatal. */
  missingSkillRefs: string[];
}

/**
 * Walk an AgentConfig and replace every name-based reference in
 * `multiagent.agents[]` and `skills[]` with the resolved form expected
 * by the Anthropic API. Existing `id` / `skill_id` references are kept
 * as-is. Returns the resolved config plus dependency metadata.
 */
export async function resolveAgentConfig(
  config: AgentConfig,
  ctx: ResolutionContext
): Promise<ResolvedConfig> {
  const forwardAgentDeps: string[] = [];
  const forwardSkillDeps: string[] = [];
  const missingAgentRefs: string[] = [];
  const missingSkillRefs: string[] = [];

  const resolved: AgentConfig = { ...config };

  // ----- multiagent.agents[] -----
  if (resolved.multiagent && Array.isArray(resolved.multiagent.agents)) {
    const newAgents: unknown[] = [];
    for (const entry of resolved.multiagent.agents) {
      const e = entry as unknown as Record<string, unknown> | null;
      if (
        e &&
        typeof e === 'object' &&
        e.type === 'agent' &&
        typeof e.id !== 'string' &&
        typeof e.name === 'string'
      ) {
        const res = await resolveAgentName(e.name, ctx);
        if (res.kind === 'resolved') {
          newAgents.push({
            type: 'agent',
            id: res.id,
            ...(e.version !== undefined ? { version: e.version } : {}),
          });
        } else if (res.kind === 'forward') {
          forwardAgentDeps.push(e.name);
          newAgents.push({
            type: 'agent',
            id: res.sentinel,
            ...(e.version !== undefined ? { version: e.version } : {}),
          });
        } else {
          missingAgentRefs.push(e.name);
          newAgents.push(entry);
        }
      } else {
        newAgents.push(entry);
      }
    }
    resolved.multiagent = {
      ...resolved.multiagent,
      agents: newAgents as typeof resolved.multiagent.agents,
    };
  }

  // ----- skills[] -----
  if (Array.isArray(resolved.skills)) {
    const newSkills: unknown[] = [];
    for (const entry of resolved.skills) {
      const e = entry as unknown as Record<string, unknown> | null;
      if (
        e &&
        typeof e === 'object' &&
        e.type === 'custom' &&
        typeof e.skill_id !== 'string' &&
        typeof e.name === 'string'
      ) {
        const res = await resolveSkillName(e.name, ctx);
        if (res.kind === 'resolved') {
          newSkills.push({
            type: 'custom',
            skill_id: res.id,
            ...(e.version !== undefined ? { version: e.version } : {}),
          });
        } else if (res.kind === 'forward') {
          forwardSkillDeps.push(e.name);
          newSkills.push({
            type: 'custom',
            skill_id: res.sentinel,
            ...(e.version !== undefined ? { version: e.version } : {}),
          });
        } else {
          missingSkillRefs.push(e.name);
          newSkills.push(entry);
        }
      } else {
        newSkills.push(entry);
      }
    }
    resolved.skills = newSkills;
  }

  return {
    config: resolved,
    forwardAgentDeps,
    forwardSkillDeps,
    missingAgentRefs,
    missingSkillRefs,
  };
}

// ---------------- sentinel substitution at apply time ----------------

/**
 * After a forward dependency is actually created, walk the resolved config
 * one more time and replace any sentinels with the freshly-issued IDs.
 * Called immediately before `createAgent` / `updateAgent`.
 */
export function substitutePendingIds(
  config: AgentConfig,
  createdAgents: Map<string, string>,
  createdSkills: Map<string, string>
): AgentConfig {
  const out: AgentConfig = { ...config };

  if (out.multiagent && Array.isArray(out.multiagent.agents)) {
    out.multiagent = {
      ...out.multiagent,
      agents: out.multiagent.agents.map(entry => {
        const e = entry as unknown as Record<string, unknown> | null;
        if (e && typeof e === 'object' && e.type === 'agent') {
          const pending = extractPendingAgent(e.id);
          if (pending) {
            const resolvedId = createdAgents.get(pending);
            if (!resolvedId) {
              throw new Error(
                `internal: agent "${pending}" referenced but not yet created`
              );
            }
            return { ...e, id: resolvedId };
          }
        }
        return entry;
      }) as typeof out.multiagent.agents,
    };
  }

  if (Array.isArray(out.skills)) {
    out.skills = out.skills.map(entry => {
      const e = entry as unknown as Record<string, unknown> | null;
      if (e && typeof e === 'object' && e.type === 'custom') {
        const pending = extractPendingSkill(e.skill_id);
        if (pending) {
          const resolvedId = createdSkills.get(pending);
          if (!resolvedId) {
            throw new Error(
              `internal: skill "${pending}" referenced but not yet created`
            );
          }
          return { ...e, skill_id: resolvedId };
        }
      }
      return entry;
    });
  }

  return out;
}

// ---------------- pretty rendering for diff display ----------------

/**
 * Replace sentinels with a human-readable placeholder for diff display.
 * The actual diff comparison still uses the sentinel string so that the
 * field is correctly detected as "changed".
 */
export function prettifySentinelsForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(v => prettifySentinelsForDisplay(v));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = prettifySentinelsForDisplay(v);
    }
    return out;
  }
  if (typeof value === 'string') {
    const a = extractPendingAgent(value);
    if (a) return `<pending: agent "${a}">`;
    const s = extractPendingSkill(value);
    if (s) return `<pending: skill "${s}">`;
  }
  return value;
}

// ---------------- writeback: id → name ----------------

/**
 * When writing a remote agent's `multiagent.agents` / `skills` back to YAML,
 * prefer the human-friendly name form for any reference whose ID is tracked
 * in state. Falls back to the original id form for unknown IDs.
 */
export function rewriteAgentRefsToNameForm(
  agents: unknown[] | undefined,
  state: State
): unknown[] | undefined {
  if (!Array.isArray(agents)) return agents;
  const idToName = new Map<string, string>();
  for (const [name, entry] of Object.entries(state.agents)) {
    idToName.set(entry.id, name);
  }
  return agents.map(entry => {
    const e = entry as Record<string, unknown> | null;
    if (
      e &&
      typeof e === 'object' &&
      e.type === 'agent' &&
      typeof e.id === 'string'
    ) {
      const name = idToName.get(e.id);
      if (name) {
        const out: Record<string, unknown> = { type: 'agent', name };
        if (e.version !== undefined) out.version = e.version;
        return out;
      }
    }
    return entry;
  });
}

export function rewriteSkillRefsToNameForm(
  skills: unknown[] | undefined,
  state: State
): unknown[] | undefined {
  if (!Array.isArray(skills)) return skills;
  const idToLocalName = new Map<string, string>();
  for (const [localName, entry] of Object.entries(state.skills)) {
    idToLocalName.set(entry.id, localName);
  }
  return skills.map(entry => {
    const e = entry as Record<string, unknown> | null;
    if (
      e &&
      typeof e === 'object' &&
      e.type === 'custom' &&
      typeof e.skill_id === 'string'
    ) {
      const name = idToLocalName.get(e.skill_id);
      if (name) {
        const out: Record<string, unknown> = { type: 'custom', name };
        if (e.version !== undefined) out.version = e.version;
        return out;
      }
    }
    return entry;
  });
}
