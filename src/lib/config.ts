import path from 'node:path';

/**
 * Anthropic Skills beta header value required by `beta.skills.*` endpoints.
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
export const STATE_PATH = path.join(CMAFORM_DIR, 'cmaform.state.json');

export const MEMORY_STORE_MANIFEST_FILENAME = 'manifest.yaml';
export const ENVIRONMENT_MANIFEST_FILENAME = 'manifest.yaml';
export const VAULT_MANIFEST_FILENAME = 'manifest.yaml';
