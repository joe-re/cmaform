import { promises as fs } from 'node:fs';

import { STATE_PATH } from './config.js';
import type { State } from './types.js';

export async function loadState(): Promise<State> {
  try {
    const content = await fs.readFile(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(content) as Partial<State> | null;
    return {
      agents: parsed?.agents ?? {},
      skills: parsed?.skills ?? {},
      memory_stores: parsed?.memory_stores ?? {},
      environments: parsed?.environments ?? {},
      vaults: parsed?.vaults ?? {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        agents: {},
        skills: {},
        memory_stores: {},
        environments: {},
        vaults: {},
      };
    }
    throw err;
  }
}

export async function saveState(state: State): Promise<void> {
  const sorted: State = {
    agents: {},
    skills: {},
    memory_stores: {},
    environments: {},
    vaults: {},
  };
  for (const key of Object.keys(state.agents).sort()) {
    sorted.agents[key] = state.agents[key];
  }
  for (const key of Object.keys(state.skills).sort()) {
    sorted.skills[key] = state.skills[key];
  }
  for (const key of Object.keys(state.memory_stores).sort()) {
    sorted.memory_stores[key] = state.memory_stores[key];
  }
  for (const key of Object.keys(state.environments).sort()) {
    sorted.environments[key] = state.environments[key];
  }
  for (const key of Object.keys(state.vaults).sort()) {
    const v = state.vaults[key];
    const sortedCreds: Record<string, { id: string; mcp_server_url: string }> = {};
    for (const ck of Object.keys(v.credentials).sort()) {
      sortedCreds[ck] = v.credentials[ck];
    }
    sorted.vaults[key] = { ...v, credentials: sortedCreds };
  }
  await fs.writeFile(
    STATE_PATH,
    JSON.stringify(sorted, null, 2) + '\n',
    'utf-8'
  );
}
