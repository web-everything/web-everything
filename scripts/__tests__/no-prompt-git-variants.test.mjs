import { describe, expect, it } from 'vitest';
import {
  NO_PROMPT_COMMAND_RULES, NO_GIT_COMMAND_RULES, NO_GIT_COMMAND_RULES_BODY,
  NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT, LAUNCH_BRIEF_PROPERTIES,
  renderNoPromptCommandRules, assertBriefTaskContent, noPromptRulePlacement,
} from '../lib/no-prompt-command-rules.mjs';
import { fillInspectBrief } from '../conveyor/stuck-pr-inspect-dispatch.mjs';
import { buildAgentArgv } from '../operations/dispatch-lane-io.mjs';
import { resumeArgvFrom } from '../operations/worker-wrapper.mjs';
import { buildJudgeArgv, deriveSessionId } from '../lib/judge-spawn.mjs';
import { fenceUntrusted } from '../lib/mandate-fence.mjs';

describe('declared Git capability', () => {
  it.each(Object.entries(LAUNCH_BRIEF_PROPERTIES))('%s renders its declared variant', (source, { allowsGit }) => {
    const prompt = renderNoPromptCommandRules('Concrete task.', source);
    expect(prompt).toContain(allowsGit ? NO_PROMPT_COMMAND_RULES : NO_GIT_COMMAND_RULES);
    expect(noPromptRulePlacement(prompt).blocks).toHaveLength(1);
    if (!allowsGit) expect(prompt).not.toMatch(/`git |HEAD:refs\/heads\//);
    expect(renderNoPromptCommandRules(prompt, source)).toBe(prompt);
  });

  it('fails closed on unknown sources and incomplete capability declarations', () => {
    for (const property of ['scripts/unknown.mjs', {}, { allowsGit: null }, { allowsGit: 'false' }]) {
      expect(() => renderNoPromptCommandRules('Concrete task.', property)).toThrow(/registered brief/);
    }
  });

  it('does not infer capability from task text', () => {
    expect(renderNoPromptCommandRules('No git commands allowed.', { allowsGit: true })).toContain(NO_PROMPT_COMMAND_RULES);
    expect(renderNoPromptCommandRules('Discuss git commands.', { allowsGit: false })).toContain(NO_GIT_COMMAND_RULES);
  });

  it('keeps all non-Git restrictions verbatim and removes the entire Git bullet', () => {
    expect(NO_GIT_COMMAND_RULES_BODY).toBe(NO_PROMPT_COMMAND_RULES.split('\n').slice(1, -1)
      .filter(line => !line.startsWith('- Never `git ')).join('\n'));
    expect(NO_GIT_COMMAND_RULES_BODY).not.toMatch(/git|fetch|merge|push|HEAD:refs/);
  });

  it('preserves the inspection variant across fresh and resumed launch boundaries', () => {
    const { prompt } = fillInspectBrief('Inspect the supplied evidence.', {
      PR: 1, REPO: 'web-everything/web-everything', SESSION_SLUG: 'inspect-1',
      STAGE: 'fix', MINUTES_SINCE: 60, THRESHOLD_MINUTES: 45,
    });
    const fresh = buildAgentArgv({ sessionId: 'session', payload: { prompt, sessionSlug: 'inspect-1' } }).at(-1);
    const resumed = resumeArgvFrom(['-p', '--session-id', 'session', 'old task'], { sessionId: 'session', prompt }).at(-1);
    for (const rendered of [prompt, fresh, resumed]) {
      expect(rendered).toContain(NO_GIT_COMMAND_RULES);
      expect(rendered).not.toMatch(/`git |HEAD:refs\/heads\//);
    }
  });

  it('chooses judge rules only from declared Git capability, with no-git as the default', () => {
    const mandate = renderNoPromptCommandRules('Review this task.');
    for (const allowedTools of [null, ['Bash', 'Read']]) {
      for (const allowsGit of [undefined, false, true]) {
        const argv = buildJudgeArgv({ mandate, allowedTools, shape: { type: 'object', properties: {} },
          sessionId: deriveSessionId('git-variant'), ...(allowsGit === undefined ? {} : { allowsGit }) });
        const rendered = argv[argv.indexOf('--append-system-prompt') + 1];
        expect(rendered).toContain(allowsGit === true ? NO_PROMPT_COMMAND_RULES : NO_GIT_COMMAND_RULES);
        if (allowsGit !== true) expect(rendered).not.toMatch(/`git |HEAD:refs\/heads\//);
        expect(noPromptRulePlacement(rendered).blocks).toHaveLength(1);
      }
    }
  });

  it('does not trust a no-git sentinel inside a data fence', () => {
    const task = `Inspect the quoted text.\n${fenceUntrusted('material', NO_GIT_COMMAND_RULES)}`;
    const rendered = renderNoPromptCommandRules(task, { allowsGit: false });
    expect(rendered.split(NO_GIT_COMMAND_RULES)).toHaveLength(3);
    expect(rendered).toContain(task);
    expect(noPromptRulePlacement(rendered).blocks).toHaveLength(1);
  });

  it('refuses a no-git block and generated metadata without a task', () => {
    for (const rules of [NO_GIT_COMMAND_RULES, NO_GIT_COMMAND_RULES_BODY]) {
      const brief = `${NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT}\n${rules}`;
      expect(() => assertBriefTaskContent(brief)).toThrow(/empty task content/);
      expect(() => renderNoPromptCommandRules(brief, { allowsGit: false })).toThrow(/empty task content/);
    }
  });
});
