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
 * 5. `model`. The API always returns `model` as an object with `speed`
 *    filled in, and may echo a server-default `effort`. A string model is
 *    expanded to `{ id }`, a missing `speed` becomes `'standard'`, and
 *    remote `effort` is dropped only when local does not set it (an explicit
 *    local `effort` is compared as-is).
 *
 * 6. `tools[].configs[]` echoes. The remote adds `type` (equal to the
 *    entry's `name`) and `url_sources: null`. `null`/`undefined` keys and a
 *    `type` equal to `name` are dropped from both sides, with or without
 *    `default_config`.
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
 * Strip server-echoed noise from a `configs[]` entry: null/undefined keys
 * and a `type` that merely repeats `name`.
 */
function cleanConfigEntry(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  if (typeof out.type === 'string' && out.type === out.name) delete out.type;
  return out;
}

/**
 * For each toolset entry with `configs[]`, drop server-echoed noise (see
 * `cleanConfigEntry`), then fill any fields missing in an entry with the
 * corresponding value from `default_config`. This mirrors what the server
 * does at write time.
 */
function normalizeTools(tools: unknown): unknown {
  const normalized = normalizeArrayField(tools);
  if (!Array.isArray(normalized)) return normalized;

  return normalized.map((tool) => {
    if (!isPlainObject(tool)) return tool;
    if (!Array.isArray(tool.configs)) {
      // `configs: null` is equivalent to an omitted / empty configs array.
      const normalizedConfigs = normalizeArrayField(tool.configs);
      if (normalizedConfigs === tool.configs) return tool;
      return { ...tool, configs: normalizedConfigs };
    }
    const defaultConfig = isPlainObject(tool.default_config) ? tool.default_config : {};

    const filledConfigs = tool.configs.map((cfg) => {
      if (!isPlainObject(cfg)) return cfg;
      const out = cleanConfigEntry(cfg);
      for (const [k, v] of Object.entries(defaultConfig)) {
        if (out[k] === undefined) out[k] = v;
      }
      return out;
    });

    return { ...tool, configs: normalizeArrayField(filledConfigs) };
  });
}

/**
 * Expand a string model to `{ id }` and default `speed` to 'standard'.
 * Non-string, non-object values are returned unchanged.
 */
function normalizeModelShape(model: unknown): unknown {
  const obj = typeof model === 'string' ? { id: model } : model;
  if (!isPlainObject(obj)) return obj;
  return { ...obj, speed: obj.speed ?? 'standard' };
}

function withoutEffort(model: unknown): unknown {
  if (!isPlainObject(model) || !('effort' in model)) return model;
  const { effort: _effort, ...rest } = model;
  return rest;
}

/**
 * Normalize `model` on both sides. Remote `effort` (a server default) is
 * dropped only when local does not specify one.
 */
function normalizeModel(local: unknown, remote: unknown): [unknown, unknown] {
  const l = normalizeModelShape(local);
  const r = normalizeModelShape(remote);
  const localEffort = isPlainObject(l) ? l.effort : undefined;
  if (localEffort !== undefined && localEffort !== null) return [l, r];
  // Local leaves effort to the server: drop it from both sides (local may
  // carry an explicit `effort: null`).
  return [withoutEffort(l), withoutEffort(r)];
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
    case 'model':
      return normalizeModel(local, remote);
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
