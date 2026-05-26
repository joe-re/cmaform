import { promises as fs } from 'node:fs';
import path from 'node:path';

import { listAgentFiles } from '../lib/agents.js';
import { formatErrorHeadline } from '../lib/ansi.js';
import { CMAFORM_DIR } from '../lib/config.js';
import { rewriteYamlRefsToNameForm } from '../lib/fmt.js';
import { loadState } from '../lib/state.js';

/**
 * Rewrite every local agent YAML so that `multiagent.agents[].id` and
 * `skills[].skill_id` references switch from the raw ID form to the
 * human-friendly `name:` form when the ID is tracked in
 * `cmaform.state.json`. References whose IDs are not in state are left
 * untouched (typically Anthropic-provided skills like `xlsx` or external
 * agent IDs that have not been pulled locally yet).
 *
 * The rewrite is performed as a line-level text substitution on the
 * original file (NOT a parse → stringify round-trip). This is a deliberate
 * choice: yaml's serializer cannot reproduce the original line breaks of
 * folded (`>-`) scalars or the exact quoting / indentation style of
 * untouched fields, so any round-trip would churn the rest of the file.
 * The substitution only rewrites lines that match a known agent/skill ID
 * — Anthropic IDs are unique 24-char base32 randoms, so collisions with
 * other YAML values are not a concern in practice.
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
    const before = await fs.readFile(filePath, 'utf-8');
    const { text: after, changed } = rewriteYamlRefsToNameForm(before, state);
    if (changed === 0) continue;
    await fs.writeFile(filePath, after, 'utf-8');
    process.stdout.write(
      `  [~] ${path.relative(CMAFORM_DIR, filePath)}: rewrote ${changed} reference(s)\n`
    );
    filesRewritten++;
    refsRewritten += changed;
  }

  if (filesRewritten === 0) {
    process.stdout.write('No changes.\n');
    return 0;
  }
  process.stdout.write(
    `\nfmt complete: rewrote ${refsRewritten} reference(s) across ${filesRewritten} file(s).\n`
  );
  return 0;
}
