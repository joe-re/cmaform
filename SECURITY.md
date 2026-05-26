# Security Policy

## Supported versions

cmaform follows semantic versioning. Until a `1.0.0` release ships, only the
**latest published version** receives security patches. Once `1.0.x` is
released, the policy will be revisited.

| Version             | Supported           |
| ------------------- | ------------------- |
| latest `0.x` on npm | ✅                  |
| Older `0.x`         | ❌ — please upgrade |

## Reporting a vulnerability

**Please do not file public GitHub issues for security problems.**

Use one of the following channels:

1. **GitHub Security Advisory** (preferred): open a private advisory at
   <https://github.com/joe-re/cmaform/security/advisories/new>. This keeps the
   report private until a fix is published.
2. **Email**: `joe.tialtngo@gmail.com` with the subject prefix
   `[cmaform-security]`.

Please include:

- a description of the issue,
- a minimal reproduction or affected version(s),
- the impact you observed or anticipate.

You should receive an acknowledgement within **7 days**. Once the issue is
confirmed we will work on a patch and coordinate disclosure timing with you.
Credit (or anonymity, if you prefer) will be given in the CHANGELOG entry for
the fix.

## Scope and threat model

cmaform is a **local CLI** that talks to the Anthropic API on behalf of the
user. The interesting trust boundaries are:

- **`ANTHROPIC_API_KEY`** is read from the environment and forwarded to the
  Anthropic SDK / a direct multipart upload. It is never written to disk and
  never logged. If you find a code path that exposes it, that is a high
  severity issue.
- **Local YAML / manifest files** are trusted input authored by the user. We
  do not currently sandbox YAML parsing or guard against prototype pollution
  beyond what `yaml` and `JSON.parse` already provide in modern Node.
- **`cmaform.state.json`** stores resource IDs, versions, and hashes — no
  secrets. Treat it like a Terraform state file (local source of truth,
  `.gitignore`'d by default).
- **Vault credentials** are **not yet managed by cmaform** in this release
  (see the README). Secret-resolution for credential bodies is deferred to a
  future release; for now, credential secrets only exist on the Anthropic
  side.
- **Remote responses** from `api.anthropic.com` are trusted to the extent the
  SDK trusts them. The single hand-rolled `fetch` call in
  `src/lib/skills.ts` truncates error bodies before surfacing them.

Issues outside this scope (e.g. flaws in the Anthropic platform itself,
network-layer attacks on a TLS connection to api.anthropic.com, etc.) should
be reported to Anthropic directly.

## Tips for safe operation

- Run `pnpm audit` / `npm audit` periodically against your install.
- Pin `cmaform` to a specific version in CI rather than `latest`.
- Treat `cmaform.state.json` as sensitive enough to keep out of version
  control — it does not contain secrets today, but future fields may.
- Avoid committing `ANTHROPIC_API_KEY` to shell history or shared `.env`
  files. Use your platform's secret store where possible.
