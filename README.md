<h1 align="center">cmaform</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/cmaform"><img src="https://img.shields.io/npm/v/cmaform.svg" alt="npm version"></a>
  <a href="https://github.com/joe-re/cmaform/actions/workflows/ci.yml"><img src="https://github.com/joe-re/cmaform/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/cmaform.svg" alt="License: MIT"></a>
</p>

<p align="center">
  English | <a href="./README.ja.md">日本語</a>
</p>

**cmaform** is a Terraform-style CLI for managing **Anthropic Managed Agents, Skills, and Memory Stores** as files in your repo. You declare each resource as a YAML file, run `cmaform plan` to see what will change, and `cmaform apply` to ship it.

```text
  [~] update agent  "release-prep" (id=agent_01Qx..., version=6)
       file: agents/release-prep.yaml
       ~ system:
           ... (12 unchanged lines)
         - 既存ロジック...
         + 改修ロジック...
           ... (8 unchanged lines)
  [+] create skill  "spec-lookup"
       dir:  skills/spec-lookup
       hash: 7b8b14094e01...

Plan (agents):        0 to add, 1 to change, 0 to archive, 5 unchanged.
Plan (skills):        1 to add, 0 to change, 0 to delete, 0 unchanged.
Plan (memory_stores): 0 to add, 0 to change, 0 to archive, 0 unchanged.
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

> Anthropic's Managed Agent / Skills / Memory Stores APIs are currently **beta**. cmaform calls `@anthropic-ai/sdk`'s `beta.agents.*` / `beta.skills.*` / `beta.memoryStores.*` endpoints directly.

## 🚀 Usage

### Commands

| Command | What it does |
| --- | --- |
| `cmaform pull <id>` | Import a remote resource by ID (`agent_*` / `skill_*` / `memstore_*`) into local files + state |
| `cmaform plan [target...]` | Diff local YAML / state / remote and print a Terraform-style plan |
| `cmaform apply [--yes\|-y] [target...]` | Show plan, prompt for confirmation, apply, save state |
| `cmaform sync` | Re-fetch every entry in state from remote and rewrite local YAML |
| `cmaform init` | Initialize / reconcile the state file against remote (no remote writes; spirit of `terraform init`) |
| `cmaform list` | Show local files / state / remote side-by-side |

### Filtering plan / apply

The last positional arguments to `plan` and `apply` are targets. A target can be a **resource kind** or an **individual resource name** — useful for staged rollouts (e.g. create a skill first, copy its `skill_id` into an agent YAML, then apply the agent).

```bash
cmaform apply skills                     # all skills
cmaform apply agents                     # all agents
cmaform apply slack-mention-lookup       # a single skill by name
cmaform apply release-prep --yes         # a single agent, skip confirmation
cmaform apply skills release-prep        # all skills + one agent
```

Kind aliases: `agent` / `agents` / `skill` / `skills` / `memory_store` / `memory_stores` / `memstore` / `memstores`.

If you pass an individual name that doesn't exist anywhere (local YAML, state, or remote), cmaform exits with code `2`. An unmatched kind is fine — it just shows `0 to add, 0 to change, ...`.

### Pulling existing resources

```bash
cmaform pull agent_011CaSWcCrMdQdp4SA6TVdH6   # writes agents/<name>.yaml
cmaform pull skill_013uPS15B3Kw82NpjH4uNQep   # state only — SKILL.md is not regenerated
cmaform pull memstore_01ABC...                # writes memory_stores/<name>/manifest.yaml
```

Skill content is **not** returned by the Anthropic API once uploaded, so `pull` for skills only records the ID + version + display title into state. The local `SKILL.md` must be authored by you.

## 📦 Resources

cmaform manages three resource types. Each lives in its own subdirectory under the config root.

### Agent (`agents/<name>.yaml`)

```yaml
name: my-agent              # unique within the workspace — this is the identity key
model:
  id: claude-sonnet-4-6
  speed: standard           # standard | fast
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
    skill_id: xlsx
  - type: custom
    skill_id: skill_01XXXXXX         # copy from state.skills[<localName>].id after apply
    version: latest
```

> ⚠️ Skills have no archive concept. Deleting the directory and running `apply` permanently deletes the skill **and all of its versions**.

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
  }
}
```

- Maintained by `pull` / `apply` / `sync` / `init`.
- Recommended to `.gitignore` (treat as the local source of truth, like a Terraform state file).
- If someone shares a state file with you, run `cmaform sync` to regenerate the local YAML for every agent (skill bodies cannot be restored — see above).

## 🔐 Environment Variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API authentication |
| `CMAFORM_DIR` | | Config root directory (default: `cwd`) |

## ⚠️ Caveats

- Renaming an agent creates a **new** agent. To rename, delete the old YAML, run `apply` (archives the old one), then add the new YAML with the new name.
- Deleting a skill directory and running `apply` is **destructive** — there is no archive for skills.
- For full reproducibility, avoid making manual changes in the Anthropic Console. Always go through the YAML / `SKILL.md` / `manifest.yaml`.

## 🛠️ Development

```bash
pnpm install
pnpm dev -- --help     # run from source (tsx)
pnpm typecheck
pnpm build             # bundle to dist/cli.js via tsup
node dist/cli.js --help
```

## 🏗️ Architecture

- **CLI**: single-file Node.js script (~2.2k LOC). Subcommands are dispatched in `src/cli.ts`.
- **SDK**: `@anthropic-ai/sdk` (`beta.agents.*` / `beta.skills.*` / `beta.memoryStores.*`).
- **Skill upload**: SDK is used for the initial create. For version updates, cmaform posts `multipart/form-data` directly via `fetch` to preserve the `<skillName>/<rel>` filename prefix that the API requires.
- **Diff rendering**: LCS-based line diff with 2-line context windows and ANSI colors when the output is a TTY.
- **Build**: `tsup` → single ESM bundle with a `#!/usr/bin/env node` shebang.

## 📋 Requirements

- Node.js ≥ 22
- An Anthropic API key with access to the Managed Agent / Skills / Memory Stores beta

## 📄 License

MIT
