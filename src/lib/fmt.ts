import type { State } from './types.js';

/**
 * Pure helper: rewrite a single agent YAML file's text content so that
 * `id: <agentId>` / `skill_id: <skillId>` lines whose ID is tracked in
 * `state` become `name: <localName>`. Returns the new text and the count
 * of rewrites.
 */
export function rewriteYamlRefsToNameForm(
  text: string,
  state: Pick<State, 'agents' | 'skills'>,
): { text: string; changed: number } {
  const agentRewrites = idLookups('id', state.agents);
  const skillRewrites = idLookups('skill_id', state.skills);

  let out = text;
  let changed = 0;
  for (const { pattern, name } of [...agentRewrites, ...skillRewrites]) {
    out = out.replace(pattern, (_match, indent, _quote, comment) => {
      changed++;
      return `${indent}name: ${name}${comment ?? ''}`;
    });
  }
  return { text: out, changed };
}

/**
 * Build one regex per ID matching that exact `<yamlKey>: <id>` line (with
 * optional surrounding quotes and an optional trailing comment). Returning
 * one pattern per ID lets us reject IDs that aren't tracked in state.
 */
function idLookups(
  yamlKey: 'id' | 'skill_id',
  entries: Record<string, { id: string }>,
): { pattern: RegExp; name: string }[] {
  return Object.entries(entries).map(([name, entry]) => ({
    pattern: new RegExp(
      `^([ \\t]+)${yamlKey}:[ \\t]+(['"]?)${escapeRegex(entry.id)}\\2([ \\t]+#.*)?$`,
      'gm',
    ),
    name,
  }));
}

/**
 * Pure helper: rewrite a deployment manifest's text so that
 * `memory_store_id: <id>` lines whose id is tracked in `state.memory_stores`
 * become `memory_store: <localName>`. Handles the key as a list-item head
 * (`- memory_store_id: ...`), quotes and trailing comments. Returns the new
 * text and the count of rewrites.
 */
export function rewriteDeploymentRefsToNameForm(
  text: string,
  state: Pick<State, 'memory_stores'>,
): { text: string; changed: number } {
  let out = text;
  let changed = 0;
  for (const [name, entry] of Object.entries(state.memory_stores)) {
    const pattern = new RegExp(
      `^([ \\t]*(?:-[ \\t]+)?)memory_store_id:[ \\t]+(['"]?)${escapeRegex(entry.id)}\\2([ \\t]+#.*)?$`,
      'gm',
    );
    out = out.replace(pattern, (_match, prefix, _quote, comment) => {
      changed++;
      return `${prefix}memory_store: ${name}${comment ?? ''}`;
    });
  }
  return { text: out, changed };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
