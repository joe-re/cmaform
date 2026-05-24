import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  ENVIRONMENTS_DIR,
  ENVIRONMENT_MANIFEST_FILENAME,
} from './config.js';
import { anthropic, isSDKNotFound } from './sdk.js';
import type {
  EnvironmentCloudConfig,
  EnvironmentConfig,
  EnvironmentLimitedNetwork,
  EnvironmentNetworking,
  EnvironmentPackages,
  FieldDiff,
  RemoteEnvironment,
} from './types.js';

const ENVIRONMENT_COMPARE_FIELDS: (keyof EnvironmentConfig)[] = [
  'name',
  'description',
  'metadata',
  'config',
];

const PACKAGE_KEYS = ['apt', 'cargo', 'gem', 'go', 'npm', 'pip'] as const;

// ---------------- filesystem ----------------

async function listEnvironmentDirs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(ENVIRONMENTS_DIR, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => path.join(ENVIRONMENTS_DIR, e.name))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readEnvironmentManifest(
  dirPath: string
): Promise<EnvironmentConfig> {
  const manifestPath = path.join(dirPath, ENVIRONMENT_MANIFEST_FILENAME);
  let content: string;
  try {
    content = await fs.readFile(manifestPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${manifestPath}: ${ENVIRONMENT_MANIFEST_FILENAME} not found`
      );
    }
    throw err;
  }
  const parsed = parseYaml(content) as EnvironmentConfig | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${manifestPath}: invalid YAML`);
  }
  if (!parsed.name) {
    throw new Error(`${manifestPath}: missing required field 'name'`);
  }
  if (!parsed.config || parsed.config.type !== 'cloud') {
    throw new Error(
      `${manifestPath}: config.type must be 'cloud' (received ${parsed.config?.type ?? 'undefined'})`
    );
  }
  return parsed;
}

export async function loadAllEnvironmentConfigs(): Promise<
  Map<string, { config: EnvironmentConfig; dirPath: string }>
> {
  const dirs = await listEnvironmentDirs();
  const map = new Map<
    string,
    { config: EnvironmentConfig; dirPath: string }
  >();
  for (const dirPath of dirs) {
    const localName = path.basename(dirPath);
    const config = await readEnvironmentManifest(dirPath);
    map.set(localName, { config, dirPath });
  }
  return map;
}

export async function writeEnvironmentManifestFromRemote(
  remote: RemoteEnvironment,
  localName: string
): Promise<string> {
  const out: EnvironmentConfig = {
    name: remote.name,
    description: remote.description ?? undefined,
    metadata: remote.metadata,
    config: normalizeCloudConfigForWrite(remote.config),
  };
  const dirPath = path.join(ENVIRONMENTS_DIR, localName);
  await fs.mkdir(dirPath, { recursive: true });
  const manifestPath = path.join(dirPath, ENVIRONMENT_MANIFEST_FILENAME);
  await fs.writeFile(manifestPath, stringifyYaml(out), 'utf-8');
  return manifestPath;
}

// ---------------- SDK ----------------

export async function listEnvironments(
  includeArchived = false
): Promise<RemoteEnvironment[]> {
  const results: RemoteEnvironment[] = [];
  for await (const env of anthropic.beta.environments.list({
    include_archived: includeArchived,
  })) {
    results.push(env as unknown as RemoteEnvironment);
  }
  return results;
}

export async function retrieveEnvironment(
  id: string
): Promise<RemoteEnvironment | null> {
  try {
    const env = await anthropic.beta.environments.retrieve(id);
    return env as unknown as RemoteEnvironment;
  } catch (err) {
    if (isSDKNotFound(err)) return null;
    throw err;
  }
}

export async function createEnvironment(
  config: EnvironmentConfig
): Promise<RemoteEnvironment> {
  const created = await anthropic.beta.environments.create({
    name: config.name,
    description: config.description ?? undefined,
    metadata: config.metadata,
    config: config.config,
  } as unknown as Parameters<typeof anthropic.beta.environments.create>[0]);
  return created as unknown as RemoteEnvironment;
}

