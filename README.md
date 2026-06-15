<h1 align="center">cmaform</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/cmaform"><img src="https://img.shields.io/npm/v/cmaform.svg" alt="npm version"></a>
  <a href="https://github.com/joe-re/cmaform/actions/workflows/ci.yml"><img src="https://github.com/joe-re/cmaform/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/cmaform.svg" alt="License: MIT"></a>
</p>

<p align="center">
  English | <a href="./README.ja.md">日本語</a>
</p>

**cmaform** is a Terraform-style CLI for managing **Claude Managed Agents and their surrounding resources** — agents, skills, memory stores, environments, vaults, and deployments — as files in your repo. You declare each resource as a YAML file, run `cmaform plan` to see what will change, and `cmaform apply` to ship it.

```text
  [~] update agent       "release-prep" (id=agent_01Qx..., version=6)
       file: agents/release-prep.yaml
       ~ system:
           ... (12 unchanged lines)
         - prior wording...
         + revised wording...
           ... (8 unchanged lines)
  [+] create skill       "spec-lookup"
       dir:  skills/spec-lookup
       hash: 7b8b14094e01...

Plan (agents):         0 to add, 1 to change, 0 to archive, 5 unchanged.
Plan (skills):         1 to add, 0 to change, 0 to delete, 0 unchanged.
Plan (memory_stores):  0 to add, 0 to change, 0 to archive, 0 unchanged.
Plan (environments):   0 to add, 0 to change, 0 to archive, 1 unchanged.
Plan (vaults):         0 to archive, 1 unchanged.
Plan (deployments):    0 to add, 0 to change, 0 to archive, 1 unchanged.
```

## ⚡ Quick Start

Try it first

```bash
npx cmaform --help
```

Install and use

```bash
npm install -g cmaform
```

Bootstrap a new config directory and import an existing managed agent

```bash
export ANTHROPIC_API_KEY=sk-ant-...

mkdir my-agents && cd my-agents
cmaform pull agent_011CaSWcCrMdQdp4SA6TVdH6   # writes agents/<name>.yaml + state
cmaform plan                                  # show the diff
cmaform apply                                 # confirm → push to Anthropic
```

> Claude Managed Agents and related APIs for Skills / Memory Stores / Environments / Vaults / Deployments are currently **beta**. cmaform calls `@anthropic-ai/sdk`'s `beta.agents.*` / `beta.skills.*` / `beta.memoryStores.*` / `beta.environments.*` / `beta.vaults.*` / `beta.deployments.*` endpoints directly.

## 🚀 Usage

### Commands

