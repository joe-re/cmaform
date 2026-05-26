import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { VAULTS_DIR, VAULT_MANIFEST_FILENAME } from './config.js';
import { anthropic, isSDKNotFound } from './sdk.js';
import type { RemoteVault, VaultConfig } from './types.js';

/**
 * Local vault loaded from `vaults/<localName>/manifest.yaml`.
 *
 * NOTE: vault is still an evolving feature in cmaform. Only **create** and
 * **archive** of the vault itself are supported. Updates to `display_name` /
 * `metadata` are NOT detected after the vault is created, and credentials
 * are not yet managed by cmaform (credentials must be created via the
 * Anthropic Console or API directly for now).
 */
export interface LocalVault {
  localName: string;
  dirPath: string;
  config: VaultConfig;
}

// ---------------- filesystem ----------------

async function listVaultDirs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(VAULTS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(VAULTS_DIR, e.name))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readVaultManifest(dirPath: string): Promise<VaultConfig> {
  const manifestPath = path.join(dirPath, VAULT_MANIFEST_FILENAME);
  let content: string;
  try {
    content = await fs.readFile(manifestPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${manifestPath}: ${VAULT_MANIFEST_FILENAME} not found`);
    }
    throw err;
  }
  const parsed = parseYaml(content) as VaultConfig | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${manifestPath}: invalid YAML`);
  }
  if (!parsed.display_name) {
    throw new Error(`${manifestPath}: missing required field 'display_name'`);
  }
  return parsed;
}

export async function loadAllVaultConfigs(): Promise<Map<string, LocalVault>> {
  const dirs = await listVaultDirs();
  const map = new Map<string, LocalVault>();
  for (const dirPath of dirs) {
    const localName = path.basename(dirPath);
    const config = await readVaultManifest(dirPath);
    map.set(localName, { localName, dirPath, config });
  }
  return map;
}

export async function writeVaultManifestFromRemote(
  remote: RemoteVault,
  localName: string,
): Promise<string> {
  const out: VaultConfig = {
    display_name: remote.display_name,
    metadata: remote.metadata,
  };
  const dirPath = path.join(VAULTS_DIR, localName);
  await fs.mkdir(dirPath, { recursive: true });
  const manifestPath = path.join(dirPath, VAULT_MANIFEST_FILENAME);
  await fs.writeFile(manifestPath, stringifyYaml(out), 'utf-8');
  return manifestPath;
}

// ---------------- SDK ----------------

export async function listVaults(includeArchived = false): Promise<RemoteVault[]> {
  const results: RemoteVault[] = [];
  for await (const v of anthropic.beta.vaults.list({
    include_archived: includeArchived,
  })) {
    results.push(v as unknown as RemoteVault);
  }
  return results;
}

export async function retrieveVault(id: string): Promise<RemoteVault | null> {
  try {
    const v = await anthropic.beta.vaults.retrieve(id);
    return v as unknown as RemoteVault;
  } catch (err) {
    if (isSDKNotFound(err)) return null;
    throw err;
  }
}

export async function createVault(config: VaultConfig): Promise<RemoteVault> {
  const created = await anthropic.beta.vaults.create({
    display_name: config.display_name,
    metadata: config.metadata,
  } as unknown as Parameters<typeof anthropic.beta.vaults.create>[0]);
  return created as unknown as RemoteVault;
}

export async function archiveVault(id: string): Promise<void> {
  await anthropic.beta.vaults.archive(id);
}
