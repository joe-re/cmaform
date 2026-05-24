import path from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { CMAFORM_DIR } from './config.js';
import type { Action } from './plan.js';
import { prettifySentinelsForDisplay } from './resolve.js';
import type { FieldDiff } from './types.js';

const ANSI = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
} as const;

function colorize(code: keyof typeof ANSI, text: string): string {
  if (!process.stdout.isTTY) return text;
  return ANSI[code] + text + ANSI.reset;
}

/**
 * Recursively sort object keys so YAML serialization is deterministic. Array
 * order is preserved (it is semantically meaningful for tools / agents / etc).
 * Used purely for display — diff detection runs on the original objects via
 * deep-equal which is already insensitive to key order.
 */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = canonicalize((v as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return v;
}

function serializeForDiff(v: unknown): string[] {
  if (v === undefined || v === null) return ['(unset)'];
  if (typeof v === 'string')
    return v.length === 0 ? ['(empty)'] : v.split('\n');
  if (typeof v !== 'object') return [String(v)];
  try {
    return stringifyYaml(canonicalize(v), { lineWidth: 0 })
      .trimEnd()
      .split('\n');
  } catch {
    return JSON.stringify(canonicalize(v), null, 2).split('\n');
  }
}

type DiffOp = { type: ' ' | '-' | '+'; text: string };
type RenderOp = DiffOp | { type: '...'; count: number };

function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: ' ', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: '-', text: a[i++] });
    } else {
      out.push({ type: '+', text: b[j++] });
    }
  }
  while (i < m) out.push({ type: '-', text: a[i++] });
  while (j < n) out.push({ type: '+', text: b[j++] });
  return out;
}

function collapseUnchanged(ops: DiffOp[], context: number): RenderOp[] {
  const result: RenderOp[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type !== ' ') {
      result.push(ops[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j].type === ' ') j++;
    const runLen = j - i;
    const isHead = result.length === 0;
    const isTail = j >= ops.length;
    const keepBefore = isHead ? 0 : context;
    const keepAfter = isTail ? 0 : context;
    if (runLen <= keepBefore + keepAfter + 1) {
      for (let k = i; k < j; k++) result.push(ops[k]);
    } else {
      for (let k = i; k < i + keepBefore; k++) result.push(ops[k]);
      result.push({ type: '...', count: runLen - keepBefore - keepAfter });
      for (let k = j - keepAfter; k < j; k++) result.push(ops[k]);
    }
    i = j;
  }
  return result;
}

