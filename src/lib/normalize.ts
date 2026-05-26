/**
 * Normalize agent config fields before deep-equal comparison.
 *
 * The Anthropic API "fills in" several values when retrieving an agent that
 * the local YAML may omit. Without normalization those differences would
 * appear as permanent diffs in `cmaform plan` even immediately after a
 * successful `apply`.
 *
 * Known cases handled here:
 *
 * 1. Empty arrays vs `undefined`. Local YAML often omits e.g. `mcp_servers`
 *    entirely while the in-memory config sets it to `[]`. The remote returns
 *    it as undefined. They are treated as equivalent.
 *
 * 2. `tools[].configs[].permission_policy` / `enabled`. When an entry omits
 *    these, the API persists the toolset's `default_config` value and the
 *    retrieve response always includes them. We fill them in on both sides
 *    before comparison so the local representation matches.
 *
 * 3. `multiagent.agents[].version`. When local omits `version`, the user is
 *    asking for "latest". The remote returns the resolved numeric version.
 *    We pair entries by id and copy the remote version into the local entry
 *    when local omits it.
 *
 * 4. `skills[].version`. Same shape as (3): pair by `skill_id`, copy remote's
 *    value into local when local omits.
 *
 * All normalizers are pure and idempotent.
 */

function normalizeArrayField(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v) && v.length === 0) return undefined;
  return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normalizeObjectField(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (isPlainObject(v) && Object.keys(v).length === 0) return undefined;
  return v;
}

/**
 * For each toolset entry that has `default_config` + `configs[]`, fill any
 * fields missing in a `configs[]` entry with the corresponding value from
 * `default_config`. This mirrors what the server does at write time.
 */
function normalizeTools(tools: unknown): unknown {
  const normalized = normalizeArrayField(tools);
  if (!Array.isArray(normalized)) return normalized;

  return normalized.map((tool) => {
    if (!isPlainObject(tool)) return tool;
    const defaultConfig = tool.default_config;
    const configs = tool.configs;

    if (!isPlainObject(defaultConfig) || !Array.isArray(configs)) {
      // No default_config to inherit from, or no configs array — still
      // normalize an empty configs array to undefined for consistency.
      const normalizedConfigs = normalizeArrayField(configs);
      if (normalizedConfigs === configs) return tool;
      return { ...tool, configs: normalizedConfigs };
    }

    const filledConfigs = configs.map((cfg) => {
      if (!isPlainObject(cfg)) return cfg;
      const out: Record<string, unknown> = { ...cfg };
      for (const [k, v] of Object.entries(defaultConfig)) {
        if (out[k] === undefined) out[k] = v;
      }
      return out;
    });

    return {
      ...tool,
      configs: normalizeArrayField(filledConfigs),
    };
  });
}

/**
 * Pair multiagent.agents[] entries by id and fill local-omitted `version`
 * with the remote-side value (= "latest" resolution).
 */
function normalizeMultiagent(local: unknown, remote: unknown): [unknown, unknown] {
  if (!isPlainObject(local) || !isPlainObject(remote)) {
    return [local, remote];
  }
  if (!Array.isArray(local.agents) || !Array.isArray(remote.agents)) {
    return [local, remote];
  }

  const remoteById = new Map<string, Record<string, unknown>>();
  for (const entry of remote.agents) {
    if (isPlainObject(entry) && typeof entry.id === 'string') {
      remoteById.set(entry.id, entry);
    }
  }

  const filledLocalAgents = local.agents.map((entry) => {
    if (!isPlainObject(entry)) return entry;
    if (typeof entry.id !== 'string') return entry;
    if (entry.version !== undefined) return entry;
    const rEntry = remoteById.get(entry.id);
    if (!rEntry || rEntry.version === undefined) return entry;
    return { ...entry, version: rEntry.version };
  });

  return [{ ...local, agents: filledLocalAgents }, remote];
}

/**
 * Pair skills[] entries by skill_id and fill local-omitted `version`
 * with the remote-side value (= "latest" resolution). Also normalizes
 * empty array vs undefined.
 */
function normalizeSkills(local: unknown, remote: unknown): [unknown, unknown] {
  if (!Array.isArray(local) || !Array.isArray(remote)) {
    return [normalizeArrayField(local), normalizeArrayField(remote)];
  }

  const remoteById = new Map<string, Record<string, unknown>>();
  for (const entry of remote) {
    if (isPlainObject(entry) && typeof entry.skill_id === 'string') {
      remoteById.set(entry.skill_id, entry);
    }
  }

  const filledLocal = local.map((entry) => {
    if (!isPlainObject(entry)) return entry;
    if (typeof entry.skill_id !== 'string') return entry;
    if (entry.version !== undefined) return entry;
    const rEntry = remoteById.get(entry.skill_id);
    if (!rEntry || rEntry.version === undefined) return entry;
    return { ...entry, version: rEntry.version };
  });

  return [normalizeArrayField(filledLocal), normalizeArrayField(remote)];
}

/**
 * Normalize a (local, remote) value pair for a given AgentConfig field.
 * Returns the normalized pair. Idempotent and side-effect-free.
 */
export function normalizeFieldPair(
  field: string,
  local: unknown,
  remote: unknown,
): [unknown, unknown] {
  switch (field) {
    case 'mcp_servers':
      return [normalizeArrayField(local), normalizeArrayField(remote)];
    case 'tools':
      return [normalizeTools(local), normalizeTools(remote)];
    case 'skills':
      return normalizeSkills(local, remote);
    case 'multiagent':
      return normalizeMultiagent(local, remote);
    case 'metadata':
      return [normalizeObjectField(local), normalizeObjectField(remote)];
    default:
      return [local, remote];
  }
}
