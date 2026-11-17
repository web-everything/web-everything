import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NO_PROMPT_COMMAND_RULES, NO_PROMPT_COMMAND_RULES_BODY, NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT, renderNoPromptCommandRules } from '../lib/no-prompt-command-rules.mjs';
import { composeOperatorTaskBrief } from '../operations/operator-task-brief.mjs';
import { applyContextPack, briefWithContextPack } from '../conveyor/fix-context-pack.mjs';
import { readFixBriefTemplate } from '../conveyor/reconcile-fix-dispatch.mjs';
import { readCiHealBriefTemplate } from '../operations/ci-heal-pr-dispatch.mjs';
import { realIo } from '../operations/probation-build-run.mjs';
import { bootstrapPlan } from '../operations/operator-session-bootstrap-io.mjs';
import { handoffHome } from '../operations/handoff-home.mjs';
import { resumeArgvFrom } from '../operations/worker-wrapper.mjs';
import { runFixCli } from '../operations/fix-run.mjs';
import { composeInvestigationPrompt } from '../operations/explore-io.mjs';
import { buildConvergeEditorArgv, readDeliveryBriefTemplate, resolveDeliveryAgentProvider } from '../operations/deliver-item-wrapper.mjs';
import { readDispatchBriefTemplate } from '../operations/dispatch-lane-io.mjs';
import { runTestSession } from '../operations/maintenance-io.mjs';

const root = mkdtempSync(join(tmpdir(), 'no-prompt-empty-task-'));
const templates = join(root, 'skills-src/conveyor');
mkdirSync(templates, { recursive: true });
const quietRules = join(handoffHome({ home: root, env: {} }), 'handoff-webeverything-rules.md');
mkdirSync(dirname(quietRules), { recursive: true });
writeFileSync(quietRules, 'Quiet hours: pause work.');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const EMPTY = ['', ' \t\r\n', NO_PROMPT_COMMAND_RULES, `\n${NO_PROMPT_COMMAND_RULES}\n`,
  `${NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT}\n${NO_PROMPT_COMMAND_RULES}`,
  `${NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT}\n${NO_PROMPT_COMMAND_RULES_BODY}`,
  `${NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT}\n${NO_PROMPT_COMMAND_RULES}`.replaceAll('\n', '\r\n'),
  `${NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT}\n${NO_PROMPT_COMMAND_RULES}`.replaceAll('\n', '\r'),
  `${NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT}\n${NO_PROMPT_COMMAND_RULES}`.split('\n').map(line => `${line} \t`).join('\r\n')];
const settings = { contextPack: true, contextMaxBytes: 10000, contextLines: 20, localTests: 'proof-only' };

