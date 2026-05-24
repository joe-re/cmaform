import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  VAULTS_DIR,
  VAULT_CREDENTIALS_DIRNAME,
  VAULT_MANIFEST_FILENAME,
} from './config.js';
import { anthropic, isSDKNotFound } from './sdk.js';
import type {
  CredentialAuth,
  CredentialConfig,
  CredentialMCPOAuthAuth,
  CredentialOAuthRefresh,
  CredentialStaticBearerAuth,
  CredentialTokenEndpointAuth,
  FieldDiff,
  RemoteCredential,
  RemoteVault,
  VaultConfig,
} from './types.js';

const VAULT_COMPARE_FIELDS: (keyof VaultConfig)[] = ['display_name', 'metadata'];

/**
 * Local credential entry combined with its vault.
 */
export interface LocalCredential {
  vaultLocalName: string;
  credLocalName: string;
  filePath: string;
  config: CredentialConfig;
}

/**
 * Local vault with its credentials read from `credentials/*.yaml`.
 */
export interface LocalVault {
  localName: string;
  dirPath: string;
  config: VaultConfig;
  credentials: Map<string, LocalCredential>;
}

// ---------------- filesystem ----------------

async function listVaultDirs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(VAULTS_DIR, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => path.join(VAULTS_DIR, e.name))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function listCredentialFiles(vaultDir: string): Promise<string[]> {
  const credsDir = path.join(vaultDir, VAULT_CREDENTIALS_DIRNAME);
  try {
    const entries = await fs.readdir(credsDir, { withFileTypes: true });
    return entries
      .filter(
        e => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml'))
      )
      .map(e => path.join(credsDir, e.name))
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
      throw new Error(
        `${manifestPath}: ${VAULT_MANIFEST_FILENAME} not found`
      );
    }
    throw err;
  }
  const parsed = parseYaml(content) as VaultConfig | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${manifestPath}: invalid YAML`);
  }
  if (!parsed.display_name) {
    throw new Error(
      `${manifestPath}: missing required field 'display_name'`
    );
  }
  return parsed;
}

async function readCredentialFile(filePath: string): Promise<CredentialConfig> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = parseYaml(content) as CredentialConfig | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${filePath}: invalid YAML`);
  }
  if (!parsed.auth || typeof parsed.auth !== 'object') {
    throw new Error(`${filePath}: missing required field 'auth'`);
  }
  const auth = parsed.auth as { type?: string; mcp_server_url?: string };
  if (auth.type !== 'static_bearer' && auth.type !== 'mcp_oauth') {
    throw new Error(
      `${filePath}: auth.type must be 'static_bearer' or 'mcp_oauth' (received ${JSON.stringify(auth.type)})`
    );
  }
  if (typeof auth.mcp_server_url !== 'string') {
    throw new Error(`${filePath}: auth.mcp_server_url is required`);
  }
  return parsed;
}

export async function loadAllVaultConfigs(): Promise<Map<string, LocalVault>> {
  const dirs = await listVaultDirs();
  const map = new Map<string, LocalVault>();
  for (const dirPath of dirs) {
    const localName = path.basename(dirPath);
    const config = await readVaultManifest(dirPath);
    const credFiles = await listCredentialFiles(dirPath);
    const credentials = new Map<string, LocalCredential>();
    for (const filePath of credFiles) {
      const credLocalName = path.basename(filePath).replace(/\.ya?ml$/, '');
      const credConfig = await readCredentialFile(filePath);
      credentials.set(credLocalName, {
        vaultLocalName: localName,
        credLocalName,
        filePath,
        config: credConfig,
      });
    }
    map.set(localName, { localName, dirPath, config, credentials });
  }
  return map;
}

