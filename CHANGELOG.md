# Changelog

All notable changes to **cmaform** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-06-01

### Changed

- Updated README and package metadata to use Anthropic's official
  `Claude Managed Agents` terminology.

### Fixed

- Fixed resolution of `latest` sub-agent versions so referenced agents use the
  current remote version when planning and applying changes.

## [0.2.0] - 2026-05-27

### Added

- `cmaform fmt` subcommand: rewrite `multiagent.agents[].id` /
  `skills[].skill_id` in local YAML files to the name form using
  `cmaform.state.json` for the id → name lookup. One-shot migration
  helper for repositories that previously hand-copied raw IDs.
- `--by-id` flag for `cmaform pull` / `cmaform sync`: keep raw IDs in
  `multiagent.agents[]` / `skills[]` when writing agent YAML, instead
  of rewriting to the name form. Escape hatch for users who want the
  pre-name-resolution output exactly.
- Plan diff now annotates known IDs with a `# = <localName>` comment
  in the rendered YAML, so readers can tell at a glance which
  sub-agent or skill an opaque ID refers to.
- Pin assertion: when a `multiagent.agents[]` / `skills[]` entry writes
  both `name:` and `id:` (or `skill_id:`), cmaform resolves the name
  and verifies it matches the pinned ID. Mismatches abort `plan` /
  `apply` with a clear error. Useful as a safety net during migration
  from id-based to name-based references.
- Project-local release procedure skill for preparing, verifying, and
  publishing cmaform releases.

### Changed

- CI now runs format, lint, typecheck, test, build, and CLI help checks with
  pnpm 11 from `packageManager`.
- Development workflow now uses `oxfmt`, `oxlint`, `lefthook`, and broader
  unit coverage for lib-level planning, warning, normalization, and diff logic.

## [0.1.0] - 2026-05-25

Initial public release.

### Added

- Terraform-style CLI (`cmaform`) for managing Claude Managed Agents
  declaratively from a local directory of YAML files.
- Subcommands: `pull`, `plan`, `apply`, `sync`, `init`, `list`.
- Five managed resource types:
  - **agents** (`agents/<name>.yaml`) — full CRUD with field-level diff and
    update detection.
  - **skills** (`skills/<localName>/`) — directory upload (`SKILL.md` +
    auxiliary files) with SHA-256 content hashing; `apply` creates a new
    version on change. Hard delete only.
  - **memory stores** (`memory_stores/<localName>/manifest.yaml`) — create,
    update (metadata patch semantics), archive.
  - **environments** (`environments/<localName>/manifest.yaml`) — create,
    update, archive for cloud-type environments with package + networking
    configuration.
  - **vaults** (`vaults/<localName>/manifest.yaml`) — create and archive of
    the vault resource only. Updates and credential management are out of
    scope for this release; configure credentials on the Anthropic Console
    after creating a vault with cmaform.
- Name-based references in agent YAML (`multiagent.agents[].name`,
  `skills[].name`) with topological sort and pending-id sentinels so a fresh
  workspace can be bootstrapped with one `cmaform apply`.
- Plan output in Terraform style: `[+] create`, `[~] update`, `[-] delete`
  headers with ANSI color (green / yellow / red, with dim secondary lines
  and bold-yellow `WARN:` / `NOTE:` labels).
- Plan normalization: empty arrays vs `undefined`, `default_config`
  inheritance for `tools[].configs[]`, `latest` version pairing for
  `multiagent.agents[].version` and `skills[].version`, and deterministic
  key ordering in YAML diff serialization.
- `create` actions are rendered as `+ field: value` diffs (symmetric with
  update). Long-text fields like `system` and `description` are collapsed to
  the first three lines plus an `... (N lines hidden)` marker; pass
  `--verbose` / `-v` for the full content.
- Dangling-reference warnings when a `delete` or `skill_delete` target is
  still referenced by another local agent. Apply switches to a dedicated
  "Proceed with these dangling deletes?" confirmation message.
- Target filtering on `plan` / `apply` accepting resource-kind aliases
  (`agents`, `skills`, `memory_stores`, `environments`, `vaults`, and their
  singular / short forms) as well as individual resource names.
- `init` command (Terraform-style reconcile-only) and `sync` command
  (rewrite local YAML from remote) for state recovery and discovery.
- TypeScript source (Node.js 22+, ESM, strict mode), bundled to a single
  `dist/cli.js` with [tsup](https://tsup.egoist.dev/). MIT-licensed.

### Security

- Secrets never reach disk or terminal: `ANTHROPIC_API_KEY` is forwarded to
  the SDK and a single `fetch` call only. Future credential secret material
  is masked in plan output before display.
- `dist/cli.js.map` is intentionally not shipped in the npm tarball.
- `pnpm audit` clean against `@anthropic-ai/sdk` 0.98.0 and `yaml` 2.x.

[Unreleased]: https://github.com/joe-re/cmaform/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/joe-re/cmaform/releases/tag/v0.2.1
[0.2.0]: https://github.com/joe-re/cmaform/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/joe-re/cmaform/releases/tag/v0.1.0