describe('task content is checked before generic instructions can mask it', () => {
  it.each(EMPTY)('shared renderer refuses empty or rules-only task %j', task => {
    expect(() => renderNoPromptCommandRules(task)).toThrow(/empty task content/);
  });

  it.each(EMPTY)('operator composer refuses %j before either post-build branch', task => {
    for (const steps of [[], ['Report the result.']]) {
      expect(() => composeOperatorTaskBrief(task, {}, { steps })).toThrow(/empty task content/);
    }
  });

  it.each(EMPTY)('applyContextPack refuses %j before tests instructions or evidence', task => {
    for (const contextPack of [false, true]) {
      expect(() => applyContextPack(task, { settings: { ...settings, contextPack }, inputs: {} })).toThrow(/empty task content/);
    }
  });

  it.each(EMPTY)('briefWithContextPack refuses %j before reads and outside its fallback catch', task => {
    const readInputs = vi.fn(() => ({ findings: [{ body: 'Some context' }] }));
    expect(() => briefWithContextPack(task, { settings, readInputs })).toThrow(/empty task content/);
    expect(readInputs).not.toHaveBeenCalled();
    expect(() => briefWithContextPack(task)).toThrow(/empty task content/);
  });

  describe.each([
    ['fix', 'fix-agent-brief.md', readFixBriefTemplate],
    ['ci-heal', 'fix-agent-ci-brief.md', readCiHealBriefTemplate],
  ])('%s template reader', (_kind, file, read) => {
    it.each(EMPTY)('refuses %j before packing or build requirements', task => {
      writeFileSync(join(templates, file), task);
      const pack = vi.fn(() => 'Generic packed context.');
      expect(() => read(root, pack)).toThrow(/empty task content/);
      expect(pack).not.toHaveBeenCalled();
    });
    it.each(EMPTY)('refuses a packer that erases valid task content to %j', packed => {
      writeFileSync(join(templates, file), 'Repair the specific failing test.');
      expect(() => read(root, () => packed)).toThrow(/empty task content/);
    });
  });

  it.each(EMPTY)('probation prepare reader refuses %j before policy rendering', task => {
    writeFileSync(join(templates, 'prepare-item-worker-brief.md'), task);
    const io = realIo({ session: 'empty-task-test', repoRoot: root, env: {} });
    expect(() => io.readPrepareBrief(root)).toThrow(/empty task content/);
  });

  it.each(EMPTY)('dispatch template reader refuses %j before policy and build requirements', task => {
    for (const kind of ['build', 'fix', 'ci-heal', 'prepare']) {
      const readText = vi.fn(() => task);
      expect(() => readDispatchBriefTemplate(root, kind, readText)).toThrow(/empty task content/);
      expect(readText).toHaveBeenCalledOnce();
    }
  });

  it.each(EMPTY)('delivery template reader refuses %j before build requirements', task => {
    writeFileSync(join(templates, 'delivery-agent-brief-v2.md'), task);
    expect(() => readDeliveryBriefTemplate(root)).toThrow(/empty task content/);
  });

  it.each(EMPTY)('Claude provider refuses %j before a wrapped or bare spawn can add suffixes', async task => {
    const provider = resolveDeliveryAgentProvider('claude-restricted');
    for (const workerWrapper of [false, true]) {
      const ensureSettingsFile = vi.fn(), spawnAgent = vi.fn(), runWorkerFn = vi.fn();
      await expect(provider.spawn({ prompt: task, sessionId: 'sid', lane: 1 }, {
        workerWrapper, ensureSettingsFile, spawnAgent, runWorkerFn,
      })).rejects.toThrow(/empty task content/);
      expect(ensureSettingsFile).not.toHaveBeenCalled();
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(runWorkerFn).not.toHaveBeenCalled();
    }
  });

  it.each(EMPTY)('bootstrap refuses %j even with non-empty quiet-hours rules', task => {
    const readPrompt = vi.fn(() => task);
    expect(() => bootstrapPlan({ home: root, env: {}, log: vi.fn() }, { readPrompt })).toThrow(/empty task content/);
    expect(readPrompt).toHaveBeenCalledOnce();
  });

  it.each(EMPTY)('worker resume refuses %j before the structured-output suffix', task => {
    expect(() => resumeArgvFrom(['-p', '--session-id', 'sid', 'Old task'], { sessionId: 'sid', prompt: task }))
      .toThrow(/empty task content/);
  });

  it.each(EMPTY)('borrowed fix refuses %j before PR reads, context and provider resolution', async task => {
    const run = vi.fn(), resolveProvider = vi.fn(), releaseClaim = vi.fn(), recordOutcome = vi.fn();
    const writeErr = vi.fn();
    const result = await runFixCli(['--pr=7', '--session=fix-7', '--ref=lane/7-x', `--prompt-file=${join(root, 'task.md')}`, '--provider=codex', '--repo=fixture/repo', `--lane-repo=${root}`], {
      readPrompt: () => task, removePrompt: vi.fn(), pendingRearm: {}, run, resolveProvider,
      releaseClaim, recordOutcome, recordRouted: vi.fn(), appendLoopRow: vi.fn(),
      weRoot: root, write: vi.fn(), writeErr,
    });
    expect(result.code).toBe(1);
    expect(writeErr.mock.calls.flat().join(' ')).toMatch(/empty task content/);
    expect(run).not.toHaveBeenCalled();
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledOnce();
  });

  it.each(EMPTY)('investigation composer refuses %j before report instructions', task => {
    expect(() => composeInvestigationPrompt(task, 'report.md')).toThrow(/empty (?:brief|task content)/);
  });

  it.each(EMPTY)('restricted editor argv refuses %j before reaching a launcher', task => {
    expect(() => buildConvergeEditorArgv({ sessionId: 'sid', prompt: task, settingsFile: 'settings.json' }))
      .toThrow(/empty task content/);
  });

  it.each(EMPTY)('maintenance probe refuses %j without spawning Claude', task => {
    const exec = vi.fn();
    const result = runTestSession({ exec, policy: { prompt: task, model: 'haiku', expect: 'OK', timeoutSeconds: 1 } });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/empty task content/);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    'scripts/workflows/review-parked-prs.mjs',
    'skills-src/jury/subject-jury.workflow.js',
    'skills-src/batch-backlog-items/parallel-execute.workflow.js',
  ])('%s sandbox renderer refuses empty input before adding its literal rules', path => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const source = readFileSync(join(repo, path), 'utf8');
    const runtime = source.match(/\/\/ BEGIN generated no-prompt runtime[^\n]*\n([\s\S]*?)\n\/\/ END generated no-prompt runtime/)[1];
    const render = new Function(`${runtime}; return renderNoPromptCommandRules;`)();
    for (const task of EMPTY) expect(() => render(task)).toThrow(/empty task content/);
    expect(render('Concrete task')).toBe(`Concrete task\n\n${NO_PROMPT_COMMAND_RULES}\n`);
  });

  it('Python launcher renderer refuses empty input without importing or launching the legacy runner', () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const script = `import ast, json, sys
tree = ast.parse(sys.stdin.read())
nodes = [n for n in tree.body if (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id.startswith('NO_PROMPT_COMMAND_RULES') for t in n.targets)) or (isinstance(n, ast.FunctionDef) and n.name == 'render_no_prompt_command_rules')]
exec(compile(ast.Module(body=nodes, type_ignores=[]), '<renderer>', 'exec'))
for task in ['', ' \\t\\r\\n', NO_PROMPT_COMMAND_RULES, '\\n' + NO_PROMPT_COMMAND_RULES + '\\n', NO_PROMPT_COMMAND_RULES_GENERATED_COMMENT + '\\n' + NO_PROMPT_COMMAND_RULES]:
    try:
        render_no_prompt_command_rules(task)
    except ValueError as error:
        assert 'empty task content' in str(error)
    else:
        raise AssertionError('accepted empty task')
assert render_no_prompt_command_rules('Concrete task') == NO_PROMPT_COMMAND_RULES + '\\n\\nConcrete task'
quoted = '<approach>\\n' + NO_PROMPT_COMMAND_RULES + '\\n</approach>'
rendered = render_no_prompt_command_rules(quoted)
assert rendered == NO_PROMPT_COMMAND_RULES + '\\n\\n' + quoted
assert render_no_prompt_command_rules(rendered) == rendered
print('PASS')`;
    const result = spawnSync('python3', ['-c', script], { input: readFileSync(join(repo, 'scripts/operator/converge.py'), 'utf8'),
      encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('PASS');
  });
});
