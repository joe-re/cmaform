import { describe, expect, it } from 'vitest';

import type { Action } from './plan.js';
import type { ResolvedConfig } from './resolve.js';
import { attachDanglingReferenceWarnings, hasDanglingWarnings } from './warnings.js';

function resolved(config: ResolvedConfig['config']): ResolvedConfig {
  return {
    config,
    forwardAgentDeps: [],
    forwardSkillDeps: [],
    missingAgentRefs: [],
    missingSkillRefs: [],
    latestAgentVersionRefs: [],
    idMismatches: [],
  };
}

describe('attachDanglingReferenceWarnings', () => {
  it('attaches warnings when deleting a skill still referenced by an agent', () => {
    const actions: Action[] = [{ type: 'skill_delete', localName: 'skill-a', id: 'skill_1' }];
    const resolutions = new Map([
      [
        'agent-a',
        resolved({
          name: 'agent-a',
          skills: [
            { type: 'custom', skill_id: 'skill_other' },
            { type: 'custom', skill_id: 'skill_1' },
          ],
        }),
      ],
    ]);

    attachDanglingReferenceWarnings(actions, resolutions);

    expect(actions[0]).toMatchObject({
      warnings: [{ referrer: 'agent-a', fieldPath: 'skills[1]' }],
    });
    expect(hasDanglingWarnings(actions)).toBe(true);
  });

  it('attaches warnings when deleting an agent still referenced by a coordinator', () => {
    const actions: Action[] = [{ type: 'delete', name: 'child-agent', id: 'agent_child' }];
    const resolutions = new Map([
      [
        'coordinator',
        resolved({
          name: 'coordinator',
          multiagent: {
            type: 'coordinator',
            agents: [
              { type: 'agent', id: 'agent_other' },
              { type: 'agent', id: 'agent_child' },
            ],
          },
        }),
      ],
    ]);

    attachDanglingReferenceWarnings(actions, resolutions);

    expect(actions[0]).toMatchObject({
      warnings: [{ referrer: 'coordinator', fieldPath: 'multiagent.agents[1]' }],
    });
    expect(hasDanglingWarnings(actions)).toBe(true);
  });

  it('leaves delete actions untouched when there are no dangling refs', () => {
    const actions: Action[] = [{ type: 'skill_delete', localName: 'skill-a', id: 'skill_1' }];

    attachDanglingReferenceWarnings(
      actions,
      new Map([['agent-a', resolved({ name: 'agent-a', skills: [] })]]),
    );

    expect(actions[0]).not.toHaveProperty('warnings');
    expect(hasDanglingWarnings(actions)).toBe(false);
  });
});
