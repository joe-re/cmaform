/**
 * cmaform — Terraform-style management CLI for Anthropic Managed Agents.
 *
 * This file is a thin dispatcher. Subcommand implementations live under
 * `src/commands/` and their shared helpers under `src/lib/`.
 */

import { cmdApply } from './commands/apply.js';
import { cmdList } from './commands/list.js';
import { cmdPlan } from './commands/plan.js';
import { cmdPull } from './commands/pull.js';
import { cmdRefresh } from './commands/refresh.js';
import { cmdSync } from './commands/sync.js';
import { CMAFORM_DIR, STATE_PATH } from './lib/config.js';

function showHelp(): void {
  process.stderr.write(
    `cmaform — Terraform-style management for Anthropic Managed Agents / Skills / Memory Stores.\n\n` +
      `Usage:\n` +
      `  cmaform pull <agent_id>           # import a remote agent (writes YAML + state)\n` +
      `  cmaform pull <skill_id>           # import a remote skill into state only (SKILL.md is not generated)\n` +
      `  cmaform pull <memstore_id>        # import a remote memory_store (writes manifest.yaml + state)\n` +
      `  cmaform sync                      # rewrite YAML for every entry in state from remote\n` +
      `  cmaform refresh                   # update the state file to match remote (no remote writes)\n` +
      `  cmaform plan [target...]          # show diff (target = agents/skills/memory_stores or resource name)\n` +
      `  cmaform apply [--yes|-y] [target...]\n` +
      `                                    # show plan, prompt for confirmation, apply (target = kind or resource name)\n` +
      `  cmaform list                      # show local files / state / remote side-by-side\n` +
      `\n` +
      `Environment:\n` +
      `  ANTHROPIC_API_KEY                 (required) Anthropic API key\n` +
      `  CMAFORM_DIR                       (optional) config root directory (default: cwd)\n` +
      `\n` +
      `Resolved paths:\n` +
      `  cmaform dir:   ${CMAFORM_DIR}\n` +
      `  state file:    ${STATE_PATH}\n`
  );
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);

  // Branch on help first so it works without an API key.
  if (cmd === '--help' || cmd === '-h' || cmd === 'help' || cmd === undefined) {
    showHelp();
    return cmd === undefined ? 2 : 0;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY environment variable is not set');
    return 2;
  }

  switch (cmd) {
    case 'plan': {
      const targets = args.filter(a => !a.startsWith('-'));
      return cmdPlan(targets);
    }
    case 'apply': {
      const autoApprove = args.includes('--yes') || args.includes('-y');
      const targets = args.filter(a => !a.startsWith('-'));
      return cmdApply(autoApprove, targets);
    }
    case 'pull':
      if (!args[0]) {
        showHelp();
        return 2;
      }
      return cmdPull(args[0]);
    case 'refresh':
      return cmdRefresh();
    case 'sync':
      return cmdSync();
    case 'list':
      return cmdList();
    default:
      showHelp();
      return 2;
  }
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
