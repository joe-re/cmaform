import { colorizeMany, formatErrorDetail, formatErrorHeadline } from '../lib/ansi.js';
import { AmbiguousRemoteNameError } from '../lib/remote-lookup.js';

export const AMBIGUOUS_REMOTE_HINT =
  'Archive the ones you do not need, or run `cmaform pull <id>` to track a specific one.';

/** Candidate list shared by every command that reports an ambiguous remote name. */
export function formatAmbiguousCandidates(err: AmbiguousRemoteNameError): string[] {
  return err.candidates.map(
    (c) => `id=${c.id}${c.created_at ? ` created_at=${c.created_at}` : ''}`,
  );
}

/** An ambiguous name together with the resources that reference it, if any. */
export interface FatalAmbiguity {
  error: AmbiguousRemoteNameError;
  /** Referencing resources such as `deployment "nightly"`; empty for the resource itself. */
  referencedBy: string[];
}

function writeAmbiguousHeading(err: AmbiguousRemoteNameError): void {
  process.stderr.write(
    formatErrorHeadline(
      `multiple active ${err.resourceKind} resources on remote are named ${JSON.stringify(err.resourceName)}; cmaform will not pick one silently:`,
    ) + '\n',
  );
  for (const line of formatAmbiguousCandidates(err)) {
    process.stderr.write('  ' + formatErrorDetail(line) + '\n');
  }
}

/**
 * Print every fatal ambiguity the way `plan` / `apply` report configuration
 * problems: a headline and candidate list per name, then the hint once.
 */
export function reportAmbiguousRemoteNames(items: FatalAmbiguity[]): void {
  for (const { error, referencedBy } of items) {
    writeAmbiguousHeading(error);
    for (const r of referencedBy) {
      process.stderr.write('  ' + formatErrorDetail(`referenced by ${r}`) + '\n');
    }
  }
  process.stderr.write(formatErrorDetail(AMBIGUOUS_REMOTE_HINT) + '\n');
}

/**
 * Print an AmbiguousRemoteNameError the way `plan` / `apply` report fatal
 * configuration problems. Any other error is re-thrown.
 */
export function reportAmbiguousRemoteName(err: unknown): void {
  if (!(err instanceof AmbiguousRemoteNameError)) throw err;
  reportAmbiguousRemoteNames([{ error: err, referencedBy: [] }]);
}

/**
 * Warning lines for ambiguities that do not affect the targets of this run,
 * followed by the hint once. Empty when there is nothing to warn about.
 */
export function formatAmbiguityWarnings(warnings: string[]): string {
  if (warnings.length === 0) return '';
  const label = colorizeMany(['bold', 'yellow'], 'WARN:');
  return warnings.map((w) => `${label} ${w}\n`).join('') + AMBIGUOUS_REMOTE_HINT + '\n';
}

/** `2 active remote resources are named "notes" (id=a, id=b)` */
export function describeAmbiguousName(err: AmbiguousRemoteNameError): string {
  return `${err.candidates.length} active remote resources are named ${JSON.stringify(err.resourceName)} (${err.candidates.map((c) => `id=${c.id}`).join(', ')})`;
}

/**
 * One-line warning for discovery commands (`init` / `sync`) that skip a
 * resource because several active remote resources carry its name.
 */
export function formatAmbiguousSkip(
  kind: string,
  localName: string,
  name: string,
  candidates: { id: string }[],
): string {
  return `  [!] skipped ${kind} ${JSON.stringify(localName)}: ${candidates.length} active remote resources are named ${JSON.stringify(name)} (${candidates.map((c) => `id=${c.id}`).join(', ')})\n`;
}
