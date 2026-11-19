import path from 'node:path';

/**
 * Beta header passed on every Skills API call. cmaform reads and writes the
 * `skills-2025-10-02` shapes (`display_title`, `latest_version`, timestamp
 * version ids). The SDK stopped adding this header itself in 0.122.0, and
 * without it the API answers in the GA shape, so each `beta.skills.*` call
 * must pass it explicitly.
 */
export const SKILLS_BETA = 'skills-2025-10-02';

/**
 * Treat the caller's working directory as the config root.
 * Set CMAFORM_DIR to point at a different directory if needed.
 */
export const CMAFORM_DIR = process.env.CMAFORM_DIR
  ? path.resolve(process.env.CMAFORM_DIR)
  : process.cwd();

export const AGENTS_DIR = path.join(CMAFORM_DIR, 'agents');
export const SKILLS_DIR = path.join(CMAFORM_DIR, 'skills');
export const MEMORY_STORES_DIR = path.join(CMAFORM_DIR, 'memory_stores');
export const ENVIRONMENTS_DIR = path.join(CMAFORM_DIR, 'environments');
export const VAULTS_DIR = path.join(CMAFORM_DIR, 'vaults');
export const DEPLOYMENTS_DIR = path.join(CMAFORM_DIR, 'deployments');
export const STATE_PATH = path.join(CMAFORM_DIR, 'cmaform.state.json');

export const MEMORY_STORE_MANIFEST_FILENAME = 'manifest.yaml';
export const ENVIRONMENT_MANIFEST_FILENAME = 'manifest.yaml';
export const VAULT_MANIFEST_FILENAME = 'manifest.yaml';
export const DEPLOYMENT_MANIFEST_FILENAME = 'manifest.yaml';
