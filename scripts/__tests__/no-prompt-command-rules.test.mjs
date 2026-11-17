import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  NO_PROMPT_COMMAND_RULES, renderNoPromptCommandRules, renderNoPromptCommandRulesRuntime, noPromptRulePlacement,
  LAUNCH_BRIEF_SOURCES, LAUNCH_BRIEF_EXCLUSIONS,
  LAUNCH_BRIEF_PROPERTIES, NO_GIT_COMMAND_RULES,
} from '../lib/no-prompt-command-rules.mjs';
import { renderWorkerBrief } from '../worker-brief.mjs';
import { readCiHealBriefTemplate } from '../operations/ci-heal-pr-dispatch.mjs';
import { buildAgentArgv } from '../operations/dispatch-lane-io.mjs';
import { buildJudgeArgv, deriveSessionId } from '../lib/judge-spawn.mjs';
import { resumeArgvFrom } from '../operations/worker-wrapper.mjs';
import { auditLedger, listBriefs } from '../conveyor/brief-rule-ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Test fixtures and soak fault scenarios model launches; they are not production brief sources.
const FIXTURE = /(?:^|\/)(?:__tests__|__fixtures__|fixtures|soak)(?:\/|$)|\.(?:test|spec)\./;

function tree(dir, io = { readdirSync, readFileSync }) {
  return io.readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    if (FIXTURE.test(path)) return [];
    if (entry.isDirectory()) return tree(path, io);
    if (!/\.(?:mjs|cjs|js|ts|md|sh|py)$/.test(path)) return [];
    return [[path, io.readFileSync(join(ROOT, path), 'utf8')]];
  });
}