export async function updateEnvironment(
  id: string,
  config: EnvironmentConfig,
  remote: RemoteEnvironment
): Promise<RemoteEnvironment> {
  // metadata patch: keys missing locally are sent as null (delete); others upserted.
  const localMeta = config.metadata ?? {};
  const remoteMeta = remote.metadata ?? {};
  const allKeys = new Set([
    ...Object.keys(localMeta),
    ...Object.keys(remoteMeta),
  ]);
  const metadataPatch: Record<string, string | null> = {};
  for (const k of allKeys) {
    if (!(k in localMeta)) metadataPatch[k] = null;
    else if (localMeta[k] !== remoteMeta[k]) metadataPatch[k] = localMeta[k];
  }

  const updated = await anthropic.beta.environments.update(id, {
    name: config.name !== remote.name ? config.name : undefined,
    description:
      (config.description ?? '') !== (remote.description ?? '')
        ? (config.description ?? '')
        : undefined,
    metadata: Object.keys(metadataPatch).length > 0 ? metadataPatch : undefined,
    config: config.config,
  } as unknown as Parameters<typeof anthropic.beta.environments.update>[1]);
  return updated as unknown as RemoteEnvironment;
}

export async function archiveEnvironment(id: string): Promise<void> {
  await anthropic.beta.environments.archive(id);
}

// ---------------- normalization ----------------
//
// The retrieve response always materializes every package-manager key as an
// array (possibly empty) and stamps `type: 'packages'`, even if the user
// originally omitted those fields. To keep `plan` idempotent, we collapse
// both sides into a canonical form before comparison.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normalizePackages(
  pkgs: unknown
): EnvironmentPackages | undefined {
  if (!isPlainObject(pkgs)) return undefined;
  const out: EnvironmentPackages = {};
  let hasAny = false;
  for (const key of PACKAGE_KEYS) {
    const value = pkgs[key];
    if (Array.isArray(value) && value.length > 0) {
      // Sort to make ordering insignificant.
      out[key] = [...value].sort();
      hasAny = true;
    }
  }
  return hasAny ? out : undefined;
}

function normalizeNetworking(
  net: unknown
): EnvironmentNetworking | undefined {
  if (!isPlainObject(net)) return undefined;
  if (net.type === 'unrestricted') return { type: 'unrestricted' };
  if (net.type === 'limited') {
    const limited: EnvironmentLimitedNetwork = { type: 'limited' };
    if (
      Array.isArray(net.allowed_hosts) &&
      (net.allowed_hosts as unknown[]).length > 0
    ) {
      limited.allowed_hosts = [...(net.allowed_hosts as string[])].sort();
    }
    if (net.allow_mcp_servers === true) limited.allow_mcp_servers = true;
    if (net.allow_package_managers === true)
      limited.allow_package_managers = true;
    return limited;
  }
  return undefined;
}

function normalizeCloudConfigForCompare(
  cfg: unknown
): EnvironmentCloudConfig | undefined {
  if (!isPlainObject(cfg)) return undefined;
  if (cfg.type !== 'cloud') return cfg as unknown as EnvironmentCloudConfig;
  const out: EnvironmentCloudConfig = { type: 'cloud' };
  const packages = normalizePackages(cfg.packages);
  if (packages) out.packages = packages;
  const networking = normalizeNetworking(cfg.networking);
  if (networking) out.networking = networking;
  return out;
}

/**
 * Stripped-down config used when writing a remote environment back to YAML.
 * Drops the synthetic `type: 'packages'` marker, empty arrays, and false-defaults
 * so the written manifest matches what a human would author.
 */
function normalizeCloudConfigForWrite(
  cfg: EnvironmentCloudConfig
): EnvironmentCloudConfig {
  return normalizeCloudConfigForCompare(cfg) ?? cfg;
}

function nullToUndefined<T>(v: T): T | undefined {
  return v === null ? undefined : (v as T | undefined);
}

function normalizeObjectField(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (isPlainObject(v) && Object.keys(v).length === 0) return undefined;
  return v;
}

function normalizeEnvironmentFieldPair(
  field: keyof EnvironmentConfig,
  local: unknown,
  remote: unknown
): [unknown, unknown] {
  switch (field) {
    case 'config':
      return [
        normalizeCloudConfigForCompare(local),
        normalizeCloudConfigForCompare(remote),
      ];
    case 'metadata':
      return [normalizeObjectField(local), normalizeObjectField(remote)];
    default:
      return [local, remote];
  }
}

export function environmentFieldDiffs(
  local: EnvironmentConfig,
  remote: RemoteEnvironment
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of ENVIRONMENT_COMPARE_FIELDS) {
    const lvRaw = nullToUndefined(local[field] as unknown);
    const rvRaw = nullToUndefined(
      (remote as unknown as Record<string, unknown>)[field]
    );
    const [lv, rv] = normalizeEnvironmentFieldPair(field, lvRaw, rvRaw);
    if (!isDeepStrictEqual(lv, rv)) {
      diffs.push({ field, oldValue: rv, newValue: lv });
    }
  }
  return diffs;
}
