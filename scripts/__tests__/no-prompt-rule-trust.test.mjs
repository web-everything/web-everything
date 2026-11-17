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

  it.each([
    ['<PRE>', '</PRE>'],
    ['<Pre>', '</pRE >'],
    ['<pre class="x" >', '</PRE >'],
    ['<CoDe data-kind="quoted" >', '</cOdE   >'],
    ['<MaTeRiAl class="x">', '</mAtErIaL >'],
    ['<CuStOm data-kind="quoted" >', '</CUSTOM >'],
    ['<custom-fence class="x" >', '</CUSTOM-FENCE >'],
    ['<custom:material class="x" >', '</CUSTOM:MATERIAL >'],
  ])('does not trust rules inside %s with a case/attribute/whitespace-varied closer', (opening, closing) => {
    const task = `Inspect the quoted material.\n${opening}\n${NO_PROMPT_COMMAND_RULES}\n${closing}`;
    expect(noPromptRulePlacement(task).blocks).toEqual([]);
    const prompt = renderNoPromptCommandRules(task);
    const { blocks } = noPromptRulePlacement(prompt);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].start).toBeGreaterThan(prompt.indexOf(closing));
    expect(stripTrustedNoPromptCommandRules(prompt)).toContain(task);
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

describe('line endings and policy whitespace', () => {
  const formats = [
    ['CRLF', text => text.replaceAll('\n', '\r\n')],
    ['CR', text => text.replaceAll('\n', '\r')],
    ['trailing whitespace', text => text.split('\n').map(line => `${line} \t`).join('\n')],
    ['varied whitespace', text => text.replaceAll(' ', ' \t ').split('\n').map(line => `${line} \t`).join('\r\n')],
  ];

  it.each(formats)('refuses %s rules and generated comments without a task', (_name, format) => {
    for (const rules of [NO_PROMPT_COMMAND_RULES, NO_PROMPT_COMMAND_RULES_BODY]) {
      const brief = format(`${NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT}\n${rules}`);
      expect(() => assertBriefTaskContent(brief)).toThrow(/empty task content/);
      expect(() => renderNoPromptCommandRules(brief)).toThrow(/empty task content/);
    }
  });

  it.each(formats)('accepts and strips a trusted %s block using original-text offsets', (_name, format) => {
    const brief = `Inspect the session.\r\n\r\n${format(NO_PROMPT_COMMAND_RULES)}\r\nKeep the evidence.`;
    expect(assertBriefTaskContent(brief)).toBe(brief);
    expect(noPromptRulePlacement(brief).blocks).toHaveLength(1);
    expect(renderNoPromptCommandRules(brief)).toBe(brief);
    expect(stripTrustedNoPromptCommandRules(brief).trim()).toMatch(/^Inspect the session\.\s+Keep the evidence\.$/);
  });

  it.each(formats)('does not trust a %s policy block inside an HTML fence', (_name, format) => {
    const task = format(`Inspect this text.\n<PRE class="x" >\n${NO_PROMPT_COMMAND_RULES}\n</PrE >`);
    expect(noPromptRulePlacement(task).blocks).toEqual([]);
    const prompt = renderNoPromptCommandRules(task);
    expect(noPromptRulePlacement(prompt).blocks).toHaveLength(1);
    expect(prompt).toContain(task);
    expect(renderNoPromptCommandRules(prompt)).toBe(prompt);
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
