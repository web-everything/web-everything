import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_PROMPT_COMMAND_RULES } from '../lib/no-prompt-command-rules.mjs';
import { renderWorkerBrief } from '../worker-brief.mjs';
import { readCiHealBriefTemplate } from '../operations/ci-heal-pr-dispatch.mjs';
import { buildAgentArgv } from '../operations/dispatch-lane-io.mjs';
import { buildJudgeArgv, deriveSessionId } from '../lib/judge-spawn.mjs';
import { resumeArgvFrom } from '../operations/worker-wrapper.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function expectBlock(text) {
  expect(text).toContain(NO_PROMPT_COMMAND_RULES);
  expect(text.slice(0, NO_PROMPT_COMMAND_RULES.length + 2)).toBe(`${NO_PROMPT_COMMAND_RULES}\n\n`);
}

describe('no-prompt command rules', () => {
  it('carries every approval-avoidance restriction without branch or raw kill instructions', () => {
    for (const rule of ['no `$(...)`', 'no shell variables or arrays', 'no loops', 'no trailing `&`',
      'Edit/Write tools', '`sed -i`', '`perl -i`', 'redirect writes', '`rm -rf` / `rm -r`',
      'NEW uniquely named dir', 'destructive history or working-tree resets', 'forced pushes', 'cleans',
      'TaskStop', '`pkill`/`killall`']) {
      expect(NO_PROMPT_COMMAND_RULES).toContain(rule);
    }
    expect(NO_PROMPT_COMMAND_RULES).not.toMatch(/`git |fetch|merge|HEAD:refs|`kill /);
  });

  it('includes the complete block in a rendered worker brief', () => {
    expectBlock(renderWorkerBrief({ purpose: 'command-rules', files: ['scripts/example.mjs'], owner: 'rules-test' }));
  });

  it('includes the shared block in the real ci-heal brief after packing', () => {
    expectBlock(readCiHealBriefTemplate(ROOT, template => `Packed context\n${template}`));
  });

  it('covers fresh and resumed daemon launches at the argv boundary', () => {
    for (const resumeSessionId of [null, 'resumed-session']) {
      const argv = buildAgentArgv({ sessionId: 'session', resumeSessionId,
        payload: { prompt: 'Task', sessionSlug: 'command-rules' }, extraArgs: ['--model', 'sonnet'] });
      expectBlock(argv.at(-1));
    }
    expectBlock(resumeArgvFrom(['-p', '--session-id', 'session', 'old task'], { sessionId: 'session', prompt: 'Resume task' }).at(-1));
  });

  it('covers tool-free and tool-bearing Claude judge mandates', () => {
    for (const allowedTools of [null, ['Read']]) {
      const argv = buildJudgeArgv({ mandate: 'Review task', shape: { type: 'object', properties: {} },
        sessionId: deriveSessionId('command-rules'), allowedTools });
      expectBlock(argv[argv.indexOf('--append-system-prompt') + 1]);
    }
  });

  it('keeps the shared command rules classified as prose-only in the ledger', () => {
    const ledger = JSON.parse(readFileSync(join(ROOT, 'skills-src/conveyor/brief-rule-ledger.json'), 'utf8'));
    expect(ledger.rules.find(rule => rule.id === 'no-prompt-command-rules').status).toBe('prose-only');
  });
});