export function formatFieldDiff(diff: FieldDiff, indent: string): string {
  // Forward-dependency sentinels are encoded as opaque strings during plan
  // computation; prettify them just before display so the diff shows
  // "<pending: agent foo>" instead of "__cmaform_pending_agent__:foo".
  const oldLines = serializeForDiff(prettifySentinelsForDisplay(diff.oldValue));
  const newLines = serializeForDiff(prettifySentinelsForDisplay(diff.newValue));

  // Short single-line scalars are rendered inline.
  if (
    oldLines.length === 1 &&
    newLines.length === 1 &&
    oldLines[0].length + newLines[0].length + diff.field.length < 80
  ) {
    return (
      `${indent}~ ${diff.field}: ` +
      `${colorize('red', oldLines[0])} -> ${colorize('green', newLines[0])}\n`
    );
  }

  const ops = collapseUnchanged(lcsDiff(oldLines, newLines), 2);
  const lines: string[] = [`${indent}~ ${diff.field}:`];
  for (const op of ops) {
    if (op.type === '...') {
      lines.push(
        `${indent}    ${colorize('dim', `... (${op.count} unchanged line${op.count === 1 ? '' : 's'})`)}`
      );
    } else if (op.type === '-') {
      lines.push(`${indent}  ${colorize('red', `- ${op.text}`)}`);
    } else if (op.type === '+') {
      lines.push(`${indent}  ${colorize('green', `+ ${op.text}`)}`);
    } else {
      lines.push(`${indent}    ${op.text}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function printPlan(actions: Action[]): void {
  let creates = 0;
  let updates = 0;
  let deletes = 0;
  let noops = 0;
  let skillCreates = 0;
  let skillUpdates = 0;
  let skillDeletes = 0;
  let skillNoops = 0;
  let memCreates = 0;
  let memUpdates = 0;
  let memArchives = 0;
  let memNoops = 0;

  for (const a of actions) {
    switch (a.type) {
      case 'create':
        process.stdout.write(
          `  [+] create agent  ${JSON.stringify(a.name)}\n` +
            `       file: ${path.relative(CMAFORM_DIR, a.filePath)}\n`
        );
        creates++;
        break;
      case 'update':
        process.stdout.write(
          `  [~] update agent  ${JSON.stringify(a.name)} (id=${a.id}, version=${a.currentVersion})\n` +
            `       file: ${path.relative(CMAFORM_DIR, a.filePath)}\n`
        );
        for (const d of a.diffs) {
          process.stdout.write(formatFieldDiff(d, '       '));
        }
        updates++;
        break;
      case 'delete':
        process.stdout.write(
          `  [-] archive agent ${JSON.stringify(a.name)} (id=${a.id})\n` +
            `       reason: present in state but no local YAML\n`
        );
        deletes++;
        break;
      case 'noop':
        noops++;
        break;
      case 'skill_create':
        process.stdout.write(
          `  [+] create skill  ${JSON.stringify(a.localName)}\n` +
            `       dir:  ${path.relative(CMAFORM_DIR, a.skill.dirPath)}\n` +
            `       hash: ${a.skill.hash.slice(0, 12)}...\n`
        );
        skillCreates++;
        break;
      case 'skill_update':
        process.stdout.write(
          `  [~] update skill  ${JSON.stringify(a.localName)} (id=${a.id})\n` +
            `       dir:  ${path.relative(CMAFORM_DIR, a.skill.dirPath)}\n` +
            `       hash: ${a.currentHash.slice(0, 12)}... -> ${a.skill.hash.slice(0, 12)}...\n`
        );
        skillUpdates++;
        break;
      case 'skill_delete':
        process.stdout.write(
          `  [-] delete skill  ${JSON.stringify(a.localName)} (id=${a.id})\n` +
            `       reason: present in state but no local skill directory\n` +
            `       NOTE: skills cannot be archived; all versions will be permanently deleted\n`
        );
        skillDeletes++;
        break;
      case 'skill_noop':
        skillNoops++;
        break;
      case 'memstore_create':
        process.stdout.write(
          `  [+] create memory_store ${JSON.stringify(a.localName)}\n` +
            `       dir:  ${path.relative(CMAFORM_DIR, a.dirPath)}\n` +
            `       name: ${JSON.stringify(a.config.name)}\n`
        );
        memCreates++;
        break;
      case 'memstore_update':
        process.stdout.write(
          `  [~] update memory_store ${JSON.stringify(a.localName)} (id=${a.id})\n` +
            `       dir:  ${path.relative(CMAFORM_DIR, a.dirPath)}\n`
        );
        for (const d of a.diffs) {
          process.stdout.write(formatFieldDiff(d, '       '));
        }
        memUpdates++;
        break;
      case 'memstore_archive':
        process.stdout.write(
          `  [-] archive memory_store ${JSON.stringify(a.localName)} (id=${a.id})\n` +
            `       reason: present in state but no local directory\n` +
            `       NOTE: archive is one-way (cannot be undone); the store's memory data is preserved\n`
        );
        memArchives++;
        break;
      case 'memstore_noop':
        memNoops++;
        break;
    }
  }

  process.stdout.write(
    `\nPlan (agents):         ${creates} to add, ${updates} to change, ${deletes} to archive, ${noops} unchanged.\n` +
      `Plan (skills):         ${skillCreates} to add, ${skillUpdates} to change, ${skillDeletes} to delete, ${skillNoops} unchanged.\n` +
      `Plan (memory_stores):  ${memCreates} to add, ${memUpdates} to change, ${memArchives} to archive, ${memNoops} unchanged.\n`
  );
}
