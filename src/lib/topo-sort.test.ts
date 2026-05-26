import { describe, expect, it } from 'vitest';

import type { Action } from './plan.js';
import { actionId, topoSortActions } from './topo-sort.js';

function createAgent(
  name: string,
  forwardAgentDeps: string[] = [],
  forwardSkillDeps: string[] = [],
): Action {
  return {
    type: 'create',
    name,
    config: { name },
    filePath: `agents/${name}.yaml`,
    forwardAgentDeps,
    forwardSkillDeps,
  };
}

function createSkill(localName: string): Action {
  return {
    type: 'skill_create',
    localName,
    skill: {
      localName,
      dirPath: `skills/${localName}`,
      skillName: localName,
      description: `${localName} description`,
      displayTitle: localName,
      hash: `${localName}-hash`,
      files: ['SKILL.md'],
    },
  };
}

function names(actions: Action[]): string[] {
  return actions.map(actionId);
}

describe('topoSortActions', () => {
  it('places a dependency-target action before its dependent (sub-agent → coordinator)', () => {
    const coordinator = createAgent('chat-coordinator', ['spec-qa']);
    const subAgent = createAgent('spec-qa');
    const sorted = topoSortActions([coordinator, subAgent]);
    expect(names(sorted)).toEqual(['agent:spec-qa', 'agent:chat-coordinator']);
  });

  it('places skill_create before any agent that forward-depends on it', () => {
    const agent = createAgent('uses-skill', [], ['my-skill']);
    const skill = createSkill('my-skill');
    const sorted = topoSortActions([agent, skill]);
    expect(names(sorted)).toEqual(['skill:my-skill', 'agent:uses-skill']);
  });

  it('throws on a dependency cycle', () => {
    const a = createAgent('A', ['B']);
    const b = createAgent('B', ['A']);
    expect(() => topoSortActions([a, b])).toThrow(/cycle/i);
  });

  it('ignores forward deps that point outside the action set (already-resolved refs)', () => {
    // `unrelated` references an agent that is NOT in this action set — that
    // means it has already been resolved to a real id via state/remote and
    // does not need ordering.
    const lone = createAgent('unrelated', ['already-deployed-elsewhere']);
    const sorted = topoSortActions([lone]);
    expect(names(sorted)).toEqual(['agent:unrelated']);
  });

  it('is stable for independent actions (preserves the original ordering)', () => {
    const a = createAgent('A');
    const b = createAgent('B');
    const c = createAgent('C');
    const sorted = topoSortActions([a, b, c]);
    expect(names(sorted)).toEqual(['agent:A', 'agent:B', 'agent:C']);
  });

  it('handles a transitive chain (C → B → A)', () => {
    const a = createAgent('A');
    const b = createAgent('B', ['A']);
    const c = createAgent('C', ['B']);
    // Provide them in reverse order to exercise the sort.
    const sorted = topoSortActions([c, b, a]);
    expect(names(sorted)).toEqual(['agent:A', 'agent:B', 'agent:C']);
  });
});
