# cmaform examples

A minimal sample config covering every resource type. Point `CMAFORM_DIR` at this directory to try `cmaform plan` immediately.

```sh
cd /path/to/cmaform
export ANTHROPIC_API_KEY=sk-ant-...
CMAFORM_DIR=$(pwd)/examples npx cmaform plan
```

Contents:

- `agents/hello.yaml` — a simple greeting agent
- `skills/hello-skill/SKILL.md` — a minimal skill (frontmatter + body only)
- `memory_stores/hello-store/manifest.yaml` — a minimal memory store
- `environments/hello-env/manifest.yaml` — a minimal cloud environment
- `vaults/hello-vault/manifest.yaml` — a minimal vault (cmaform manages vault create + archive only; credentials are out of scope for now)
- `deployments/hello-deployment/manifest.yaml` — a scheduled (cron) deployment that runs the `hello` agent in `hello-env`

> Warning: running `cmaform apply` against these examples will create real resources in your Anthropic workspace using the literal names `hello`, `hello-skill`, `hello-store`, `hello-env`, `hello-vault`, `hello-deployment`. Apply only against a workspace you control, and unset / rename the examples before pointing cmaform at your real config.
