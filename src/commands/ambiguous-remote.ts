import { formatErrorDetail, formatErrorHeadline } from '../lib/ansi.js';
import { AmbiguousRemoteNameError } from '../lib/remote-lookup.js';

export const AMBIGUOUS_REMOTE_HINT =
  'Archive the ones you do not need, or run `cmaform pull <id>` to track a specific one.';

/** Candidate list shared by every command that reports an ambiguous remote name. */
export function formatAmbiguousCandidates(err: AmbiguousRemoteNameError): string[] {
  return err.candidates.map(
    (c) => `id=${c.id}${c.created_at ? ` created_at=${c.created_at}` : ''}`,
  );
}

/**
 * Print an AmbiguousRemoteNameError the way `plan` / `apply` report fatal
 * configuration problems. Any other error is re-thrown.
 */
export function reportAmbiguousRemoteName(err: unknown): void {
  if (!(err instanceof AmbiguousRemoteNameError)) throw err;
  process.stderr.write(
    formatErrorHeadline(
      `multiple active ${err.resourceKind} resources on remote are named ${JSON.stringify(err.resourceName)}; cmaform will not pick one silently:`,
    ) + '\n',
  );
  for (const line of formatAmbiguousCandidates(err)) {
    process.stderr.write('  ' + formatErrorDetail(line) + '\n');
  }
  process.stderr.write(formatErrorDetail(AMBIGUOUS_REMOTE_HINT) + '\n');
}
