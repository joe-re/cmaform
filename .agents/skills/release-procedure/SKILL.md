---
name: release-procedure
description: Release workflow for the cmaform npm package. Use when Codex is asked to prepare, verify, cut, tag, publish, or document a cmaform release, including version bumps, CHANGELOG updates, npm package checks, GitHub tags/releases, and final push/publish steps.
---

# Release Procedure

Follow this workflow for cmaform releases. Keep verification and publishing separate: perform local checks freely, but do not run irreversible publish, tag push, or GitHub release creation without explicit user approval.

## Preflight

1. Confirm the repository is clean or identify unrelated user changes:
   ```bash
   git status --short
   ```
2. Inspect release-relevant files:
   ```bash
   sed -n '1,140p' CHANGELOG.md
   sed -n '1,100p' package.json
   sed -n '1,120p' .github/workflows/ci.yml
   ```
3. Determine the next SemVer version from `CHANGELOG.md`, commit history, and the user request. If unclear, ask before editing.

## Prepare Release Changes

1. Update `package.json` `version`.
2. Update `CHANGELOG.md`:
   - Move relevant `## [Unreleased]` entries into `## [x.y.z] - YYYY-MM-DD`.
   - Leave an empty `## [Unreleased]` section for future changes.
   - Update comparison links at the bottom:
     - `[Unreleased]: https://github.com/joe-re/cmaform/compare/vx.y.z...HEAD`
     - `[x.y.z]: https://github.com/joe-re/cmaform/releases/tag/vx.y.z`
3. If package metadata, shipped files, or CLI behavior changed, check `README.md`, `README.ja.md`, and `SECURITY.md` for release-facing drift.

## Verify

Run the same checks CI expects:

```bash
pnpm run fmt:check
pnpm run lint
pnpm run typecheck
pnpm test
pnpm build
node dist/cli.js --help
```

If dependencies must be freshly installed with pnpm 11 and the lockfile is trusted, use:

```bash
CI=true pnpm install --frozen-lockfile --config.trust-lockfile=true
```

Check package contents before publishing:

```bash
pnpm pack --dry-run
```

Confirm `dist/`, `README.md`, `README.ja.md`, `CHANGELOG.md`, `SECURITY.md`, `LICENSE`, and package metadata are included as intended.

## Commit

Stage only release-related files:

```bash
git add package.json CHANGELOG.md README.md README.ja.md SECURITY.md pnpm-lock.yaml
git commit -m "Release vx.y.z"
```

Adjust the staged file list to match actual release edits. Do not stage unrelated user changes.

## Publish And Tag

Only after the user explicitly approves publishing:

1. Confirm identity and package status:
   ```bash
   npm whoami
   npm view cmaform version
   ```
2. Publish:
   ```bash
   npm publish --access public
   ```
3. Create and push the tag:
   ```bash
   git tag vx.y.z
   git push origin main
   git push origin vx.y.z
   ```
4. Create a GitHub release if requested or expected:
   ```bash
   gh release create vx.y.z --title "vx.y.z" --notes-file CHANGELOG.md
   ```

If `npm publish` succeeds but later steps fail, report the exact published version and stop before retrying anything destructive.

## Post-release

1. Verify npm shows the new version:
   ```bash
   npm view cmaform version
   ```
2. Verify the pushed tag / release exists:
   ```bash
   git ls-remote --tags origin vx.y.z
   gh release view vx.y.z
   ```
3. Report:
   - version
   - commit SHA
   - tag
   - npm publish result
   - GitHub release URL, if created
