export interface MultiagentRosterEntry {
  type: 'agent' | 'self';
  id?: string;
  version?: number;
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

export interface State {
  agents: Record<string, { id: string; version: number }>;
  skills: Record<string, SkillStateEntry>;
  memory_stores: Record<string, MemoryStoreStateEntry>;
  environments: Record<string, EnvironmentStateEntry>;
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

export type EnvironmentNetworking =
  | EnvironmentUnrestrictedNetwork
  | EnvironmentLimitedNetwork;

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

export interface FieldDiff {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}