| Command                                                 | What it does                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cmaform pull <id> [--by-id]`                           | Import a remote resource by ID (`agent_*` / `skill_*` / `memstore_*` / `env_*` / `vlt_*` / `deploy_*`) into local files + state. Pass `--by-id` to keep raw IDs in the written agent / deployment YAML instead of rewriting refs to the name form |
| `cmaform plan [--verbose\|-v] [target...]`              | Diff local YAML / state / remote and print a Terraform-style plan. Requires an existing `cmaform.state.json` from `init` or `pull`                                                                                                                |
| `cmaform apply [--yes\|-y] [--verbose\|-v] [target...]` | Show plan, prompt for confirmation, apply, save state. Requires an existing `cmaform.state.json` from `init` or `pull`                                                                                                                            |
| `cmaform sync [--by-id]`                                | Re-fetch every entry in state from remote and rewrite local YAML. Pass `--by-id` to keep raw IDs in the written agent YAML instead of rewriting refs to the name form                                                                             |
| `cmaform init`                                          | Initialize / reconcile the state file against remote (no remote writes; spirit of `terraform init`)                                                                                                                                               |
| `cmaform list`                                          | Show local files / state / remote side-by-side                                                                                                                                                                                                    |
| `cmaform fmt`                                           | Rewrite `multiagent.agents[].id` / `skills[].skill_id` in local YAML to the name form, using `cmaform.state.json` for the id → name lookup                                                                                                        |

### Filtering plan / apply

The last positional arguments to `plan` and `apply` are targets. A target can be a **resource kind** or an **individual resource name** — useful for staged rollouts (e.g. create a skill first, copy its `skill_id` into an agent YAML, then apply the agent).

```bash
cmaform apply skills                     # all skills
cmaform apply agents                     # all agents
cmaform apply slack-mention-lookup       # a single skill by name
cmaform apply release-prep --yes         # a single agent, skip confirmation
cmaform apply skills release-prep        # all skills + one agent
```

A `<target>` is either a **kind alias** (matches every resource of that type) or the **individual name** of one specific resource. Use the table below for kind aliases; anything else is treated as a resource name.

| Resource     | Kind aliases                                                | Individual name format                | Example                                                 |
| ------------ | ----------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Agent        | `agent` / `agents`                                          | `name:` field in the YAML             | `release-prep` (`agents/release-prep.yaml`)             |
| Skill        | `skill` / `skills`                                          | directory name under `skills/`        | `slack-mention-lookup` (`skills/slack-mention-lookup/`) |
| Memory Store | `memory_store` / `memory_stores` / `memstore` / `memstores` | directory name under `memory_stores/` | `team-notes` (`memory_stores/team-notes/`)              |
| Environment  | `environment` / `environments` / `env` / `envs`             | directory name under `environments/`  | `python-dev` (`environments/python-dev/`)               |
| Vault        | `vault` / `vaults`                                          | directory name under `vaults/`        | `my-bot` (`vaults/my-bot/`)                             |
| Deployment   | `deployment` / `deployments` / `deploy` / `deploys`         | directory name under `deployments/`   | `nightly` (`deployments/nightly/`)                      |

`plan` expands create / update diffs symmetrically: a new resource is rendered as `+ field: ...` blocks just like an update is rendered as `~ field: ...` blocks. Long string fields (`system`, `description`) are truncated to 3 lines plus an `... (N lines hidden)` marker. Pass `--verbose` to show full content.

If you pass an individual name that doesn't exist anywhere (local YAML, state, or remote), cmaform exits with code `2`. An unmatched kind is fine — it just shows `0 to add, 0 to change, ...`.

### Pulling existing resources

```bash
cmaform pull agent_011CaSWcCrMdQdp4SA6TVdH6   # writes agents/<name>.yaml
cmaform pull skill_013uPS15B3Kw82NpjH4uNQep   # state only — SKILL.md is not regenerated
cmaform pull memstore_01ABC...                # writes memory_stores/<name>/manifest.yaml
cmaform pull env_015G...                      # writes environments/<name>/manifest.yaml
cmaform pull vlt_011CaQ...                    # writes vaults/<name>/manifest.yaml (credentials not managed yet)
cmaform pull deploy_01Gk...                   # writes deployments/<name>/manifest.yaml + state
```

Skill content is **not** returned by the Anthropic API once uploaded, so `pull` for skills only records the ID + version + display title into state. The local `SKILL.md` must be authored by you.

## 📦 Resources

cmaform manages six resource types — **agents**, **skills**, **memory stores**, **environments**, **vaults**, and **deployments**. Each lives under its own top-level directory beneath the config root. (Create vaults with cmaform, then finish configuring them on the Anthropic Console.)

### Agent (`agents/<name>.yaml`)

```yaml
name: my-agent # unique within the workspace — this is the identity key
model:
  id: claude-sonnet-4-6
  speed: standard # standard | fast
description: short description
system: |-
  ... full system prompt ...
mcp_servers:
  - name: slack
    type: url
    url: https://mcp.slack.com/mcp
tools:
  - type: agent_toolset_20260401
    default_config:
      enabled: true
      permission_policy:
        type: always_allow
    configs: []
skills: []
metadata: {}
```

- **Identity**: the `name` field. `agent_id` lives in state, not YAML.
- **Diff**: deep-equal on `name` / `model` / `description` / `system` / `tools` / `mcp_servers` / `skills` / `multiagent` / `metadata`.
- **Delete**: present in state but missing locally ⇒ `archive` (reversible).
- Arrays (`tools`, `mcp_servers`, `skills`) are **fully replaced** — local is the source of truth.

See the [Anthropic Agent Setup docs](https://platform.claude.com/docs/en/managed-agents/agent-setup) for the full schema.

### Skill (`skills/<localName>/`)

Each skill is a **directory**. The Anthropic API uploads a folder containing `SKILL.md` plus any auxiliary files.

```
skills/<localName>/
├── SKILL.md            # required (YAML frontmatter + markdown body)
├── REFERENCE.md        # optional
└── scripts/
    └── helper.py       # optional
```

`SKILL.md` requires frontmatter:

```markdown
---
name: my-skill
description: What this skill does, and when Claude should use it.
---

# My Skill

...
```

- `name`: ≤64 chars, `[a-z0-9-]` only. `anthropic` / `claude` are reserved.
- `description`: ≤1024 chars.

cmaform computes a SHA-256 hash of the entire directory and compares it against the hash stored in state. If they differ, `apply` uploads a **new version** of the skill.

#### Referencing a skill from an agent

```yaml
# agents/foo.yaml
skills:
  - type: anthropic
    skill_id: xlsx # well-known Anthropic skills stay id-based
  - type: custom
    name: slack-mention-lookup # = local directory name under skills/
    version: latest # optional
