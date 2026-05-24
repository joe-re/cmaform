# cmaform examples

A minimal sample config. Point `CMAFORM_DIR` at this directory to try `cmaform plan` immediately.

```sh
cd /path/to/cmaform
export ANTHROPIC_API_KEY=sk-ant-...
CMAFORM_DIR=$(pwd)/examples npx cmaform plan
```

Contents:

- `agents/hello.yaml` — a simple greeting agent
- `skills/hello-skill/SKILL.md` — a minimal skill (frontmatter + body only)
- `memory_stores/hello-store/manifest.yaml` — a minimal memory store

Note: running `apply` against this config will actually write to the Anthropic API.
