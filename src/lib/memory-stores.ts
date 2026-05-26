import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { MEMORY_STORES_DIR, MEMORY_STORE_MANIFEST_FILENAME } from './config.js';
import { anthropic, isSDKNotFound } from './sdk.js';
import type { FieldDiff, MemoryStoreConfig, RemoteMemoryStore } from './types.js';

const MEMORY_STORE_COMPARE_FIELDS: (keyof MemoryStoreConfig)[] = [
  'name',
  'description',
  'metadata',
];

// ---------------- filesystem ----------------

async function listMemoryStoreDirs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(MEMORY_STORES_DIR, {
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(MEMORY_STORES_DIR, e.name))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readMemoryStoreManifest(dirPath: string): Promise<MemoryStoreConfig> {
  const manifestPath = path.join(dirPath, MEMORY_STORE_MANIFEST_FILENAME);
  let content: string;
  try {
    content = await fs.readFile(manifestPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${manifestPath}: ${MEMORY_STORE_MANIFEST_FILENAME} not found`);
    }
    throw err;
  }
  const parsed = parseYaml(content) as MemoryStoreConfig | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${manifestPath}: invalid YAML`);
  }
  if (!parsed.name) {
    throw new Error(`${manifestPath}: missing required field 'name'`);
  }
  return parsed;
}

export async function loadAllMemoryStoreConfigs(): Promise<
  Map<string, { config: MemoryStoreConfig; dirPath: string }>
> {
  const dirs = await listMemoryStoreDirs();
  const map = new Map<string, { config: MemoryStoreConfig; dirPath: string }>();
  for (const dirPath of dirs) {
    const localName = path.basename(dirPath);
    const config = await readMemoryStoreManifest(dirPath);
    map.set(localName, { config, dirPath });
  }
  return map;
}

export async function writeMemoryStoreManifestFromRemote(
  remote: RemoteMemoryStore,
  localName: string,
): Promise<string> {
  const out: MemoryStoreConfig = {
    name: remote.name,
    description: remote.description ?? undefined,
    metadata: remote.metadata,
  };
  const dirPath = path.join(MEMORY_STORES_DIR, localName);
  await fs.mkdir(dirPath, { recursive: true });
  const manifestPath = path.join(dirPath, MEMORY_STORE_MANIFEST_FILENAME);
  await fs.writeFile(manifestPath, stringifyYaml(out), 'utf-8');
  return manifestPath;
}

// ---------------- SDK ----------------

export async function listMemoryStores(_includeArchived = false): Promise<RemoteMemoryStore[]> {
  const results: RemoteMemoryStore[] = [];
  for await (const m of anthropic.beta.memoryStores.list({})) {
    results.push(m as unknown as RemoteMemoryStore);
  }
  return results;
}

export async function retrieveMemoryStore(id: string): Promise<RemoteMemoryStore | null> {
  try {
    const m = await anthropic.beta.memoryStores.retrieve(id);
    return m as unknown as RemoteMemoryStore;
  } catch (err) {
    if (isSDKNotFound(err)) return null;
    throw err;
  }
}

export async function createMemoryStore(config: MemoryStoreConfig): Promise<RemoteMemoryStore> {
  const created = await anthropic.beta.memoryStores.create({
    name: config.name,
    description: config.description ?? undefined,
    metadata: config.metadata,
  } as unknown as Parameters<typeof anthropic.beta.memoryStores.create>[0]);
  return created as unknown as RemoteMemoryStore;
}

export async function updateMemoryStore(
  id: string,
  config: MemoryStoreConfig,
  remote: RemoteMemoryStore,
): Promise<RemoteMemoryStore> {
  // metadata patch: keys missing locally are sent as null (delete); others are upserted.
  const localMeta = config.metadata ?? {};
  const remoteMeta = remote.metadata ?? {};
  const allKeys = new Set([...Object.keys(localMeta), ...Object.keys(remoteMeta)]);
  const metadataPatch: Record<string, string | null> = {};
  for (const k of allKeys) {
    if (!(k in localMeta)) {
      metadataPatch[k] = null;
    } else if (localMeta[k] !== remoteMeta[k]) {
      metadataPatch[k] = localMeta[k];
    }
  }

  const updated = await anthropic.beta.memoryStores.update(id, {
    name: config.name !== remote.name ? config.name : undefined,
    description:
      (config.description ?? '') !== (remote.description ?? '')
        ? (config.description ?? '')
        : undefined,
    metadata: Object.keys(metadataPatch).length > 0 ? metadataPatch : undefined,
  } as unknown as Parameters<typeof anthropic.beta.memoryStores.update>[1]);
  return updated as unknown as RemoteMemoryStore;
}

export async function archiveMemoryStore(id: string): Promise<void> {
  await anthropic.beta.memoryStores.archive(id);
}

// ---------------- diff ----------------

function nullToUndefined<T>(v: T): T | undefined {
  return v === null ? undefined : (v as T | undefined);
}

export function memoryStoreFieldDiffs(
  local: MemoryStoreConfig,
  remote: RemoteMemoryStore,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of MEMORY_STORE_COMPARE_FIELDS) {
    const lv = nullToUndefined(local[field] as unknown);
    const rv = nullToUndefined(remote[field] as unknown);
    if (!isDeepStrictEqual(lv, rv)) {
      diffs.push({ field, oldValue: rv, newValue: lv });
    }
  }
  return diffs;
}