```

The raw-ID form (`skill_id: skill_01XXXXXX`) is also accepted for `type: custom` — `name` and `skill_id` are interchangeable. See [Name-based references](#-name-based-references) below for resolution semantics.

> ⚠️ Skills cannot be archived. Deleting the directory and running `apply` permanently deletes the skill **and all of its versions**.

### 🔗 Name-based references

`multiagent.agents[]` and `skills[]` accept references by **logical name** in addition to raw IDs. Names are resolved at `plan` / `apply` time, so YAML can reference resources without committing any workspace-specific IDs.

```yaml
# agents/coordinator.yaml
multiagent:
  type: coordinator
  agents:
    - type: agent
      name: spec-qa # = the `name` field of agents/spec-qa.yaml
    - type: agent
      name: release-prep
      version: latest # optional
skills:
  - type: custom
    name: slack-mention-lookup # = the directory name under skills/
```

Resolution order for each name:

1. `cmaform.state.json` — if the resource is already tracked locally, use its ID.
2. Remote — `findAgentByName` / `findSkillByDisplayTitle` (cached per run).
3. Local apply set — if a YAML for that name exists locally **and** is being created in this run, the reference is treated as a **forward dependency**. cmaform substitutes a placeholder during plan and replaces it with the real ID right after the dependency is created.

If none of the above match, `plan` / `apply` fails with an error pointing at the unresolved name.

#### `pull` / `sync` write back in name form

When writing remote agents back to YAML, cmaform replaces any `id` / `skill_id` that resolves to a known local name with the name form. IDs for resources not tracked in state are kept as-is.

Pass `--by-id` to `pull` / `sync` to opt out of the rewrite and keep raw IDs in the written YAML.

#### Raw-ID form

`{ type: agent, id: agent_... }` and `{ type: custom, skill_id: skill_... }` are also accepted and behave identically to the name form.

If an entry writes **both** `name:` and `id:` (or `skill_id:`), cmaform resolves the name and asserts that it matches the pinned ID. Mismatches abort `plan` / `apply` with a clear error. This is useful as a safety net while migrating from id-based references — `cmaform fmt` can then drop the redundant raw IDs once everything verifies.

`type: anthropic` skills (well-known IDs like `xlsx`) always use the `skill_id` form. `type: self` agent references take neither.

### Memory Store (`memory_stores/<localName>/manifest.yaml`)

```yaml
name: my-store
description: optional
metadata:
  team: platform
```

- Diff fields: `name` / `description` / `metadata`.
- `metadata` is patched: keys missing locally are deleted, others are upserted.
- Delete = `archive` (one-way; the store's memory data is preserved).

### Environment (`environments/<localName>/manifest.yaml`)

```yaml
name: python-dev
description: optional
config:
  type: cloud
  packages:
    pip:
      - pandas
      - numpy==2.2.0
    npm:
      - express
  networking:
    type: limited
    allowed_hosts:
      - https://api.example.com
    allow_mcp_servers: true
    allow_package_managers: true
metadata: {}
```

- Diff fields: `name` / `description` / `metadata` / `config`.
- Only `config.type: cloud` is currently supported (self-hosted environments are out of scope).
- Empty package lists, `false` defaults in limited networking, and the server-side `type: 'packages'` marker are normalized away so the plan is idempotent.
- Delete = `archive`. Archived environments stop accepting new sessions but existing sessions keep working.

### Vault (`vaults/<localName>/`)

> **Status:** ⚠️ _Partial support — vault design is still evolving in cmaform._
>
> | Operation          | Supported by cmaform | Notes                                                                                                                                                                                                                                                |
> | ------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | Create vault       | ✅                   | New local manifest → vault is created on the server.                                                                                                                                                                                                 |
> | Archive vault      | ✅                   | Removing a local manifest archives the vault. Cascades server-side to attached credentials.                                                                                                                                                          |
> | Update vault       | ❌                   | Edits to `display_name` / `metadata` after creation are **silently ignored**. Archive and recreate to rename / relabel.                                                                                                                              |
> | Manage credentials | ❌                   | Credentials are not yet managed by cmaform — the secret-resolution design is still being settled. Use the [Anthropic Vault Credentials API](https://platform.claude.com/docs/en/managed-agents/credentials) directly to attach / rotate credentials. |
>
> The vault scope will be expanded (update, credential management with secret backends) in a future release.

A vault is a container that holds credentials for MCP servers. The local layout is intentionally minimal in this release:

```
vaults/
└── my-bot/
    └── manifest.yaml
```

**`manifest.yaml`** — the vault definition:

```yaml
display_name: my-bot
metadata:
  external_user_id: bot
```

### Deployment (`deployments/<localName>/manifest.yaml`)

A deployment binds an **agent** + **environment** + **initial events** + an optional **cron schedule** into one unit. The platform creates a session from the deployment on each schedule fire (and lets you trigger one on demand). This is how a managed agent runs on a schedule.

```yaml
name: nightly-triage # unique within the workspace
description: optional
# Reference an agent by name (resolved via state -> remote -> local apply set)
# or by raw id. Omit `version` to track the latest at create time, or pin one.
agent: release-prep
# agent:
#   name: release-prep
#   version: 6
environment: python-dev # environment name or env_... id
# Events sent to each session immediately after creation (1–50).
initial_events:
  - type: user.message
    content:
      - type: text
        text: Run the nightly triage.