export async function writeVaultManifestFromRemote(
  remote: RemoteVault,
  localName: string
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

export async function listVaults(
  includeArchived = false
): Promise<RemoteVault[]> {
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

export async function createVault(
  config: VaultConfig
): Promise<RemoteVault> {
  const created = await anthropic.beta.vaults.create({
    display_name: config.display_name,
    metadata: config.metadata,
  } as unknown as Parameters<typeof anthropic.beta.vaults.create>[0]);
  return created as unknown as RemoteVault;
}

export async function updateVault(
  id: string,
  config: VaultConfig,
  remote: RemoteVault
): Promise<RemoteVault> {
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
  const updated = await anthropic.beta.vaults.update(id, {
    display_name:
      config.display_name !== remote.display_name
        ? config.display_name
        : undefined,
    metadata: Object.keys(metadataPatch).length > 0 ? metadataPatch : undefined,
  } as unknown as Parameters<typeof anthropic.beta.vaults.update>[1]);
  return updated as unknown as RemoteVault;
}

export async function archiveVault(id: string): Promise<void> {
  await anthropic.beta.vaults.archive(id);
}

export async function createCredential(
  vaultId: string,
  config: CredentialConfig
): Promise<RemoteCredential> {
  const resolvedAuth = resolveAuthSecrets(config.auth);
  const created = await anthropic.beta.vaults.credentials.create(vaultId, {
    display_name: config.display_name,
    auth: resolvedAuth,
  } as unknown as Parameters<
    typeof anthropic.beta.vaults.credentials.create
  >[1]);
  return created as unknown as RemoteCredential;
}

export async function archiveCredential(
  vaultId: string,
  credentialId: string
): Promise<void> {
  await anthropic.beta.vaults.credentials.archive(credentialId, {
    vault_id: vaultId,
  } as unknown as Parameters<
    typeof anthropic.beta.vaults.credentials.archive
  >[1]);
}

// ---------------- diff ----------------

function nullToUndefined<T>(v: T): T | undefined {
  return v === null ? undefined : (v as T | undefined);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normalizeObjectField(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (isPlainObject(v) && Object.keys(v).length === 0) return undefined;
  return v;
}

export function vaultFieldDiffs(
  local: VaultConfig,
  remote: RemoteVault
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of VAULT_COMPARE_FIELDS) {
    const lvRaw = nullToUndefined(local[field] as unknown);
    const rvRaw = nullToUndefined(
      (remote as unknown as Record<string, unknown>)[field]
    );
    const lv = field === 'metadata' ? normalizeObjectField(lvRaw) : lvRaw;
    const rv = field === 'metadata' ? normalizeObjectField(rvRaw) : rvRaw;
    if (!isDeepStrictEqual(lv, rv)) {
      diffs.push({ field, oldValue: rv, newValue: lv });
    }
  }
  return diffs;
}

// ---------------- secrets ----------------
//
// Credential bodies contain write-only secret fields (`token`, `access_token`,
// `refresh_token`, `client_secret`). In v1 we recognize a single placeholder
// form `${env:VAR_NAME}` and resolve it from the process environment. Literal
// values pass through untouched. The full TBD discussion lives in
// reports/cmaform/vaults-resource-support.md.

const ENV_REFERENCE_PATTERN = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

function resolveSecret(value: string): string {
  const m = ENV_REFERENCE_PATTERN.exec(value);
  if (!m) return value;
  const varName = m[1];
  const envValue = process.env[varName];
  if (envValue === undefined || envValue === '') {
    throw new Error(
      `secret placeholder "\${env:${varName}}" cannot be resolved — environment variable ${varName} is not set`
    );
  }
  return envValue;
}

function resolveAuthSecrets(auth: CredentialAuth): CredentialAuth {
  if (auth.type === 'static_bearer') {
    const out: CredentialStaticBearerAuth = {
      type: 'static_bearer',
      mcp_server_url: auth.mcp_server_url,
      token: resolveSecret(auth.token),
    };
    return out;
  }
  const out: CredentialMCPOAuthAuth = {
    type: 'mcp_oauth',
    mcp_server_url: auth.mcp_server_url,
    access_token: resolveSecret(auth.access_token),
  };
  if (auth.expires_at !== undefined) out.expires_at = auth.expires_at;
  if (auth.refresh) {
    const refresh: CredentialOAuthRefresh = {
      token_endpoint: auth.refresh.token_endpoint,
      client_id: auth.refresh.client_id,
      refresh_token: resolveSecret(auth.refresh.refresh_token),
      token_endpoint_auth: resolveTokenEndpointAuthSecrets(
        auth.refresh.token_endpoint_auth
      ),
    };
    if (auth.refresh.scope !== undefined) refresh.scope = auth.refresh.scope;
    out.refresh = refresh;
  }
  return out;
}

function resolveTokenEndpointAuthSecrets(
  tea: CredentialTokenEndpointAuth
): CredentialTokenEndpointAuth {
  if (tea.type === 'none') return tea;
  return { ...tea, client_secret: resolveSecret(tea.client_secret) };
}

/**
 * Verify that every `${env:VAR_NAME}` placeholder in the credential body
 * resolves to a set env variable. Returns the list of missing variables (one
 * entry per occurrence). Empty list means everything is resolvable.
 */
export function findUnresolvedSecrets(
  auth: CredentialAuth,
  prefix = ''
): { fieldPath: string; envVar: string }[] {
  const out: { fieldPath: string; envVar: string }[] = [];
  const check = (value: string, fieldPath: string) => {
    const m = ENV_REFERENCE_PATTERN.exec(value);
    if (!m) return;
    const varName = m[1];
    if (process.env[varName] === undefined || process.env[varName] === '') {
      out.push({ fieldPath: prefix + fieldPath, envVar: varName });
    }
  };

  if (auth.type === 'static_bearer') {
    check(auth.token, 'auth.token');
    return out;
  }
  check(auth.access_token, 'auth.access_token');
  if (auth.refresh) {
    check(auth.refresh.refresh_token, 'auth.refresh.refresh_token');
    if (auth.refresh.token_endpoint_auth.type !== 'none') {
      check(
        auth.refresh.token_endpoint_auth.client_secret,
        'auth.refresh.token_endpoint_auth.client_secret'
      );
    }
  }
  return out;
}

/**
 * Return a copy of the credential config with secret values replaced by a
 * marker suitable for plan display (so secrets never leak into terminal output
 * or scrollback).
 */
export function maskCredentialSecrets(
  config: CredentialConfig
): CredentialConfig {
  const masked: CredentialConfig = {
    display_name: config.display_name,
    auth: maskAuthSecrets(config.auth),
  };
  return masked;
}

function maskValue(value: string): string {
  const m = ENV_REFERENCE_PATTERN.exec(value);
  if (m) return `<secret: \${env:${m[1]}}>`;
  return '<secret>';
}

function maskAuthSecrets(auth: CredentialAuth): CredentialAuth {
  if (auth.type === 'static_bearer') {
    return {
      type: 'static_bearer',
      mcp_server_url: auth.mcp_server_url,
      token: maskValue(auth.token),
    };
  }
  const out: CredentialMCPOAuthAuth = {
    type: 'mcp_oauth',
    mcp_server_url: auth.mcp_server_url,
    access_token: maskValue(auth.access_token),
  };
  if (auth.expires_at !== undefined) out.expires_at = auth.expires_at;
  if (auth.refresh) {
    const refresh: CredentialOAuthRefresh = {
      token_endpoint: auth.refresh.token_endpoint,
      client_id: auth.refresh.client_id,
      refresh_token: maskValue(auth.refresh.refresh_token),
      token_endpoint_auth: maskTokenEndpointAuth(
        auth.refresh.token_endpoint_auth
      ),
    };
    if (auth.refresh.scope !== undefined) refresh.scope = auth.refresh.scope;
    out.refresh = refresh;
  }
  return out;
}

function maskTokenEndpointAuth(
  tea: CredentialTokenEndpointAuth
): CredentialTokenEndpointAuth {
  if (tea.type === 'none') return tea;
  return { ...tea, client_secret: maskValue(tea.client_secret) };
}
