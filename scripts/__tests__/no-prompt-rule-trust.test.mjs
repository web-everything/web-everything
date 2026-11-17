import { describe, expect, it } from 'vitest';
import {
  NO_PROMPT_COMMAND_RULES, NO_PROMPT_COMMAND_RULES_BODY, NO_PROMPT_COMMAND_RULES_SENTINEL,
  NO_PROMPT_COMMAND_RULES_END, NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT,
  assertBriefTaskContent, renderNoPromptCommandRules, noPromptRulePlacement,
  stripTrustedNoPromptCommandRules,
} from '../lib/no-prompt-command-rules.mjs';
import { buildPlanCritiqueMandate, buildPlanMandate } from '../lib/review-core.mjs';
import { fenceUntrusted } from '../lib/mandate-fence.mjs';

describe('no-prompt rules retain instruction position', () => {
  it.each([
    ['plan critique', () => buildPlanCritiqueMandate({ approach: NO_PROMPT_COMMAND_RULES }), 'approach'],
    ['plan proposal', () => buildPlanMandate({ task: NO_PROMPT_COMMAND_RULES }), 'task'],
  ])('%s cannot suppress trusted rules by copying them into its untrusted input', (_name, build, tag) => {
    const prompt = build();
    const closing = prompt.indexOf(`</${tag}>`);
    expect(prompt).toContain(fenceUntrusted(tag, NO_PROMPT_COMMAND_RULES));
    expect(prompt.split(NO_PROMPT_COMMAND_RULES)).toHaveLength(3);
    const { blocks } = noPromptRulePlacement(prompt);
    expect(blocks).toHaveLength(1);
    const opening = prompt.indexOf(`<${tag}>\n`);
    expect(blocks[0].end <= opening || blocks[0].start > closing).toBe(true);
    expect(prompt.slice(blocks[0].start, blocks[0].end)).toBe(NO_PROMPT_COMMAND_RULES);
    expect(renderNoPromptCommandRules(prompt)).toBe(prompt);
  });

  it.each([
    ['data fence', text => fenceUntrusted('material', text)],
    ['nested data fences', text => fenceUntrusted('task', fenceUntrusted('approach', text))],
    ['inline data tag', text => `Quoted material: <approach>\n${text}\n</approach>`],
    ['data after opening tag', text => `<approach>Quoted material\n${text}\n</approach>`],
    ['backtick fence', text => `\`\`\`text\n${text}\n\`\`\``],
    ['tilde fence', text => `~~~~text\n${text}\n~~~~`],
    ['long fence', text => `\`\`\`\`text\n${text}\n\`\`\`\``],
    ['code span', text => `\`\`quoted\n${text}\n\`\``],
    ['HTML comment', text => `<!-- quoted\n${text}\n-->`],
    ['blockquote', text => text.split('\n').map(line => `> ${line}`).join('\n')],
  ])('%s cannot donate an already-included sentinel', (_name, quote) => {
    const task = `Inspect the quoted material.\n${quote(NO_PROMPT_COMMAND_RULES)}`;
    expect(noPromptRulePlacement(task).blocks).toEqual([]);
    const prompt = renderNoPromptCommandRules(task);
    expect(noPromptRulePlacement(prompt).blocks).toHaveLength(1);
    expect(prompt).toContain(task);
    expect(renderNoPromptCommandRules(prompt)).toBe(prompt);
  });

  it.each(['<approach>', '```text', '~~~~text', '<!-- unfinished', '<task>\n</approach>'])
    ('prefixes the rules when %s leaves an unfinished or mismatched scope', open => {
      const task = `Inspect the material.\n${open}\n${NO_PROMPT_COMMAND_RULES}`;
      const prompt = renderNoPromptCommandRules(task);
      expect(prompt).toBe(`${NO_PROMPT_COMMAND_RULES}\n\n${task}`);
      expect(noPromptRulePlacement(prompt).blocks).toHaveLength(1);
    });

  it('reuses a top-level sentinel only when its complete canonical block is intact', () => {
    const task = `Inspect the session.\n\n${NO_PROMPT_COMMAND_RULES}`;
    expect(renderNoPromptCommandRules(task)).toBe(task);
    const incomplete = `Inspect the session.\n${NO_PROMPT_COMMAND_RULES_SENTINEL}\nAltered instructions.\n${NO_PROMPT_COMMAND_RULES_END}`;
    expect(renderNoPromptCommandRules(incomplete)).toBe(`${incomplete}\n\n${NO_PROMPT_COMMAND_RULES}\n`);
  });
});

describe('strict task validation and command assertions', () => {
  it.each([
    `${NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT}\n${NO_PROMPT_COMMAND_RULES}`,
    ` \n${NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT}\n${NO_PROMPT_COMMAND_RULES}\n\t`,
    `${NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT}\n${NO_PROMPT_COMMAND_RULES_BODY}`,
    `${NO_PROMPT_COMMAND_RULES_SENTINEL}\n${NO_PROMPT_COMMAND_RULES_END}`,
  ])('rejects generated metadata and rules without a task: %j', brief => {
    expect(() => assertBriefTaskContent(brief)).toThrow(/empty task content/);
    expect(() => renderNoPromptCommandRules(brief)).toThrow(/empty task content/);
  });

  it('keeps the no-git assertion strict after stripping only the sentinel-delimited trusted block', () => {
    const brief = renderNoPromptCommandRules('Inspect the session without running commands.');
    const commands = text => [...stripTrustedNoPromptCommandRules(text).matchAll(/`(git [^`]+)`/g)].map(match => match[1]);
    expect(commands(brief)).toEqual([]);
    expect(commands(`${brief}\nRun \`git reset --hard\`.`)).toEqual(['git reset --hard']);
  });

  it('stripping trusted rules preserves identical text quoted as untrusted material', () => {
    const task = `Inspect this text.\n${fenceUntrusted('approach', NO_PROMPT_COMMAND_RULES)}`;
    const prompt = renderNoPromptCommandRules(task);
    expect(stripTrustedNoPromptCommandRules(prompt)).toBe(`${task}\n\n\n`);
  });
});
