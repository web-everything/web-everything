import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_PROMPT_COMMAND_RULES } from '../lib/no-prompt-command-rules.mjs';
import { readCiHealBriefTemplate } from '../operations/ci-heal-pr-dispatch.mjs';
import { readFixBriefTemplate } from '../conveyor/reconcile-fix-dispatch.mjs';
import { buildMandate, buildPlanCritiqueMandate } from '../lib/review-core.mjs';
import { buildRedTeamTask } from '../operations/review-extra-seats.mjs';
import { NO_PROMPT_SESSION_KINDS, renderNoPromptCommandRules } from '../lib/no-prompt-command-rules.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function expectBlock(text) {
  expect(text.startsWith(`${NO_PROMPT_COMMAND_RULES}\n\n`)).toBe(true);
  expect(text.split(NO_PROMPT_COMMAND_RULES)).toHaveLength(2);
}

describe('no-prompt command rules scope', () => {
  it('opts in only the four session kinds observed prompting the operator', () => {
    expect(NO_PROMPT_SESSION_KINDS).toEqual(['fix', 'ci-heal', 'review-job', 'red-team']);
    for (const kind of NO_PROMPT_SESSION_KINDS) expectBlock(renderNoPromptCommandRules('Task', kind));
    for (const kind of [undefined, 'build', 'jury', 'judge', 'explore', 'prepare', 'worker', 'operator-task']) {
      expect(renderNoPromptCommandRules('Task', kind)).toBe('Task');
      expect(renderNoPromptCommandRules('', kind)).toBe('');
    }
  });
  it('injects once after packing the real fixer and ci-heal templates', () => {
    for (const read of [readFixBriefTemplate, readCiHealBriefTemplate]) {
      expectBlock(renderNoPromptCommandRules(read(ROOT, template => `Packed context\n${template}`), read === readFixBriefTemplate ? 'fix' : 'ci-heal'));
    }
  });
  it('injects into review-job and red-team prompts', () => {
    expectBlock(buildMandate());
    expectBlock(buildRedTeamTask({ repo: 'fixture/repo', pr: 7, inline: { body: '', diffText: '' } }));
    expect(buildPlanCritiqueMandate()).not.toContain(NO_PROMPT_COMMAND_RULES);
  });
});
