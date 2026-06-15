import path from 'node:path';

import { listAgents, loadAllAgentConfigs } from '../lib/agents.js';
import { CMAFORM_DIR } from '../lib/config.js';
import { listDeployments, loadAllDeploymentConfigs } from '../lib/deployments.js';
import { listEnvironments, loadAllEnvironmentConfigs } from '../lib/environments.js';
import { listMemoryStores, loadAllMemoryStoreConfigs } from '../lib/memory-stores.js';
import { listVaults, loadAllVaultConfigs } from '../lib/vaults.js';
import { listSkills, loadAllSkillConfigs } from '../lib/skills.js';
import { loadState } from '../lib/state.js';

export async function cmdList(): Promise<number> {
  const state = await loadState();
  const configs = await loadAllAgentConfigs();
  const skills = await loadAllSkillConfigs();
  const memoryStores = await loadAllMemoryStoreConfigs();
  const environments = await loadAllEnvironmentConfigs();
  const vaults = await loadAllVaultConfigs();
  const deployments = await loadAllDeploymentConfigs();

  console.log('=== local agents ===');
  if (configs.size === 0) console.log('  (none)');
  for (const [name, { filePath }] of configs) {
    const tracked = state.agents[name];
    const idStr = tracked ? `id=${tracked.id} version=${tracked.version}` : 'untracked';
    console.log(
      `  ${path.relative(CMAFORM_DIR, filePath)}  name=${JSON.stringify(name)}  ${idStr}`,
    );
  }

  console.log('\n=== remote agents ===');
  const remoteAgents = await listAgents();
  let remoteCount = 0;
  for (const a of remoteAgents) {
    if (a.archived_at) continue;
    const tracked = Object.values(state.agents).some((s) => s.id === a.id);
    console.log(
      `  ${JSON.stringify(a.name)}  id=${a.id}  version=${a.version}${tracked ? '' : '  (untracked)'}`,
    );
    remoteCount++;
  }
  if (remoteCount === 0) console.log('  (none)');

  console.log('\n=== local skills ===');
  if (skills.size === 0) console.log('  (none)');
  for (const [localName, skill] of skills) {
    const tracked = state.skills[localName];
    const idStr = tracked
      ? `id=${tracked.id} version=${tracked.version} hash_match=${tracked.hash === skill.hash}`
      : 'untracked';
    console.log(`  ${path.relative(CMAFORM_DIR, skill.dirPath)}  ${idStr}`);
  }

  console.log('\n=== remote skills (custom) ===');
  let remoteSkillCount = 0;
  try {
    const remoteSkills = await listSkills('custom');
    for (const s of remoteSkills) {
      const tracked = Object.values(state.skills).some((e) => e.id === s.id);
      console.log(
        `  ${JSON.stringify(s.display_title)}  id=${s.id}  version=${s.latest_version}${tracked ? '' : '  (untracked)'}`,
      );
      remoteSkillCount++;
    }
  } catch (err) {
    console.log(`  (fetch failed: ${(err as Error).message})`);
  }
  if (remoteSkillCount === 0) console.log('  (none)');

  console.log('\n=== local memory_stores ===');
  if (memoryStores.size === 0) console.log('  (none)');
  for (const [, { config, dirPath }] of memoryStores) {
    const localName = path.basename(dirPath);
    const tracked = state.memory_stores[localName];
    const idStr = tracked ? `id=${tracked.id}` : 'untracked';
    console.log(
      `  ${path.relative(CMAFORM_DIR, dirPath)}  name=${JSON.stringify(config.name)}  ${idStr}`,
    );
  }

  console.log('\n=== remote memory_stores ===');
  let remoteMemCount = 0;
  try {
    const remoteMems = await listMemoryStores();
    for (const m of remoteMems) {
      if (m.archived_at) continue;
      const tracked = Object.values(state.memory_stores).some((e) => e.id === m.id);
      console.log(`  ${JSON.stringify(m.name)}  id=${m.id}${tracked ? '' : '  (untracked)'}`);
      remoteMemCount++;
    }
  } catch (err) {
    console.log(`  (fetch failed: ${(err as Error).message})`);
  }
  if (remoteMemCount === 0) console.log('  (none)');

  console.log('\n=== local environments ===');
  if (environments.size === 0) console.log('  (none)');
  for (const [, { config, dirPath }] of environments) {
    const localName = path.basename(dirPath);
    const tracked = state.environments[localName];
    const idStr = tracked ? `id=${tracked.id}` : 'untracked';
    console.log(
      `  ${path.relative(CMAFORM_DIR, dirPath)}  name=${JSON.stringify(config.name)}  ${idStr}`,
    );
  }

  console.log('\n=== remote environments ===');
  let remoteEnvCount = 0;
  try {
    const remoteEnvs = await listEnvironments();
    for (const e of remoteEnvs) {
      if (e.archived_at) continue;
      const tracked = Object.values(state.environments).some((s) => s.id === e.id);
      console.log(`  ${JSON.stringify(e.name)}  id=${e.id}${tracked ? '' : '  (untracked)'}`);
      remoteEnvCount++;
    }
  } catch (err) {
    console.log(`  (fetch failed: ${(err as Error).message})`);
  }
  if (remoteEnvCount === 0) console.log('  (none)');

  console.log('\n=== local vaults ===');
  if (vaults.size === 0) console.log('  (none)');
  for (const [localName, vault] of vaults) {
    const tracked = state.vaults[localName];
    const idStr = tracked ? `id=${tracked.id}` : 'untracked';
    console.log(
      `  ${path.relative(CMAFORM_DIR, vault.dirPath)}  display_name=${JSON.stringify(vault.config.display_name)}  ${idStr}`,
    );
  }

  console.log('\n=== remote vaults ===');
  let remoteVaultCount = 0;
  try {
    const remoteVaults = await listVaults();
    for (const v of remoteVaults) {
      if (v.archived_at) continue;
      const tracked = Object.values(state.vaults).some((s) => s.id === v.id);
      console.log(
        `  ${JSON.stringify(v.display_name)}  id=${v.id}${tracked ? '' : '  (untracked)'}`,
      );
      remoteVaultCount++;
    }
  } catch (err) {
    console.log(`  (fetch failed: ${(err as Error).message})`);
  }
  if (remoteVaultCount === 0) console.log('  (none)');

  console.log('\n=== local deployments ===');
  if (deployments.size === 0) console.log('  (none)');
  for (const [localName, { config, dirPath }] of deployments) {
    const tracked = state.deployments[localName];
    const idStr = tracked ? `id=${tracked.id}` : 'untracked';
    console.log(
      `  ${path.relative(CMAFORM_DIR, dirPath)}  name=${JSON.stringify(config.name)}  ${idStr}`,
    );
  }

  console.log('\n=== remote deployments ===');
  let remoteDeployCount = 0;
  try {
    const remoteDeployments = await listDeployments();
    for (const d of remoteDeployments) {
      if (d.archived_at) continue;
      const tracked = Object.values(state.deployments).some((s) => s.id === d.id);
      console.log(
        `  ${JSON.stringify(d.name)}  id=${d.id}${d.schedule ? `  schedule=${JSON.stringify(d.schedule.expression)}` : ''}${tracked ? '' : '  (untracked)'}`,
      );
      remoteDeployCount++;
    }
  } catch (err) {
    console.log(`  (fetch failed: ${(err as Error).message})`);
  }
  if (remoteDeployCount === 0) console.log('  (none)');

  return 0;
}
