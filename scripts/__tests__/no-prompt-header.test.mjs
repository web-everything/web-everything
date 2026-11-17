import { describe, expect, it } from 'vitest';
import { NO_PROMPT_COMMAND_RULES, assertBriefTaskContent, renderNoPromptCommandRules } from '../lib/no-prompt-command-rules.mjs';

describe('R115 unconditional command-rules header', () => {
  it.each([
    ['ordinary task', 'Inspect the supplied evidence.'],
    ['canonical block as task', NO_PROMPT_COMMAND_RULES],
    ['fenced copy', `Inspect this data.\n\`\`\`text\n${NO_PROMPT_COMMAND_RULES}\n\`\`\``],
    ['PRE copy', `Inspect this data.\n<PRE>\n${NO_PROMPT_COMMAND_RULES}\n</PRE>`],
    ['CRLF copy', NO_PROMPT_COMMAND_RULES.replaceAll('\n', '\r\n')],
    ['unclosed fence', `Inspect this data.\n<approach>\n${NO_PROMPT_COMMAND_RULES}`],
    ['two closers', `Inspect this data.\n</task>\n${NO_PROMPT_COMMAND_RULES}\n</task>`],
  ])('injects exactly one owned header before %s without inspecting or rewriting it', (_name, task) => {
    const header = `${NO_PROMPT_COMMAND_RULES}\n\n`;
    const prompt = renderNoPromptCommandRules(task);
    expect(prompt).toBe(header + task);
    expect(prompt.slice(0, header.length).split(NO_PROMPT_COMMAND_RULES)).toHaveLength(2);
    expect(prompt.slice(header.length)).toBe(task);
    expect(assertBriefTaskContent(task)).toBe(task);
  });

  it.each(['', ' ', '\n', '\r', '\r\n', ' \t\r\n'])('refuses whitespace-only task %j before adding the header', task => {
    expect(() => renderNoPromptCommandRules(task)).toThrow(/empty task content/);
  });
});
