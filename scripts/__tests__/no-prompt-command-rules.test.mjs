// @repo-scanning-test scope=full
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  NO_PROMPT_COMMAND_RULES, renderNoPromptCommandRules, renderNoPromptCommandRulesRuntime,
  LAUNCH_BRIEF_SOURCES, LAUNCH_BRIEF_EXCLUSIONS,
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

  it('audits the whole scripts/ and skills-src/ trees with explicit exclusions', () => {
    const files = new Map([...tree('scripts'), ...tree('skills-src')]);
    expect(unregistered([...files])).toEqual([]);
    expect(new Set(LAUNCH_BRIEF_SOURCES).size).toBe(LAUNCH_BRIEF_SOURCES.length);
    for (const [path, reason] of Object.entries(LAUNCH_BRIEF_EXCLUSIONS)) {
      expect(reason.trim().length, path).toBeGreaterThan(20);
      expect(files.has(path), path).toBe(true);
      expect(LAUNCH_BRIEF_SOURCES, path).not.toContain(path);
    }
    for (const path of LAUNCH_BRIEF_SOURCES) {
      const text = files.get(path);
      expect(typeof text, path).toBe('string');
      if (path.endsWith('.md')) {
        expect(text.split(NO_PROMPT_COMMAND_RULES), path).toHaveLength(2);
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
