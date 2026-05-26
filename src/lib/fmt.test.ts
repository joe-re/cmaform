import { describe, expect, it } from 'vitest';

import { rewriteYamlRefsToNameForm } from './fmt.js';

const state = {
  agents: {
    'spec-qa': { id: 'agent_01NgjvpMaL3DjdtDNEmYxi6c', version: 1 },
    'release-prep': { id: 'agent_01QxBzWghACeAzLtk321id1Z', version: 1 },
  },
  skills: {
    'slack-mention-lookup': {
      id: 'skill_013uPS15B3Kw82NpjH4uNQep',
      version: 'v1',
      hash: 'h',
      display_title: 'slack-mention-lookup',
    },
  },
};

describe('rewriteYamlRefsToNameForm', () => {
  it('rewrites multiagent.agents[].id to name and counts each rewrite', () => {
    const input = `multiagent:
  type: coordinator
  agents:
    - type: agent
      id: agent_01NgjvpMaL3DjdtDNEmYxi6c
    - type: agent
      id: agent_01QxBzWghACeAzLtk321id1Z
`;
    const { text, changed } = rewriteYamlRefsToNameForm(input, state);
    expect(changed).toBe(2);
    expect(text).toContain('      name: spec-qa\n');
    expect(text).toContain('      name: release-prep\n');
    expect(text).not.toContain('agent_01');
  });

  it('rewrites skills[].skill_id to name', () => {
    const input = `skills:
  - type: custom
    skill_id: skill_013uPS15B3Kw82NpjH4uNQep
    version: latest
`;
    const { text, changed } = rewriteYamlRefsToNameForm(input, state);
    expect(changed).toBe(1);
    expect(text).toContain('    name: slack-mention-lookup\n');
    expect(text).toContain('    version: latest\n');
  });

  it('leaves IDs that are not tracked in state untouched (e.g. placeholders)', () => {
    const input = `multiagent:
  agents:
    - type: agent
      id: agent_PLACEHOLDER_GITHUB_COORDINATOR
`;
    const { text, changed } = rewriteYamlRefsToNameForm(input, state);
    expect(changed).toBe(0);
    expect(text).toBe(input);
  });

  it('preserves entry-leading and inline comments on the rewritten line', () => {
    const input = `multiagent:
  agents:
    # spec-qa: 仕様確認用 sub-agent
    - type: agent
      id: agent_01NgjvpMaL3DjdtDNEmYxi6c  # spec-qa の ID
`;
    const { text } = rewriteYamlRefsToNameForm(input, state);
    expect(text).toContain('    # spec-qa: 仕様確認用 sub-agent\n');
    expect(text).toContain('      name: spec-qa  # spec-qa の ID\n');
  });

  it('does not rewrap folded (>-) scalars or other long strings', () => {
    // A folded scalar with a user-authored line break: nothing on this scalar
    // should change after fmt, even though the file overall is being rewritten.
    const input = `name: sample
description: >-
  Slack スレッドに、与えられた \`text\` をそのまま投稿する。
  tool result には投稿された Slack メッセージの permalink が含まれる
  想定で、coordinator は必要に応じて後続のステップで利用する。
multiagent:
  agents:
    - type: agent
      id: agent_01NgjvpMaL3DjdtDNEmYxi6c
`;
    const { text, changed } = rewriteYamlRefsToNameForm(input, state);
    expect(changed).toBe(1);
    // The description block must be byte-identical.
    expect(text).toContain(
      `description: >-
  Slack スレッドに、与えられた \`text\` をそのまま投稿する。
  tool result には投稿された Slack メッセージの permalink が含まれる
  想定で、coordinator は必要に応じて後続のステップで利用する。
`
    );
  });

  it('handles quoted ids ("…" / \'…\') and preserves the quote style as a no-op match', () => {
    // The regex tolerates surrounding quotes but doesn't re-quote the
    // replacement (name forms are bare). Important: a quoted form should
    // still match and rewrite.
    const input = `multiagent:
  agents:
    - type: agent
      id: 'agent_01NgjvpMaL3DjdtDNEmYxi6c'
    - type: agent
      id: "agent_01QxBzWghACeAzLtk321id1Z"
`;
    const { text, changed } = rewriteYamlRefsToNameForm(input, state);
    expect(changed).toBe(2);
    expect(text).toContain('      name: spec-qa\n');
    expect(text).toContain('      name: release-prep\n');
  });

  it('returns the input unchanged when there is nothing to rewrite', () => {
    const input = `name: sample
model: claude-sonnet-4-6
`;
    const { text, changed } = rewriteYamlRefsToNameForm(input, state);
    expect(changed).toBe(0);
    expect(text).toBe(input);
  });

  it('does not touch the model.id field (different YAML key, different value shape)', () => {
    // Sanity check: `id: claude-sonnet-4-6` under model: should not match our
    // agent-ID regex (which is anchored on the exact agent_… value).
    const input = `model:
  id: claude-sonnet-4-6
  speed: standard
multiagent:
  agents:
    - type: agent
      id: agent_01NgjvpMaL3DjdtDNEmYxi6c
`;
    const { text, changed } = rewriteYamlRefsToNameForm(input, state);
    expect(changed).toBe(1);
    expect(text).toContain('  id: claude-sonnet-4-6\n');
    expect(text).toContain('      name: spec-qa\n');
  });
});
