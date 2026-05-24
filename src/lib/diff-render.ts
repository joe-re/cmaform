import path from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { CMAFORM_DIR } from './config.js';
import type { Action, PlanWarning } from './plan.js';
import { prettifySentinelsForDisplay } from './resolve.js';
import type { FieldDiff } from './types.js';

function formatWarningLines(
  warnings: PlanWarning[] | undefined,
  targetKind: 'skill' | 'agent'
): string {
  if (!warnings || warnings.length === 0) return '';
  const hintLines =
    targetKind === 'skill'
      ? [
          `      → continuing the delete will leave dangling references in the listed agent(s).`,
          `      → edit the referrer's YAML (remove the skill from skills[]) before re-running plan.`,
        ]
      : [
          `      → continuing the archive will break delegation from the listed coordinator(s).`,
          `      → edit the referrer's YAML (remove the agent from multiagent.agents[]) before re-running plan.`,
        ];
  const hint = hintLines.map(l => colorize('yellow', l) + '\n').join('');
  const refs = warnings
    .map(
      w =>
        '       ' +
        colorizeMany(['bold', 'yellow'], 'WARN:') +
        ' ' +
        colorize(
          'yellow',
          `still referenced by agent ${JSON.stringify(w.referrer)} (${w.fieldPath})`
        ) +
        '\n'
    )
    .join('');
  return refs + hint;
}

// Terraform-style palette:
//   green  = create
//   yellow = change / warning
//   red    = destroy / delete
//   dim    = secondary info (collapsed unchanged lines, reasons, etc)
//   bold   = label emphasis (e.g. "WARN:")
const ANSI = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
} as const;

function colorize(code: keyof typeof ANSI, text: string): string {
  if (!process.stdout.isTTY) return text;
  return ANSI[code] + text + ANSI.reset;
}

