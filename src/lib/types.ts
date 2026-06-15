export interface MultiagentRosterEntry {
  type: 'agent' | 'self';
  id?: string;
  name?: string;
  version?: number | 'latest';
}

export interface MultiagentConfig {
  type: 'coordinator';
  agents: MultiagentRosterEntry[];
}

export interface AgentConfig {
  name: string;
  model?: unknown;
  description?: string | null;
  system?: string | null;
  tools?: unknown[];
  mcp_servers?: unknown[];
  skills?: unknown[];
  multiagent?: MultiagentConfig;
  metadata?: Record<string, unknown>;
}

export interface RemoteAgent {
  id: string;
  version: number;
  name: string;
  archived_at: string | null;
  model?: unknown;
  description?: string | null;
  system?: string | null;
  tools?: unknown[];
  mcp_servers?: unknown[];
  skills?: unknown[];
  multiagent?: MultiagentConfig;
  metadata?: Record<string, unknown>;
}

export interface SkillStateEntry {
  id: string;
  version: string; // epoch timestamp string
  hash: string; // SHA256 hash of all local files in the skill directory
  display_title: string;
}

export interface MemoryStoreStateEntry {
  id: string;
  name: string;
}

export interface EnvironmentStateEntry {
  id: string;
  name: string;
}

export interface DeploymentStateEntry {
  id: string;
  name: string;
}

export interface State {
  agents: Record<string, { id: string; version: number }>;
  skills: Record<string, SkillStateEntry>;
  memory_stores: Record<string, MemoryStoreStateEntry>;
  environments: Record<string, EnvironmentStateEntry>;
  vaults: Record<string, VaultStateEntry>;
  deployments: Record<string, DeploymentStateEntry>;
}

export interface RemoteSkill {
  id: string;
  display_title: string;
  source: string;
  latest_version: string;
  created_at?: string;
}

export interface LocalSkill {
  /** directory name (state key + upload root) */
  localName: string;
  dirPath: string;
  /** `name` from SKILL.md YAML frontmatter */
  skillName: string;
  /** `description` from SKILL.md YAML frontmatter */
  description: string;
  /** display_title (defaults to localName) */
  displayTitle: string;
  /** hash of all files in the directory */
  hash: string;
  /** relative paths of files included in the skill */
  files: string[];
}

export interface MemoryStoreConfig {
  name: string;
  description?: string | null;
  metadata?: Record<string, string>;
}

export interface RemoteMemoryStore {
  id: string;
  name: string;
  description?: string | null;
  metadata?: Record<string, string>;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

// ---------------- environments ----------------

export interface EnvironmentUnrestrictedNetwork {
  type: 'unrestricted';
}

export interface EnvironmentLimitedNetwork {
  type: 'limited';
  allowed_hosts?: string[];
  allow_mcp_servers?: boolean;
  allow_package_managers?: boolean;
}

export type EnvironmentNetworking = EnvironmentUnrestrictedNetwork | EnvironmentLimitedNetwork;

export interface EnvironmentPackages {
  apt?: string[];
  cargo?: string[];
  gem?: string[];
  go?: string[];
  npm?: string[];
  pip?: string[];
}

export interface EnvironmentCloudConfig {
  type: 'cloud';
  packages?: EnvironmentPackages;
  networking?: EnvironmentNetworking;
}

export interface EnvironmentConfig {
  name: string;
  description?: string | null;
  metadata?: Record<string, string>;
  config: EnvironmentCloudConfig;
}

export interface RemoteEnvironment {
  id: string;
  name: string;
  description?: string | null;
  metadata?: Record<string, string>;
  config: EnvironmentCloudConfig;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

// ---------------- vaults ----------------
//
// NOTE: vault is still an evolving feature. The current scope is limited to
// **vault create + archive** of the resource itself. Updating a vault's
// display_name / metadata is not detected (vault_update is intentionally
// absent from the Action union), and credentials are not yet managed at all.
// The credentials sub-resource will be re-introduced in a future release
// once the secret-resolution story is settled.

export interface VaultConfig {
  display_name: string;
  metadata?: Record<string, string>;
}

export interface RemoteVault {
  id: string;
  display_name: string;
  metadata?: Record<string, string>;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface VaultStateEntry {
  id: string;
  display_name: string;
}

// ---------------- deployments ----------------
//
// A deployment binds an agent + environment + initial events + an optional
// cron schedule into one unit that the platform runs (on the schedule, or
// on demand). cmaform manages the declarative shape of a deployment:
// **create / update / archive**. The imperative state transitions exposed by
// the API — pause / unpause / run — are intentionally out of scope (the
// status field is treated as remote-owned).

/**
 * 5-field POSIX cron schedule. `expression` uses the standard
 * "minute hour day-of-month month day-of-week" form (no seconds/year fields,
 * no `L W # ?` specials, no `@daily`-style shortcuts). `timezone` is an IANA
 * identifier (e.g. "Asia/Tokyo", "UTC").
 */
export interface CronSchedule {
  type: 'cron';
  expression: string;
  timezone: string;
}

/** Object form of a deployment's agent reference in local YAML. */
export interface DeploymentAgentRef {
  /** Logical name of a local/remote agent (mutually exclusive-ish with `id`). */
  name?: string;
  /** Raw agent id (`agent_...`). */
  id?: string;
  /** Pin a specific version; omit to track the latest at create time. */
  version?: number;
}

export interface DeploymentConfig {
  name: string;
  description?: string | null;
  /** `agent_...` id, a local/remote agent name, or an object ref. */
  agent: string | DeploymentAgentRef;
  /** `env_...` id or a local/remote environment name. */
  environment: string;
  /** Events sent to each session immediately after creation (1–50). */
  initial_events: unknown[];
  schedule?: CronSchedule | null;
  /** Session resources mounted into each run's container. */
  resources?: unknown[];
  /** Vault `vlt_...` ids or local/remote vault names. */
  vault_ids?: string[];
  metadata?: Record<string, string>;
}

/**
 * A deployment config after every name-based reference has been resolved to
 * the id form the API expects. `agent.id` / `environment_id` / `vault_ids[]`
 * may transiently hold a forward-dependency sentinel during plan computation.
 */
export interface ResolvedDeployment {
  name: string;
  description?: string | null;
  agent: { id: string; version?: number };
  environment_id: string;
  initial_events: unknown[];
  schedule?: CronSchedule | null;
  resources?: unknown[];
  vault_ids?: string[];
  metadata?: Record<string, string>;
}

export interface RemoteDeployment {
  id: string;
  name: string;
  description?: string | null;
  agent: { id: string; type: 'agent'; version: number };
  environment_id: string;
  initial_events: unknown[];
  schedule?: (CronSchedule & { last_run_at?: string | null; upcoming_runs_at?: string[] }) | null;
  resources?: unknown[];
  vault_ids?: string[];
  metadata?: Record<string, string>;
  status?: 'active' | 'paused';
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface FieldDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}