# Optional. 5-field POSIX cron (minute hour day-of-month month day-of-week).
# Extended syntax (seconds/year, L W # ?, @daily) is NOT supported. Omit the
# whole block for an on-demand (manual-run) deployment.
schedule:
  type: cron
  expression: '0 9 * * 1-5' # 09:00 on weekdays
  timezone: Asia/Tokyo # IANA timezone
# Optional. Resources mounted into each session's container.
resources: []
# Optional. Vault names or vlt_... ids supplying stored credentials.
vault_ids: []
metadata: {}
```

- **Identity**: the `name` field. The `deployment_id` lives in state, not YAML.
- **Diff fields**: `name` / `description` / `agent` / `environment_id` / `initial_events` / `schedule` / `resources` / `vault_ids` / `metadata`.
- **References**: `agent` / `environment` / `vault_ids[]` accept logical **names** (resolved at plan/apply time, same rules as [Name-based references](#-name-based-references)) or raw ids. A name pointing at a resource being created in the **same apply run** is treated as a forward dependency — cmaform creates it first, then the deployment.
- **Agent version**: omit `version` to track the latest at create time (version drift is then ignored in the diff). Pin a `version` to detect and re-pin changes.
- **Delete**: present in state but missing locally ⇒ `archive` (one-way; the schedule stops firing).
- **Out of scope**: the imperative `pause` / `unpause` / `run` transitions are not modeled declaratively — `status` is treated as remote-owned. `resources` containing write-only credentials (e.g. a GitHub `authorization_token`) are sent on create/update but stripped before diffing, so they never appear as a permanent change.

See the [Anthropic Deployments docs](https://platform.claude.com/docs/en/managed-agents) for the full schema.

## 🗂️ Directory Layout

cmaform reads from **the current working directory** (or `CMAFORM_DIR` if set):

```
<cwd>/
├── agents/
│   └── *.yaml
├── skills/
│   └── <localName>/SKILL.md
├── memory_stores/
│   └── <localName>/manifest.yaml
├── environments/
│   └── <localName>/manifest.yaml
├── vaults/
│   └── <localName>/manifest.yaml
├── deployments/
│   └── <localName>/manifest.yaml
└── cmaform.state.json
```

## 🧾 State File (`cmaform.state.json`)

```json
{
  "agents": {
    "release-prep": { "id": "agent_01Qx...", "version": 6 }
  },
  "skills": {
    "slack-mention-lookup": {
      "id": "skill_013uPS...",
      "version": "1778647403232223",
      "hash": "7b8b14094e01...",
      "display_title": "slack-mention-lookup"
    }
  },
  "memory_stores": {
    "team-notes": { "id": "memstore_01...", "name": "team-notes" }
  },
  "environments": {
    "python-dev": { "id": "env_01...", "name": "python-dev" }
  },
  "vaults": {
    "my-bot": { "id": "vlt_01...", "display_name": "my-bot" }
  },
  "deployments": {
    "nightly-triage": { "id": "deploy_01...", "name": "nightly-triage" }
  }
}
```

- Maintained by `pull` / `apply` / `sync` / `init`.
- Recommended to `.gitignore` (treat as the local source of truth, like a Terraform state file).
- If someone shares a state file with you, run `cmaform sync` to regenerate the local YAML for every agent (skill bodies cannot be restored — see above).

## 🔐 Environment Variables

| Variable            | Required | Purpose                                |
| ------------------- | -------- | -------------------------------------- |
| `ANTHROPIC_API_KEY` | ✅       | Anthropic API authentication           |
| `CMAFORM_DIR`       |          | Config root directory (default: `cwd`) |

## ⚠️ Caveats

- Renaming an agent creates a **new** agent. To rename, delete the old YAML, run `apply` (archives the old one), then add the new YAML with the new name.
- Deleting a skill directory and running `apply` is **destructive** — there is no archive for skills.
- For full reproducibility, avoid making manual changes in the Anthropic Console. Always go through the YAML / `SKILL.md` / `manifest.yaml`.

## 🛠️ Development

```bash
mise install
pnpm install
pnpm dev -- --help     # run from source (tsx)
pnpm typecheck
pnpm build             # bundle to dist/cli.js via tsup
node dist/cli.js --help
```

## 📋 Requirements

- Node.js ≥ 22
- An Anthropic API key with access to the Claude Managed Agents and related Skills / Memory Stores / Environments / Vaults / Deployments beta APIs

## 📄 License

MIT
