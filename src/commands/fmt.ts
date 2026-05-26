import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { listAgentFiles, readAgentYaml } from '../lib/agents.js';
import { formatErrorHeadline } from '../lib/ansi.js';
import { CMAFORM_DIR } from '../lib/config.js';
import {
  rewriteAgentRefsToNameForm,
  rewriteSkillRefsToNameForm,
} from '../lib/resolve.js';
import { loadState } from '../lib/state.js';
import type { AgentConfig, State } from '../lib/types.js';

/**
 * Rewrite every local agent YAML so that `multiagent.agents[].id` and
 * `skills[].skill_id` references switch from the raw ID form to the
 * human-friendly `name:` form when the ID is tracked in
 * `cmaform.state.json`. References whose IDs are not in state are left
 * untouched (typically Anthropic-provided skills like `xlsx` or external
 * agent IDs that have not been pulled locally yet).
 *
 * The rewrite is a no-op on YAML that already uses the name form.
 *
 * One-shot migration helper for repositories that have been managing
 * `multiagent.agents` with hand-copied IDs and now want to switch to the
 * name-based references documented in the README.
 */
export async function cmdFmt(): Promise<number> {
  const state = await loadState();

  if (
    Object.keys(state.agents).length === 0 &&
    Object.keys(state.skills).length === 0
  ) {
    process.stderr.write(
      formatErrorHeadline(
        'cmaform.state.json has no agents or skills — nothing to rewrite. Run `cmaform pull <id>` or `cmaform init` first.'
      ) + '\n'
    );
    return 2;
  }

  const files = await listAgentFiles();
  let filesRewritten = 0;
  let refsRewritten = 0;

  for (const filePath of files) {
    const before = await readAgentYaml(filePath);
    const result = rewriteConfig(before, state);
    if (result.changed === 0) continue;
    await writeAgentYaml(filePath, result.config);
    process.stdout.write(
      `  [~] ${path.relative(CMAFORM_DIR, filePath)}: rewrote ${result.changed} reference(s)\n`
    );
    filesRewritten++;
    refsRewritten += result.changed;
  }

  if (filesRewritten === 0) {
    process.stdout.write('No changes — every agent YAML already uses the name form.\n');
    return 0;
  }
  process.stdout.write(
    `\nfmt complete: rewrote ${refsRewritten} reference(s) across ${filesRewritten} file(s).\n`
  );
  return 0;
}

interface RewriteResult {
  config: AgentConfig;
  changed: number;
}

function rewriteConfig(config: AgentConfig, state: State): RewriteResult {
  let changed = 0;
  const out: AgentConfig = { ...config };

  if (out.multiagent && Array.isArray(out.multiagent.agents)) {
    const original = out.multiagent.agents;
    const rewritten = rewriteAgentRefsToNameForm(
      original as unknown[],
      state
    ) as typeof original | undefined;
    if (rewritten && !shallowEqualArr(original, rewritten)) {
      changed += countDifferences(original, rewritten);
      out.multiagent = { ...out.multiagent, agents: rewritten };
    }
  }

  if (Array.isArray(out.skills)) {
    const rewritten = rewriteSkillRefsToNameForm(
      out.skills as unknown[],
      state
    ) as unknown[] | undefined;
    if (rewritten && !shallowEqualArr(out.skills, rewritten)) {
      changed += countDifferences(out.skills, rewritten);
      out.skills = rewritten;
    }
  }

  return { config: out, changed };
}

function shallowEqualArr(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}

function countDifferences(a: unknown[], b: unknown[]): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) n++;
  }
  return n;
}

async function writeAgentYaml(
  filePath: string,
  config: AgentConfig
): Promise<void> {
  // Re-parse the file so we preserve the user's overall field order; only
  // the array entries we rewrote actually change.
  const original = parseYaml(await fs.readFile(filePath, 'utf-8')) as Record<
    string,
    unknown
  > | null;
  const merged: Record<string, unknown> = { ...(original ?? {}) };
  if (config.multiagent !== undefined) merged.multiagent = config.multiagent;
  if (config.skills !== undefined) merged.skills = config.skills;
  await fs.writeFile(filePath, stringifyYaml(merged), 'utf-8');
}