/** Syntax signatures deliberately over-detect: unknown evidence needs a registry entry or a reason. */
function isBriefSource(path, text) {
  if (typeof text !== 'string') throw new TypeError(`Unreadable brief source: ${path}`);
  if (path.endsWith('.md')) return /(?:SKILL|brief[^/]*|prompt[^/]*)\.md$|\.prompt\.md$/.test(path);
  if (path.endsWith('.sh')) return /\bclaude\s+(?:-p|--print|--bg)\b/.test(text);
  if (path.endsWith('.py')) return /["']claude["']|def \w*(?:prompt|brief|mandate)\w*\(/i.test(text);
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = false;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && /(?:Brief|Prompt|Mandate)/.test(node.name?.text ?? '')) found = true;
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
      && /^(?:prompt|mandate)$/.test(node.name.getText(source))) found = true;
    if (ts.isVariableDeclaration(node)
      && /^(?:[A-Z_]*_)?(?:PROMPT\d*|MANDATE)(?:_TEXT|_SUFFIX)?$/.test(node.name.getText(source))) found = true;
    if (ts.isVariableDeclaration(node) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      && /(?:Brief|Prompt|Mandate)/.test(node.name.getText(source))) found = true;
    if (ts.isCallExpression(node) && (node.expression.getText(source) === 'agent'
      || (/(?:spawn|exec|run)/i.test(node.expression.getText(source))
        && /^['"]claude['"]$/.test(node.arguments[0]?.getText(source) ?? '')))) found = true;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function unregistered(files) {
  return files.filter(([path, text]) => isBriefSource(path, text)
    && !LAUNCH_BRIEF_SOURCES.includes(path) && !LAUNCH_BRIEF_EXCLUSIONS[path]).map(([path]) => path);
}

function expectBlock(text, rules = NO_PROMPT_COMMAND_RULES) {
  expect(text).toContain(rules);
  expect(text.split('## No-prompt command rules')).toHaveLength(2);
}

// This audit checks authored restrictions; variant selection always uses the declared property.
function forbiddenWorkerGit(files) {
  return files.filter(([path, text]) => {
    if (!path.endsWith('.md') || !LAUNCH_BRIEF_SOURCES.includes(path)) return false;
    const task = text.replaceAll(NO_PROMPT_COMMAND_RULES, '').replaceAll(NO_GIT_COMMAND_RULES, '')
      .replace(/[*`]/g, '').replace(/\s+/g, ' ');
    const forbids = /\bno git\b|\bgit commands? (?:is|are) denied\b|\bany other git command yourself\b|\b(?:do not|never)\b[^.!?]{0,100}\b(?:push|re-push)\b/i.test(task);
    return forbids && LAUNCH_BRIEF_PROPERTIES[path]?.allowsGit !== false;
  }).map(([path]) => path);
}

describe('no-prompt command rules', () => {
  it('carries every command restriction and safe branch continuation', () => {
    for (const rule of ['no `$(...)`', 'no shell variables or arrays', 'no loops', 'no trailing `&`',
      'Edit/Write tools', '`sed -i`', '`perl -i`', 'redirect writes', '`rm -rf` / `rm -r`',
      'NEW uniquely named dir', '`git reset --hard`', '`git push --force`', '`git clean`',
      '`git fetch origin <branch>` then `git merge --no-edit FETCH_HEAD`',
      '`HEAD:refs/heads/<branch>`', 'TaskStop', '`kill <exact pid>`', '`pkill`/`killall`']) {
      expect(NO_PROMPT_COMMAND_RULES).toContain(rule);
    }
  });

  it('renders once even when several brief transforms compose it', () => {
    const rendered = renderNoPromptCommandRules('Task');
    expectBlock(rendered);
    expect(rendered.startsWith('Task\n')).toBe(true);
    expect(renderNoPromptCommandRules(rendered)).toBe(rendered);
    expect(() => renderNoPromptCommandRules(undefined)).toThrow(TypeError);
  });

  it('includes the complete block in a rendered worker brief', () => {
    expectBlock(renderWorkerBrief({ purpose: 'command-rules', files: ['scripts/example.mjs'], owner: 'rules-test' }));
  });

  it('includes the no-git block in the real ci-heal brief after packing', () => {
    expectBlock(readCiHealBriefTemplate(ROOT, template => `Packed context\n${template}`), NO_GIT_COMMAND_RULES);
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
      expectBlock(argv[argv.indexOf('--append-system-prompt') + 1], NO_GIT_COMMAND_RULES);
    }
  });

  it('fails closed on an unregistered launcher or newly authored dispatched brief', () => {
    for (const [path, text] of [
      ['scripts/new-launch.mjs', "spawn('claude', ['-p', task]);"],
      ['scripts/new-builder.mjs', 'export function buildNewBrief() { return "Task"; }'],
      ['scripts/new-arrow.mjs', 'export const buildNewPrompt = () => "Task";'],
      ['scripts/new-request.mjs', 'const request = { prompt };'],
      ['skills-src/new-role/agent-brief.md', 'Perform this new task.'],
      ['skills-src/new-role/SKILL.md', 'A new skill that needs classification.'],
      ['scripts/new-launch.sh', 'claude --bg task'],
      ['scripts/new-launch.py', 'subprocess.run(["claude", "-p", task])'],
    ]) expect(unregistered([[path, text]])).toEqual([path]);
  });

  it('fails closed on unreadable source evidence and tree reads', () => {
    expect(() => unregistered([['scripts/new-launch.mjs', null]])).toThrow('Unreadable brief source');
    expect(() => tree('scripts', { readdirSync() { throw new Error('read denied'); } })).toThrow('read denied');
  });

  it('rejects full-rules declarations for briefs forbidding worker Git or publication', () => {
    for (const text of ['Do NOT run git commit, git add, or any other git command yourself.',
      'Do not claim, resolve, acquire another lane, stamp, commit, push, or open a PR.',
      'Never push yourself; the wrapper publishes.', 'There are no git commands for this worker.']) {
      expect(forbiddenWorkerGit([['skills-src/worker-brief/SKILL.md', text]]))
        .toEqual(['skills-src/worker-brief/SKILL.md']);
    }
  });

  it('audits the whole scripts/ and skills-src/ trees with explicit exclusions', () => {
    const files = new Map([...tree('scripts'), ...tree('skills-src')]);
    expect(unregistered([...files])).toEqual([]);
    expect(forbiddenWorkerGit([...files])).toEqual([]);
    expect(new Set(LAUNCH_BRIEF_SOURCES).size).toBe(LAUNCH_BRIEF_SOURCES.length);
    for (const [path, reason] of Object.entries(LAUNCH_BRIEF_EXCLUSIONS)) {
      expect(reason.trim().length, path).toBeGreaterThan(20);
      expect(files.has(path), path).toBe(true);
      expect(LAUNCH_BRIEF_SOURCES, path).not.toContain(path);
    }
    for (const path of LAUNCH_BRIEF_SOURCES) {
      const text = files.get(path);
      expect(typeof text, path).toBe('string');
      const properties = LAUNCH_BRIEF_PROPERTIES[path];
      expect(typeof properties?.allowsGit, path).toBe('boolean');
      const rules = properties.allowsGit ? NO_PROMPT_COMMAND_RULES : NO_GIT_COMMAND_RULES;
      const rendered = renderNoPromptCommandRules('Concrete task', path);
      expectBlock(rendered, rules);
      if (!properties.allowsGit) {
        expect(rendered, path).not.toMatch(/`git |HEAD:refs\/heads\//);
        if (!path.endsWith('.md')) {
          const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
          let calls = 0;
          function visit(node) {
            if (ts.isCallExpression(node) && node.expression.getText(source) === 'renderNoPromptCommandRules') {
              calls++;
              expect(node.arguments[1]?.text, path).toBe(path);
            }
            ts.forEachChild(node, visit);
          }
          visit(source);
          expect(calls, path).toBeGreaterThan(0);
        }
      }
      if (path.endsWith('.md')) {
        expectBlock(text, rules);
        if (!properties.allowsGit) expect(text, path).not.toContain(NO_PROMPT_COMMAND_RULES);
        expect(noPromptRulePlacement(text).blocks, path).toHaveLength(1);
      }
      else if (path.endsWith('.py')) {
        expect(JSON.parse(text.match(/^NO_PROMPT_COMMAND_RULES = (.+)$/m)[1]), path).toBe(NO_PROMPT_COMMAND_RULES);
        expect(text).toContain('prompt = render_no_prompt_command_rules(prompt)');
        for (const name of ['FIX', 'CI_HEAL', 'REVIEW']) expect(text).toContain(`${name} = render_no_prompt_command_rules(${name})`);
      } else if (text.includes('const NO_PROMPT_COMMAND_RULES =')) {
        // The workflow sandbox cannot import modules. Pin its generated literal, then its agent boundary.
        const literal = text.match(/^const NO_PROMPT_COMMAND_RULES = (.+);$/m);
        expect(JSON.parse(literal[1]), path).toBe(NO_PROMPT_COMMAND_RULES);
        expect(text, path).toContain(renderNoPromptCommandRulesRuntime());
        const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
        function visit(node) {
          if (ts.isCallExpression(node) && node.expression.getText(source) === 'agent') {
            expect(node.arguments[0].getText(source), path).toMatch(/^renderNoPromptCommandRules\(/);
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      } else {
        expect(text, path).toMatch(/import \{[^}]*\brenderNoPromptCommandRules\b[^}]*\} from ['"].*no-prompt-command-rules\.mjs['"]/);
        expect(text, path).toMatch(/renderNoPromptCommandRules\(/);
      }
    }
  });

  it('classifies every new imperative without stale or unlisted ledger lines', () => {
    const ledger = JSON.parse(readFileSync(join(ROOT, 'skills-src/conveyor/brief-rule-ledger.json'), 'utf8'));
    const audit = auditLedger(listBriefs(ROOT).map(brief => ({ brief, text: readFileSync(join(ROOT, brief), 'utf8') })), ledger);
    expect(audit.unlisted).toEqual([]);
    expect(audit.stale).toEqual([]);
    expect(ledger.rules.find(rule => rule.id === 'no-prompt-command-rules').status).toBe('prose-only');
  });
});
