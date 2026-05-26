import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
  type YAMLMap,
} from 'yaml';

import { listAgentFiles } from '../lib/agents.js';
import { formatErrorHeadline } from '../lib/ansi.js';
import { CMAFORM_DIR } from '../lib/config.js';
import { loadState } from '../lib/state.js';

/**
 * Rewrite every local agent YAML so that `multiagent.agents[].id` and
 * `skills[].skill_id` references switch from the raw ID form to the
 * human-friendly `name:` form when the ID is tracked in
 * `cmaform.state.json`. References whose IDs are not in state are left
 * untouched (typically Anthropic-provided skills like `xlsx` or external
 * agent IDs that have not been pulled locally yet).
 *
 * Rewrites are applied directly to the parsed YAML Document tree, so
 * user-authored comments and overall key ordering are preserved.
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

  const agentIdToName = buildIdToNameMap(state.agents);
  const skillIdToLocalName = buildIdToNameMap(state.skills);

  const files = await listAgentFiles();
  let filesRewritten = 0;
  let refsRewritten = 0;

  for (const filePath of files) {
    const text = await fs.readFile(filePath, 'utf-8');
    const doc = parseDocument(text);
    let changed = 0;

    const multiagent = doc.get('multiagent', true);
    if (isMap(multiagent)) {
      const agents = multiagent.get('agents', true);
      if (isSeq(agents)) {
        for (const item of agents.items) {
          if (!isMap(item)) continue;
          if (getStringField(item, 'type') !== 'agent') continue;
          const id = getStringField(item, 'id');
          if (!id) continue;
          const name = agentIdToName.get(id);
          if (!name) continue;
          replaceKey(item, 'id', 'name', name);
          changed++;
        }
      }
    }

    const skills = doc.get('skills', true);
    if (isSeq(skills)) {
      for (const item of skills.items) {
        if (!isMap(item)) continue;
        if (getStringField(item, 'type') !== 'custom') continue;
        const id = getStringField(item, 'skill_id');
        if (!id) continue;
        const localName = skillIdToLocalName.get(id);
        if (!localName) continue;
        replaceKey(item, 'skill_id', 'name', localName);
        changed++;
      }
    }

    if (changed === 0) continue;
    await fs.writeFile(filePath, String(doc), 'utf-8');
    process.stdout.write(
      `  [~] ${path.relative(CMAFORM_DIR, filePath)}: rewrote ${changed} reference(s)\n`
    );
    filesRewritten++;
    refsRewritten += changed;
  }

  if (filesRewritten === 0) {
    process.stdout.write(
      'No changes — every agent YAML already uses the name form.\n'
    );
    return 0;
  }
  process.stdout.write(
    `\nfmt complete: rewrote ${refsRewritten} reference(s) across ${filesRewritten} file(s).\n`
  );
  return 0;
}

function buildIdToNameMap(
  entries: Record<string, { id: string }>
): Map<string, string> {
  const m = new Map<string, string>();
  for (const [name, entry] of Object.entries(entries)) m.set(entry.id, name);
  return m;
}

function getStringField(map: YAMLMap, key: string): string | null {
  const node = map.get(key, true) as Node | undefined;
  if (isScalar(node) && typeof node.value === 'string') return node.value;
  return null;
}

/**
 * Rewrite a `<oldKey>: <oldValue>` Pair in a YAMLMap to `<newKey>: <newValue>`
 * by mutating the existing key / value Scalar nodes in place. Mutating in
 * place — rather than constructing a fresh Pair — preserves the Pair's
 * position in the map and any comments attached to the original Pair or its
 * surrounding Scalars (line-leading `commentBefore`, end-of-line `comment`).
 */
function replaceKey(
  map: YAMLMap,
  oldKey: string,
  newKey: string,
  newValue: string
): void {
  const pair = map.items.find(p => {
    const k = isScalar(p.key) ? p.key.value : p.key;
    return k === oldKey;
  });
  if (!pair) return;
  if (isScalar(pair.key)) pair.key.value = newKey;
  if (isScalar(pair.value)) pair.value.value = newValue;
}