/** Combine multiple ANSI codes (e.g. bold + yellow). */
function colorizeMany(codes: (keyof typeof ANSI)[], text: string): string {
  if (!process.stdout.isTTY) return text;
  return codes.map(c => ANSI[c]).join('') + text + ANSI.reset;
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

// Options controlling plan rendering. `verbose` disables the collapse of
// long-text fields in create actions.
export interface PrintPlanOptions {
  verbose?: boolean;
}

/**
 * Fields that may contain prose long enough to be worth folding when rendering
 * a `create` action. Other fields (tools / multiagent / metadata) tend to be
 * structurally important and are rendered in full.
 */
const COLLAPSIBLE_LONG_TEXT_FIELDS = new Set(['system', 'description']);
const COLLAPSE_PREVIEW_LINES = 3;
const COLLAPSE_THRESHOLD_LINES = 6;

/**
 * Render a single (new) field for a create-style action with `+ field: value`.
 * Single-line scalars are inlined; multi-line values are emitted as a YAML
 * block with each line prefixed by `+`. Long-text fields are collapsed unless
 * `verbose` is set.
 */
export function formatCreateField(
  field: string,
  value: unknown,
  indent: string,
  opts: PrintPlanOptions = {}
): string {
  const prettified = prettifySentinelsForDisplay(value);
  const lines = serializeForDiff(prettified);

  if (lines.length === 1 && lines[0].length + field.length < 80) {
    return `${indent}+ ${field}: ${colorize('green', lines[0])}\n`;
  }

  const verbose = opts.verbose === true;
  let displayLines = lines;
  let hiddenCount = 0;
  if (
    !verbose &&
    COLLAPSIBLE_LONG_TEXT_FIELDS.has(field) &&
    lines.length > COLLAPSE_THRESHOLD_LINES
  ) {
    displayLines = lines.slice(0, COLLAPSE_PREVIEW_LINES);
    hiddenCount = lines.length - COLLAPSE_PREVIEW_LINES;
  }

  const out: string[] = [`${indent}+ ${field}:`];
  for (const line of displayLines) {
    out.push(`${indent}  ${colorize('green', `+ ${line}`)}`);
  }
  if (hiddenCount > 0) {
    out.push(
      `${indent}    ${colorize('dim', `... (${hiddenCount} lines hidden; pass --verbose to show)`)}`
    );
  }
  return out.join('\n') + '\n';
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

/**
 * Field rendering order for agent create diffs. Mirrors COMPARE_FIELDS so that
 * the layout is symmetric with update diffs.
 */
const AGENT_CREATE_FIELD_ORDER = [
  'name',
  'model',
  'description',
  'system',
  'tools',
  'mcp_servers',
  'skills',
  'multiagent',
  'metadata',
] as const;

export function printPlan(
  actions: Action[],
  opts: PrintPlanOptions = {}
): void {
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
      case 'create': {
        process.stdout.write(
          colorize(
            'green',
            `  [+] create agent  ${JSON.stringify(a.name)}`
          ) +
            '\n' +
            `       file: ${path.relative(CMAFORM_DIR, a.filePath)}\n`
        );
        const cfg = a.config as unknown as Record<string, unknown>;
        for (const field of AGENT_CREATE_FIELD_ORDER) {
          const value = cfg[field];
          if (value === undefined) continue;
          process.stdout.write(formatCreateField(field, value, '       ', opts));
        }
        creates++;
        break;
      }
      case 'update':
        process.stdout.write(
          colorize(
            'yellow',
            `  [~] update agent  ${JSON.stringify(a.name)} (id=${a.id}, version=${a.currentVersion})`
          ) +
            '\n' +
            `       file: ${path.relative(CMAFORM_DIR, a.filePath)}\n`
        );
        for (const d of a.diffs) {
          process.stdout.write(formatFieldDiff(d, '       '));
        }
        updates++;
        break;
      case 'delete':
        process.stdout.write(
          colorize(
            'red',
            `  [-] archive agent ${JSON.stringify(a.name)} (id=${a.id})`
          ) +
            '\n' +
            `       ${colorize('dim', 'reason: present in state but no local YAML')}\n` +
            formatWarningLines(a.warnings, 'agent')
        );
        deletes++;
        break;
      case 'noop':
        noops++;
        break;
      case 'skill_create':
        process.stdout.write(
          colorize(
            'green',
            `  [+] create skill  ${JSON.stringify(a.localName)}`
          ) +
            '\n' +
            `       dir:  ${path.relative(CMAFORM_DIR, a.skill.dirPath)}\n` +
            `       hash: ${a.skill.hash.slice(0, 12)}...\n`
        );
        process.stdout.write(
          formatCreateField('name', a.skill.skillName, '       ', opts) +
            formatCreateField(
              'description',
              a.skill.description,
              '       ',
              opts
            ) +
            formatCreateField(
              'display_title',
              a.skill.displayTitle,
              '       ',
              opts
            ) +
            formatCreateField('files', a.skill.files, '       ', opts)
        );
        skillCreates++;
        break;
      case 'skill_update':
        process.stdout.write(
          colorize(
            'yellow',
            `  [~] update skill  ${JSON.stringify(a.localName)} (id=${a.id})`
          ) +
            '\n' +
            `       dir:  ${path.relative(CMAFORM_DIR, a.skill.dirPath)}\n` +
            `       hash: ${a.currentHash.slice(0, 12)}... -> ${a.skill.hash.slice(0, 12)}...\n`
        );
        skillUpdates++;
        break;
      case 'skill_delete':
        process.stdout.write(
          colorize(
            'red',
            `  [-] delete skill  ${JSON.stringify(a.localName)} (id=${a.id})`
          ) +
            '\n' +
            `       ${colorize('dim', 'reason: present in state but no local skill directory')}\n` +
            '       ' +
            colorizeMany(['bold', 'yellow'], 'NOTE:') +
            ' ' +
            colorize(
              'yellow',
              'skills cannot be archived; all versions will be permanently deleted'
            ) +
            '\n' +
            formatWarningLines(a.warnings, 'skill')
        );
        skillDeletes++;
        break;
      case 'skill_noop':
        skillNoops++;
        break;
      case 'memstore_create': {
        process.stdout.write(
          colorize(
            'green',
            `  [+] create memory_store ${JSON.stringify(a.localName)}`
          ) +
            '\n' +
            `       dir:  ${path.relative(CMAFORM_DIR, a.dirPath)}\n`
        );
        const mcfg = a.config as unknown as Record<string, unknown>;
        for (const field of ['name', 'description', 'metadata']) {
          const value = mcfg[field];
          if (value === undefined) continue;
          process.stdout.write(formatCreateField(field, value, '       ', opts));
        }
        memCreates++;
        break;
      }
      case 'memstore_update':
        process.stdout.write(
          colorize(
            'yellow',
            `  [~] update memory_store ${JSON.stringify(a.localName)} (id=${a.id})`
          ) +
            '\n' +
            `       dir:  ${path.relative(CMAFORM_DIR, a.dirPath)}\n`
        );
        for (const d of a.diffs) {
          process.stdout.write(formatFieldDiff(d, '       '));
        }
        memUpdates++;
        break;
      case 'memstore_archive':
        process.stdout.write(
          colorize(
            'red',
            `  [-] archive memory_store ${JSON.stringify(a.localName)} (id=${a.id})`
          ) +
            '\n' +
            `       ${colorize('dim', 'reason: present in state but no local directory')}\n` +
            '       ' +
            colorizeMany(['bold', 'yellow'], 'NOTE:') +
            ' ' +
            colorize(
              'yellow',
              "archive is one-way (cannot be undone); the store's memory data is preserved"
            ) +
            '\n'
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
