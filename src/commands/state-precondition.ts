import path from 'node:path';

import { formatErrorDetail, formatErrorHeadline } from '../lib/ansi.js';
import { CMAFORM_DIR, STATE_PATH } from '../lib/config.js';
import { loadRequiredState, MissingStateFileError } from '../lib/state.js';
import type { State } from '../lib/types.js';

export async function loadStateForPlanApply(command: 'plan' | 'apply'): Promise<State | null> {
  try {
    return await loadRequiredState();
  } catch (err) {
    if (!(err instanceof MissingStateFileError)) throw err;
    process.stderr.write(
      formatErrorHeadline(
        `cmaform.state.json is missing. Run \`cmaform init\` before \`cmaform ${command}\`.`,
      ) + '\n',
    );
    process.stderr.write(
      '  ' +
        formatErrorDetail(`expected state file: ${path.relative(CMAFORM_DIR, STATE_PATH)}`) +
        '\n',
    );
    return null;
  }
}
