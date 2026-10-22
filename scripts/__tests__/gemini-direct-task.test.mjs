/** Mechanical tests only. Supplied live agy 1.2.2 streams are literal fixtures; real git regressions; no real agy processes. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readAgyHold, saveAgyHold } from '../lib/antigravity-run-evidence.mjs';
import {
  AGY_CLI, AGY_RESUME_PROMPT, AGY_EFFORT_UNSUPPORTED_MODELS, DEFAULT_TIMEOUT_MS, buildAgyDirectTaskArgv, buildAgyPrompt, buildAgyStdinLine,
  buildScratchCloneArgv, planDepsInstall, parseJsonlLine, parseJsonlEvents, summarizeAgyEvents,
  defaultExecFn,
  setupScratchClone, captureDiff, runGate, runAgyDirectExec, geminiDirectTask, parseFlags, main, formatReport,
} from '../gemini-direct-task.mjs';

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'we-gemini-direct-test-'));
  tempDirs.push(dir);
  return dir;
}
// Exercise the real quota reader without inheriting or changing the host's holds.
beforeEach(() => {
  vi.stubEnv('ANTIGRAVITY_QUOTA_DIR', tempDir());
  vi.stubEnv('WE_BUILDER_SLOTS', 'off');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  process.exitCode = 0;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('defaultExecFn — real child-process output buffering', () => {
  it('returns the full stdout when output exceeds Node’s default 1 MiB buffer', () => {
    const outputSize = 2 * 1024 * 1024;
    const output = defaultExecFn(process.execPath, [
      '-e', `process.stdout.write('x'.repeat(${outputSize}))`,
    ]);
    expect(output.length).toBeGreaterThan(1024 * 1024);
    expect(output).toBe('x'.repeat(outputSize));
  });
});

describe('buildScratchCloneArgv — pure local-clone argv', () => {
  it('clones repoRoot into dest, quietly', () => {
    expect(buildScratchCloneArgv({ repoRoot: '/repo', dest: '/tmp/x' })).toEqual(['clone', '--quiet', '/repo', '/tmp/x']);
  });
  it('requires both paths', () => {
    expect(() => buildScratchCloneArgv({ dest: '/tmp/x' })).toThrow(/repoRoot/);
    expect(() => buildScratchCloneArgv({ repoRoot: '/repo' })).toThrow(/dest/);
  });
});

describe('planDepsInstall — ci vs install vs nothing, over an injected existsFn', () => {
  it('returns null when there is no package.json', () => {
    expect(planDepsInstall('/d', () => false)).toBeNull();
  });
  it('uses npm ci when a lockfile is present', () => {
    const existsFn = (p) => p.endsWith('package.json') || p.endsWith('package-lock.json');
    expect(planDepsInstall('/d', existsFn)).toEqual({ bin: 'npm', args: ['ci'] });
  });
  it('falls back to npm install with no lockfile', () => {
    const existsFn = (p) => p.endsWith('package.json');
    expect(planDepsInstall('/d', existsFn)).toEqual({ bin: 'npm', args: ['install'] });
  });
});

describe('JSONL parsing — tolerant of blank/malformed lines, never throws', () => {
  it('parseJsonlLine returns null for blank or unparsable input', () => {
    expect(parseJsonlLine('')).toBeNull();
    expect(parseJsonlLine('   ')).toBeNull();
    expect(parseJsonlLine('not json')).toBeNull();
    expect(parseJsonlLine('{"a":1}')).toEqual({ a: 1 });
  });

  it('parseJsonlEvents drops blank/unparsable lines and keeps order', () => {
    const stdout = '{"type":"a"}\n\n{"type":"b"}\nnope\n{"type":"c"}\n';
    expect(parseJsonlEvents(stdout).map((e) => e.type)).toEqual(['a', 'b', 'c']);
  });
});

describe('setupScratchClone — clones locally and installs deps, over injected execFn/mkTempDir/existsFn', () => {
  it('#3782: clones from repoRoot, LEAVES origin at the local clone source by default, and REPORTS the real remote without wiring it in', () => {
    const calls = [];
    const execFn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      if (bin === 'git' && args.includes('get-url')) return 'https://github.com/x/y.git\n';
      return '';
    };
    const mkTempDir = (prefix) => `${prefix}FAKE`;
    const existsFn = (p) => p.endsWith('package.json') || p.endsWith('package-lock.json');

    const result = setupScratchClone({ repoRoot: '/repo', execFn, mkTempDir, existsFn });

    expect(result.dest).toMatch(/FAKE$/);
    expect(result.depsInstall).toEqual({ bin: 'npm', args: ['ci'] });
    // clone happened first, against the real buildScratchCloneArgv recipe
    const cloneCall = calls.find((c) => c.bin === 'git' && c.args[0] === 'clone');
    expect(cloneCall.args).toEqual(buildScratchCloneArgv({ repoRoot: '/repo', dest: result.dest }));
    // the real remote is resolved and reported, but never wired into the clone's own git config by default.
    expect(result.realOrigin).toBe('https://github.com/x/y.git');
    expect(result.originWired).toBe(false);
    expect(calls.some((c) => c.bin === 'git' && c.args.includes('set-url'))).toBe(false);
    // deps actually installed in the clone
    expect(calls.some((c) => c.bin === 'npm' && c.args[0] === 'ci' && c.opts?.cwd === result.dest)).toBe(true);
  });

  it('#3782: wireOriginToRemote:true opts back into rewriting origin to the real remote', () => {
    const calls = [];
    const execFn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      if (bin === 'git' && args.includes('get-url')) return 'https://github.com/x/y.git\n';
      return '';
    };
    const result = setupScratchClone({
      repoRoot: '/repo', execFn, mkTempDir: (p) => `${p}FAKE`, existsFn: () => false, wireOriginToRemote: true,
    });
    expect(result.realOrigin).toBe('https://github.com/x/y.git');
    expect(result.originWired).toBe(true);
    expect(calls.some((c) => c.bin === 'git' && c.args.includes('set-url') && c.args.includes('https://github.com/x/y.git'))).toBe(true);
  });

  it('tolerates a repoRoot with no origin remote — clone still succeeds', () => {
    const execFn = (bin, args) => {
      if (bin === 'git' && args.includes('get-url')) throw new Error('no such remote');
      return '';
    };
    const result = setupScratchClone({
      repoRoot: '/repo', execFn, mkTempDir: (p) => `${p}FAKE`, existsFn: () => false,
    });
    expect(result.dest).toMatch(/FAKE$/);
    expect(result.depsInstall).toBeNull(); // existsFn says no package.json
    expect(result.realOrigin).toBeNull();
    expect(result.originWired).toBe(false);
  });

  it('skips dep install when installDeps is false, even with a lockfile present', () => {
    const execFn = () => '';
    const result = setupScratchClone({
      repoRoot: '/repo', execFn, mkTempDir: (p) => `${p}FAKE`, existsFn: () => true, installDeps: false,
    });
    expect(result.depsInstall).toBeNull();
  });

  it('requires a non-empty repoRoot', () => {
    expect(() => setupScratchClone({ execFn: () => '' })).toThrow(/repoRoot/);
  });
});

function initGitRepo(dir) {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'core.quotePath', 'true');
  git('-c', 'user.name=Direct Task Test', '-c', 'user.email=direct-task@example.test',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null',
    'commit', '--quiet', '--allow-empty', '-m', 'Test baseline');
  return git;
}

describe('captureDiff — the review artifact, never a commit/push', () => {
  it('returns readable lines for real modified and untracked status entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-direct-status-test-'));
    try {
      const git = initGitRepo(dir);
      const startSha = git('rev-parse', 'HEAD');
      writeFileSync(join(dir, 'tracked.txt'), 'original\n');
      git('add', 'tracked.txt');
      writeFileSync(join(dir, 'tracked.txt'), 'modified\n');
      writeFileSync(join(dir, 'untracked.txt'), 'new\n');
      const result = captureDiff({ dir, startSha });
      expect(result.status).not.toContain('\0');
      expect(result.status.split('\n')).toEqual(['AM tracked.txt', '?? untracked.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['a file.txt', 'café.txt', 'a"quote.txt', 'a\nline.txt'])('captures an untracked filename with spaces, Unicode or quoting: %j', (filename) => {
    const dir = mkdtempSync(join(tmpdir(), 'we-gemini-direct-git-test-'));
    try {
      const git = initGitRepo(dir);
      const startSha = git('rev-parse', 'HEAD');
      writeFileSync(join(dir, filename), 'new file review evidence\n');
      const report = captureDiff({ dir, startSha });
      expect(report.hasChanges).toBe(true);
      expect(report.diff).toContain('+new file review evidence');
      expect(report.diffStat).toContain('1 file changed');
      expect(execFileSync('git', ['-C', dir, 'diff', '--name-only', '-z', startSha], { encoding: 'utf8' }))
        .toBe(`${filename}\0`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Every real call is shaped `['-C', dir, <subcommand>, ...]` (see `captureDiff`'s own `execFn('git', ['-C',
  // dir, 'status', ...])` etc.), so these mocks match on `args.includes(...)`, never `args[0]`.
  it('reports a clean tree as no changes', () => {
    const execFn = (bin, args) => {
      if (args.includes('status')) return '';
      if (args.includes('diff') && args.includes('--stat')) return '';
      if (args.includes('diff')) return '';
      if (args.includes('log')) return '';
      return '';
    };
    const r = captureDiff({ dir: '/d', startSha: 'abc123', execFn });
    expect(r.hasChanges).toBe(false);
    expect(r.commits).toEqual([]);
  });

  it('intent-to-adds untracked files (content-free) so they surface in the diff, and reports the diff/stat', () => {
    const calls = [];
    const execFn = (bin, args) => {
      calls.push(args.join(' '));
      if (args.includes('status')) return '?? new-file.txt\0 M existing.txt\0';
      if (args.includes('diff') && args.includes('--stat')) return ' 2 files changed\n';
      if (args.includes('diff')) return 'diff --git a/existing.txt …';
      if (args.includes('log')) return '';
      return '';
    };
    const r = captureDiff({ dir: '/d', startSha: 'abc123', execFn });
    expect(calls).toContain('-C /d add --intent-to-add -- new-file.txt');
    expect(r.hasChanges).toBe(true);
    expect(r.diffStat).toContain('2 files changed');
  });

  it('never stages real content — the only `add` call it can make is --intent-to-add', () => {
    const calls = [];
    const execFn = (bin, args) => {
      calls.push(args);
      if (args.includes('status')) return '?? x.txt\0';
      return '';
    };
    captureDiff({ dir: '/d', startSha: 'abc', execFn });
    const addCalls = calls.filter((a) => a.includes('add'));
    expect(addCalls.length).toBeGreaterThan(0);
    expect(addCalls.every((a) => a.includes('--intent-to-add'))).toBe(true);
  });

  it('surfaces commits agy made despite the prompt instruction, via `git log startSha..HEAD`', () => {
    const execFn = (bin, args) => {
      if (args.includes('status')) return '';
      if (args.includes('log')) return 'abcdef1 agy: whoops, committed anyway\n';
      return '';
    };
    const r = captureDiff({ dir: '/d', startSha: 'abc', execFn });
    expect(r.commits).toEqual(['abcdef1 agy: whoops, committed anyway']);
    expect(r.hasChanges).toBe(true);
  });

  it('requires dir and startSha', () => {
    expect(() => captureDiff({ startSha: 'x', execFn: () => '' })).toThrow(/dir/);
    expect(() => captureDiff({ dir: '/d', execFn: () => '' })).toThrow(/startSha/);
  });
});

describe('runGate — none/standards/full, never commits', () => {
  it('mode "none" (default) runs nothing and passes', () => {
    const execFn = vi.fn();
    const r = runGate({ dir: '/d', mode: 'none', execFn });
    expect(r.ran).toBe(false);
    expect(r.pass).toBe(true);
    expect(execFn).not.toHaveBeenCalled();
  });

  it('mode "standards" runs only check:standards', () => {
    const execFn = vi.fn(() => 'ok');
    const r = runGate({ dir: '/d', mode: 'standards', execFn });
    expect(r.steps.map((s) => s.cmd)).toEqual(['npm run check:standards']);
    expect(r.pass).toBe(true);
  });

  it('mode "full" runs check:standards then the full vitest suite', () => {
    const execFn = vi.fn(() => 'ok');
    const r = runGate({ dir: '/d', mode: 'full', execFn });
    expect(r.steps.map((s) => s.cmd)).toEqual(['npm run check:standards', 'npm run test:unit']);
  });

  it('a failing step is caught and reported, not thrown — and marks the gate failed', () => {
    const execFn = vi.fn((bin, args) => {
      if (args.includes('check:standards')) { const e = new Error('exit 1'); e.stdout = 'BAD'; throw e; }
      return 'ok';
    });
    const r = runGate({ dir: '/d', mode: 'full', execFn });
    expect(r.pass).toBe(false);
    expect(r.steps[0].pass).toBe(false);
    expect(r.steps[0].output).toContain('BAD');
    expect(r.steps[1].pass).toBe(true); // the second step still ran
  });
});


describe('buildAgyDirectTaskArgv — observed stdin route, no invented flags or defaults', () => {
  const BASE = ['--input-format', 'stream-json', '--output-format', 'stream-json',
    '--disable-slash-commands', '--dangerously-skip-permissions'];
  it('has exactly the mandatory flags and explicit empty --print value', () => {
    expect(AGY_CLI).toBe('agy');
    expect(DEFAULT_TIMEOUT_MS).toBe(1800000);
    expect(buildAgyDirectTaskArgv()).toEqual([...BASE, '--print', '']);
  });
  it('forwards each option, preserving repeated directories and a fractional seconds hint', () => {
    expect(buildAgyDirectTaskArgv({ addDirs: ['/a space', '/b'], model: 'future-model', effort: 'high', sandbox: true, printTimeoutMs: 1501 }))
      .toEqual([...BASE, '--add-dir', '/a space', '--add-dir', '/b', '--model', 'future-model',
        '--effort', 'high', '--sandbox', '--print-timeout', '1.501s', '--print', '']);
  });
  it.each(['low', 'medium', 'high'])('forwards effort %s with no model pin', (effort) => {
    expect(buildAgyDirectTaskArgv({ effort })).toEqual([...BASE, '--effort', effort, '--print', '']);
  });
  it('names only the two known Claude backends as effort exceptions', () => {
    expect(AGY_EFFORT_UNSUPPORTED_MODELS).toEqual(['claude-sonnet-4-6', 'claude-opus-4-6-thinking']);
  });
  it.each(['claude-sonnet-4-6', 'claude-opus-4-6-thinking'].flatMap((model) =>
    ['low', 'medium', 'high'].map((effort) => [model, effort])))('omits effort for %s with %s', (model, effort) => {
    const argv = buildAgyDirectTaskArgv({ model, effort });
    expect(argv).not.toContain('--effort');
    expect(argv).toEqual([...BASE, '--model', model, '--print', '']);
  });
  it('still forwards --effort for a non-Claude model paired with an explicit effort', () => {
    expect(buildAgyDirectTaskArgv({ model: 'future-model', effort: 'medium' }))
      .toEqual([...BASE, '--model', 'future-model', '--effort', 'medium', '--print', '']);
  });
  it('recognizes a Claude model after trimming whitespace', () => {
    expect(buildAgyDirectTaskArgv({ model: ' claude-sonnet-4-6 ', effort: 'medium' }))
      .toEqual([...BASE, '--model', 'claude-sonnet-4-6', '--print', '']);
  });
  it.each(['claude-sonnet-4-6', 'claude-opus-4-6-thinking'].flatMap((model) =>
    ['constructor', 'ultra'].map((effort) => [model, effort])))('rejects malformed effort for %s with %s', (model, effort) => {
    expect(() => buildAgyDirectTaskArgv({ model, effort })).toThrow(TypeError);
  });
  it('omits effort when resuming a Claude conversation', () => {
    const resumeConversationId = 'afa6b941-eb5d-4652-9471-4bae369c1cbd';
    const argv = buildAgyDirectTaskArgv({ resumeConversationId, model: 'claude-sonnet-4-6', effort: 'high' });
    expect(argv).not.toContain('--effort');
    expect(argv).toEqual(['--input-format', 'text', '--output-format', 'stream-json',
      '--disable-slash-commands', '--dangerously-skip-permissions', '--model', 'claude-sonnet-4-6',
      '--conversation', resumeConversationId, '--print', AGY_RESUME_PROMPT]);
  });
  it('resumes an explicit conversation in text print mode with the same execution options', () => {
    expect(buildAgyDirectTaskArgv({ resumeConversationId: 'afa6b941-eb5d-4652-9471-4bae369c1cbd',
      model: 'chosen', effort: 'high', addDirs: ['/extra'], sandbox: true, printTimeoutMs: 540000 }))
      .toEqual(['--input-format', 'text', '--output-format', 'stream-json',
        '--disable-slash-commands', '--dangerously-skip-permissions', '--add-dir', '/extra',
        '--model', 'chosen', '--effort', 'high', '--sandbox', '--print-timeout', '540s',
        '--conversation', 'afa6b941-eb5d-4652-9471-4bae369c1cbd', '--print', AGY_RESUME_PROMPT]);
  });
  it('prevents the text-mode empty prompt error when resuming a conversation', () => {
    const argv = buildAgyDirectTaskArgv({ resumeConversationId: 'b7875fe9-67ee-4479-b147-fdc48e787d70' });
    expect(argv).toContain('--print');
    expect(argv[argv.indexOf('--print') + 1]).toMatch(/\S/);
  });
  it.each([
    { addDirs: 'path' }, { addDirs: [''] }, { addDirs: [false] }, { model: '' }, { model: true },
    { model: '--oops' }, { effort: 'constructor' }, { effort: 'ultra' }, { sandbox: 'false' },
    ...['', '   ', false, '--continue'].map((resumeConversationId) => ({ resumeConversationId })),
    ...[0, -1, NaN, Infinity, '100', 0.5, 2147483648].map((printTimeoutMs) => ({ printTimeoutMs })),
  ])('rejects malformed options %j', (opts) => { expect(() => buildAgyDirectTaskArgv(opts)).toThrow(TypeError); });
});

describe('prompt and stdin — absolute scope and closed NDJSON message', () => {
  it('preserves special characters in one valid JSON line and spells out the constraints', () => {
    const task = '/settings\nEdit "a" using `code` and $literal \\ slash 🧪';
    const prompt = buildAgyPrompt(task, '/target with space');
    expect(prompt).toContain(task);
    expect(prompt).toContain('/target with space');
    expect(prompt).toContain('Use only absolute paths');
    expect(prompt).toContain("never trust your shell's own cwd");
    for (const command of ['git commit', 'git push', 'git add']) expect(prompt).toContain(`not run \`${command}\``);
    expect(prompt).toContain('do not open a pull request');
    expect(prompt).toContain('STOP');
    const line = buildAgyStdinLine(prompt);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
    expect(JSON.parse(line)).toEqual({ event: 'user', message: { role: 'user', content: prompt } });
  });
  it.each([undefined, '', '   ', true])('rejects invalid required task/prompt %s', (value) => {
    expect(() => buildAgyPrompt(value, '/d')).toThrow(/task/);
    expect(() => buildAgyStdinLine(value)).toThrow(/prompt/);
  });
  it.each([undefined, '', 'relative/path', true])('requires an absolute directory: %s', (value) => {
    expect(() => buildAgyPrompt('task', value)).toThrow(/absoluteDir/);
  });
});

// Literal supplied live agy 1.2.2 transcript. This test pins observed envelopes/fields, not a claim
// that mocks detect future CLI changes automatically; compare a fresh captured stream on CLI upgrades.
const REAL_EVENTS = [
  { event: 'init', conversation_id: '6ca1d89e-2836-445b-95ce-2e55e7b74106', init: { cwd: '/tmp', tools: ['ask_custom_permission', '...56 more tool names...'], permission_mode: 'request-review' } },
  { event: 'step_update', step_update: { conversation_id: '6ca1d89e-2836-445b-95ce-2e55e7b74106', step_index: 0, state: 'DONE', step_type: 'user_input' } },
  { event: 'step_update', step_update: { conversation_id: '6ca1d89e-2836-445b-95ce-2e55e7b74106', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'pong' } },
  { event: 'step_update', step_update: { conversation_id: '6ca1d89e-2836-445b-95ce-2e55e7b74106', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '\n', duration_seconds: 0.049542, usage: { input_tokens: 13115, output_tokens: 27, thinking_tokens: 26, cache_read_tokens: 0, total_tokens: 13142 } } },
  { event: 'result', result: { conversation_id: '6ca1d89e-2836-445b-95ce-2e55e7b74106', status: 'SUCCESS', response: 'pong\n', duration_seconds: 2.262411, num_turns: 1, usage: { input_tokens: 13115, output_tokens: 27, thinking_tokens: 26, cache_read_tokens: 0, total_tokens: 13142 } } },
];
// Second supplied LIVE stream, trimmed exactly as in the task (not synthesized tool wrappers).
const REAL_WRITE_EVENTS = [
  { event: 'init', conversation_id: '32e9cd5a-...', init: { cwd: '/scratch/dir', tools: [], permission_mode: 'always-proceed' } },
  { event: 'step_update', step_update: { conversation_id: '32e9cd5a-...', step_index: 0, state: 'DONE', step_type: 'user_input' } },
  { event: 'step_update', step_update: { conversation_id: '32e9cd5a-...', step_index: 8, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'pwd' } } } },
  { event: 'step_update', step_update: { conversation_id: '32e9cd5a-...', step_index: 8, state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 1.054796, tool_info: { name: 'run_command', parameters: { CommandLine: 'pwd' }, output: '/some/other/dir\n' } } },
  { event: 'step_update', step_update: { conversation_id: '32e9cd5a-...', step_index: 27, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: '/scratch/dir/NOTES.md' } } } },
  { event: 'step_update', step_update: { conversation_id: '32e9cd5a-...', step_index: 27, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: '/scratch/dir/NOTES.md' } } } },
  { event: 'step_update', step_update: { conversation_id: '32e9cd5a-...', step_index: 30, state: 'DONE', step_type: 'agent_response', text_delta: 'Created NOTES.md ...', duration_seconds: 0.255659, usage: {} } },
  { event: 'result', result: { conversation_id: '32e9cd5a-...', status: 'SUCCESS', response: 'Created NOTES.md containing:\n\n```text\nagy-direct-task-works\n```\n\nNo git commit was run.\n', duration_seconds: 38.438833, num_turns: 1, usage: { input_tokens: 137321, output_tokens: 3965, thinking_tokens: 2627, cache_read_tokens: 113377, total_tokens: 141286 } } },
];
const ERROR_EVENT = { event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'authentication failed or timed out', duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } } };
// Incident reproduction using the observed step_update.status envelope; lifecycle fields may be absent.
const WRITE_ERROR_EVENTS = [
  { event: 'step_update', step_update: { tool_name: 'write_to_file',
    tool_info: { parameters: { TargetFile: '/scratch/dir/NOTES.md' }, output: 'permission check failed' },
    status: 'TOOL_ERROR' } },
  REAL_WRITE_EVENTS.at(-1),
];
const jsonl = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

describe('summarizeAgyEvents — observed events and defensive parsing', () => {
  it('reads terminal response and inline usage, joins ACTIVE and DONE deltas per step', () => {
    const result = summarizeAgyEvents(parseJsonlEvents(jsonl(REAL_EVENTS)));
    expect(result).toEqual({ conversationId: REAL_EVENTS[0].conversation_id, toolCalls: [], toolErrors: [], filesTouched: [],
      agentMessages: ['pong\n'], terminal: 'SUCCESS', finalResponse: 'pong\n', errorMessage: null,
      usage: { input_tokens: 13115, output_tokens: 27, thinking_tokens: 26, cache_read_tokens: 0, total_tokens: 13142 } });
  });
  it('counts only DONE tools, preserving parameters/output and informational file paths', () => {
    const result = summarizeAgyEvents(REAL_WRITE_EVENTS);
    expect(result.toolErrors).toEqual([]);
    expect(result.conversationId).toBe('32e9cd5a-...');
    expect(result.toolCalls).toEqual([
      { name: 'run_command', params: { CommandLine: 'pwd' }, output: '/some/other/dir\n' },
      { name: 'write_to_file', params: { TargetFile: '/scratch/dir/NOTES.md' }, output: undefined },
    ]);
    expect(result.filesTouched).toEqual(['/scratch/dir/NOTES.md']);
    expect(result.agentMessages).toEqual(['Created NOTES.md ...']);
    expect(result.finalResponse).toBe(REAL_WRITE_EVENTS.at(-1).result.response);
    expect(result.usage.total_tokens).toBe(141286);
  });
  it.each([undefined, 'ACTIVE', 'DONE'])('retains a failed write despite terminal SUCCESS (state: %s)', (state) => {
    const [failure, terminal] = WRITE_ERROR_EVENTS;
    const events = [{ ...failure, step_update: { ...failure.step_update,
      ...(state === undefined ? {} : { state, step_type: 'tool' }) } }, terminal];
    const result = summarizeAgyEvents(parseJsonlEvents(jsonl(events)));
    expect(result.terminal).toBe('SUCCESS');
    expect(result.toolErrors).toEqual([{ name: 'write_to_file',
      params: { TargetFile: '/scratch/dir/NOTES.md' }, output: 'permission check failed' }]);
    // The additive error trace must not alter any existing summary field.
    const { toolErrors, ...existing } = result;
    const { toolErrors: cleanErrors, ...cleanExisting } = summarizeAgyEvents([
      { ...events[0], step_update: { ...events[0].step_update, status: 'SUCCESS' } }, terminal,
    ]);
    expect(existing).toEqual(cleanExisting);
    expect(cleanErrors).toEqual([]);
  });
  it('collects every error, including non-writers and missing tool details', () => {
    const result = summarizeAgyEvents([WRITE_ERROR_EVENTS[0],
      { event: 'step_update', step_update: { tool_name: 'view_file', status: 'TOOL_ERROR' } },
      { event: 'step_update' }, WRITE_ERROR_EVENTS[1]]);
    expect(result.toolErrors).toEqual([
      { name: 'write_to_file', params: { TargetFile: '/scratch/dir/NOTES.md' }, output: 'permission check failed' },
      { name: 'view_file', params: undefined, output: undefined },
    ]);
  });
  it('reports auth ERROR with no tools; the LAST result owns all terminal fields', () => {
    const result = summarizeAgyEvents([ERROR_EVENT]);
    expect(result).toMatchObject({ conversationId: null, terminal: 'ERROR', finalResponse: '',
      errorMessage: 'authentication failed or timed out', toolCalls: [], usage: ERROR_EVENT.result.usage });
    expect(summarizeAgyEvents([...REAL_EVENTS, ERROR_EVENT])).toMatchObject({ terminal: 'ERROR', usage: ERROR_EVENT.result.usage });
  });
  it('does not infer a terminal from completed tools, step usage, empty or malformed output', () => {
    for (const events of [[], undefined, null, {}, [null, 3, 'bad', {}, { event: 'step_update' }], REAL_EVENTS.slice(0, -1)]) {
      expect(summarizeAgyEvents(events).terminal).toBeNull();
      expect(summarizeAgyEvents(events).usage).toEqual({});
    }
    expect(parseJsonlLine(null)).toBeNull();
    expect(parseJsonlEvents(undefined)).toEqual([]);
    expect(summarizeAgyEvents(parseJsonlEvents('broken\n{"event":"result","result":false}'))).toMatchObject({ terminal: null });
  });
  it('recognizes best-effort path aliases on writers only (synthetic edge cases)', () => {
    const tools = ['write_to_file', 'replace_file_content', 'sed_file', 'multi_replace_file_content', 'notebook_edit'];
    const events = tools.map((tool_name, i) => ({ event: 'step_update', step_update: { state: 'DONE', step_type: 'tool', tool_name,
      tool_info: { parameters: { [['TargetFile', 'file_path', 'path', 'FilePath', 'NotebookPath'][i]]: `/d/${i}` } } } }));
    events.push({ event: 'step_update', step_update: { state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { TargetFile: '/read' } } } });
    expect(summarizeAgyEvents(events).filesTouched).toEqual(tools.map((_, i) => `/d/${i}`));
  });
});

/** Records argv/cwd/stdin and streams arbitrary chunks; no real process or shell. */
function fakeSpawn(stdout, { code = 0, stderr = '', hang = false, error = null, chunks } = {}) {
  const seen = { stdin: '', ended: false, child: null };
  const fn = vi.fn((cli, argv, opts) => {
    Object.assign(seen, { cli, argv, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (text) => { seen.stdin = text; seen.ended = true; };
    child.kill = vi.fn(() => { setTimeout(() => child.emit('close', null), 1); return true; });
    seen.child = child;
    setTimeout(() => {
      for (const chunk of chunks ?? [stdout]) child.stdout.emit('data', Buffer.from(chunk));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      if (error) child.emit('error', new Error(error));
      if (!hang) child.emit('close', code);
    }, 0);
    return child;
  });
  return { fn, seen };
}

function fakeExec(calls = []) {
  return vi.fn((bin, args, opts) => {
    calls.push({ bin, args, opts });
    if (args.includes('--absolute-git-dir')) return join(args[1], 'git-metadata');
    if (args.includes('rev-parse')) return 'startsha123\n';
    if (args.includes('status')) return '?? new-file.txt\0 M edited.txt\0';
    if (args.includes('--stat')) return '2 files changed\n';
    if (args.includes('diff')) return 'diff --git a/edited.txt b/edited.txt\n+change';
    return '';
  });
}

describe('runAgyDirectExec / geminiDirectTask — injected process mechanics', () => {
  it('isolates injected processes from persisted host quota reads and writes', async () => {
    const dir = tempDir();
    vi.stubEnv('ANTIGRAVITY_QUOTA_DIR', join(dir, 'quota'));
    saveAgyHold({ requestedModel: 'gemini-3.1-pro', servedBackend: 'google', quotaState: 'exhausted',
      quotaResetsAt: new Date(Date.now() + 60_000).toISOString() });
    const { fn } = fakeSpawn(jsonl([{ event: 'init', init: { model: 'claude-sonnet-4-6' } }]),
      { stderr: 'Individual quota reached. Resets in 1h.' });
    const result = await runAgyDirectExec({ dir, task: 't', logFile: join(dir, 'run.jsonl'), stream: false, spawnFn: fn });
    expect(fn).toHaveBeenCalledOnce();
    expect(result.fallbackDecision).toBe('skip-quota-exhausted');
    expect(readAgyHold('claude-sonnet-4-6')).toBeNull();
    expect(readAgyHold('gemini-3.1-pro')).not.toBeNull();
  });

  it('still enforces persisted quota holds before a real process launch', async () => {
    const dir = tempDir();
    vi.stubEnv('ANTIGRAVITY_QUOTA_DIR', join(dir, 'quota'));
    saveAgyHold({ requestedModel: 'gemini-3.1-pro', servedBackend: 'google', quotaState: 'exhausted',
      quotaResetsAt: new Date(Date.now() + 60_000).toISOString() });
    const result = await runAgyDirectExec({ dir, task: 't', logFile: join(dir, 'run.jsonl'), stream: false,
      cli: join(dir, 'must-not-launch') });
    expect(result).toMatchObject({ code: 1, fallbackDecision: 'skip-quota-hold', modelEvidence: 'not-launched' });
  });

  it('recovers the init UUID after SIGKILL and resumes once with a fresh budget and no task replay', async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const id = 'afa6b941-eb5d-4652-9471-4bae369c1cbd';
    // The supplied real-timeout ID and init envelope, followed by an unfinished JSONL line.
    const partial = jsonl([{ event: 'init', conversation_id: id }]) + '{"event":"step_update"';
    const first = fakeSpawn(partial, { hang: true, stderr: 'first attempt interrupted' });
    const second = fakeSpawn('', { hang: true });
    const spawnFn = vi.fn().mockImplementationOnce(first.fn).mockImplementationOnce(second.fn);
    const execFn = fakeExec();
    const pending = geminiDirectTask({ dir, task: 'original task', stream: false, timeoutMs: 20,
      model: 'chosen', effort: 'high', addDirs: ['/extra'], sandbox: true, gate: 'standards', execFn, spawnFn });
    await vi.advanceTimersByTimeAsync(20);
    expect(first.seen.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawnFn).toHaveBeenCalledTimes(1); // wait for close/output drain before starting the resume
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(second.seen.argv).toEqual(['--input-format', 'text', '--output-format', 'stream-json',
      '--disable-slash-commands', '--dangerously-skip-permissions', '--add-dir', '/extra',
      '--model', 'chosen', '--effort', 'high', '--sandbox', '--print-timeout', '0.02s',
      '--conversation', id, '--print', AGY_RESUME_PROMPT]);
    expect(second.seen.opts).toEqual(first.seen.opts);
    expect(first.seen.stdin).toContain('original task');
    expect(second.seen.ended).toBe(true);
    expect(second.seen.stdin).toBeUndefined();
    await vi.advanceTimersByTimeAsync(19); // almost a full new budget after the original wall expired
    expect(second.seen.child.kill).not.toHaveBeenCalled();
    const result = jsonl([{ event: 'result', result: { status: 'SUCCESS', response: 'Finished resumed task' } }]);
    second.seen.child.stdout.emit('data', Buffer.from(result));
    second.seen.child.emit('close', 0);
    const report = await pending;
    expect(report).toMatchObject({ exitCode: 0, timedOut: false, resumed: true, resumeConversationId: id,
      events: { conversationId: id, terminal: 'SUCCESS', finalResponse: 'Finished resumed task', errorMessage: null },
      diff: { hasChanges: true }, gate: { ran: true, pass: true } });
    expect(report.argv).toEqual(second.seen.argv);
    expect(readFileSync(report.logFile, 'utf8')).toBe(partial + '\n' + result);
    expect(execFn.mock.calls.filter(([, args]) => args.includes('check:standards'))).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, null])('resumes a mid-run crash with exit code %s and an init ID', async (code) => {
    const first = fakeSpawn(jsonl(REAL_EVENTS.slice(0, 2)), { code });
    const second = fakeSpawn(jsonl(REAL_EVENTS));
    const spawnFn = vi.fn().mockImplementationOnce(first.fn).mockImplementationOnce(second.fn);
    const report = await geminiDirectTask({ dir: tempDir(), task: 't', stream: false, execFn: fakeExec(), spawnFn });
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(second.seen.argv.slice(-4)).toEqual(['--conversation', REAL_EVENTS[0].conversation_id, '--print', AGY_RESUME_PROMPT]);
    expect(second.seen.argv[second.seen.argv.indexOf('--print') + 1]).toMatch(/\S/);
    expect(report).toMatchObject({ resumed: true, resumeConversationId: REAL_EVENTS[0].conversation_id,
      exitCode: 0, timedOut: false, events: { terminal: 'SUCCESS' } });
  });

  it.each([true, false])('does not retry without a conversation ID (timeout: %s)', async (hang) => {
    vi.useFakeTimers();
    const { fn: spawnFn } = fakeSpawn('partial non-JSON output', { hang, code: 1 });
    const pending = geminiDirectTask({ dir: tempDir(), task: 't', stream: false, timeoutMs: 20,
      execFn: fakeExec(), spawnFn });
    await vi.runAllTimersAsync();
    const report = await pending;
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ resumed: false, resumeConversationId: null, timedOut: hang,
      exitCode: hang ? null : 1, events: { conversationId: null, terminal: null }, diff: { hasChanges: true } });
  });

  it.each(['timeout', 'crash', 'terminal error'])('caps the retry at one after a second %s', async (failure) => {
    vi.useFakeTimers();
    // Even a stale SUCCESS before a timeout must not mask a subsequent failed resume.
    const first = fakeSpawn(jsonl(REAL_EVENTS), { hang: true });
    const second = fakeSpawn(jsonl(failure === 'terminal error' ? [REAL_EVENTS[0], ERROR_EVENT] : [REAL_EVENTS[0]]),
      { hang: failure === 'timeout', code: 1 });
    const spawnFn = vi.fn().mockImplementationOnce(first.fn).mockImplementationOnce(second.fn);
    const pending = geminiDirectTask({ dir: tempDir(), task: 't', stream: false, timeoutMs: 20,
      execFn: fakeExec(), spawnFn });
    await vi.runAllTimersAsync();
    const report = await pending;
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ resumed: true, resumeConversationId: REAL_EVENTS[0].conversation_id,
      timedOut: failure === 'timeout', exitCode: failure === 'timeout' ? null : 1,
      events: { terminal: failure === 'terminal error' ? 'ERROR' : null }, diff: { hasChanges: true } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1])('does not resume a completed terminal failure (exit %s)', async (code) => {
    const { fn: spawnFn } = fakeSpawn(jsonl([REAL_EVENTS[0], ERROR_EVENT]), { code });
    const report = await geminiDirectTask({ dir: tempDir(), task: 't', stream: false, execFn: fakeExec(), spawnFn });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ resumed: false, resumeConversationId: null, exitCode: code, events: { terminal: 'ERROR' } });
  });

  it.each([
    ['SIGINT', false], ['SIGINT', true], ['SIGTERM', false], ['SIGTERM', true],
  ])('kills the child group and re-delivers %s (group kill throws: %s)', async (signal, groupKillThrows) => {
    const counts = ['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s));
    const dir = mkdtempSync(join(tmpdir(), 'we-direct-signal-test-'));
    const child = new EventEmitter();
    child.pid = 12345;
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null)); });
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === process.pid) {
        expect(['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s))).toEqual(counts);
      } else if (groupKillThrows) throw new Error('group unavailable');
      return true;
    });
    try {
      const pending = runAgyDirectExec({
        dir, task: 't', logFile: join(dir, 'events.jsonl'), stream: false, spawnFn: () => child,
      });
      process.emit(signal);
      const result = await pending;
      expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(kill).toHaveBeenCalledWith(process.pid, signal);
      expect(result).toMatchObject({ code: null, timedOut: false });
      expect(['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s))).toEqual(counts);
    } finally {
      kill.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves UTF-8 split inside an emoji in both the JSONL log and parsed summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-gemini-utf8-test-'));
    const logFile = join(dir, 'events.jsonl');
    const counts = ['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s));
    const message = 'Updated café 🚀';
    const stdout = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: message } }) + '\n';
    const bytes = Buffer.from(stdout);
    const split = bytes.indexOf(Buffer.from('🚀')) + 2;
    const { fn } = fakeSpawn(stdout, { chunks: [bytes.subarray(0, split), bytes.subarray(split)] });
    try {
      const result = await runAgyDirectExec({ dir, task: 't', logFile, stream: false, spawnFn: fn });
      expect(['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s))).toEqual(counts);
      expect(result.stdout).toBe(stdout);
      expect(readFileSync(logFile, 'utf8')).toBe(stdout);
      expect(summarizeAgyEvents(parseJsonlEvents(result.stdout)).finalResponse).toBe(message);
      expect(result.stdout).not.toContain('�');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])('uses the real git directory for a linked worktree default log and preserves explicit logs (explicit: %s)', async (explicitLog) => {
    const dir = mkdtempSync(join(tmpdir(), 'we-gemini-direct-worktree-test-'));
    const worktree = join(dir, 'linked');
    try {
      const git = initGitRepo(dir);
      git('worktree', 'add', '--quiet', '--detach', worktree, 'HEAD');
      expect(statSync(join(worktree, '.git')).isFile()).toBe(true);
      const gitDir = execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
      const stdout = '{}\n';
      const { fn: spawnFn, seen } = fakeSpawn(stdout);
      const logFile = explicitLog ? join(dir, 'logs', 'custom.jsonl') : undefined;
      const report = await geminiDirectTask({ dir: worktree, task: 'Inspect the checkout', stream: false, spawnFn, logFile });
      expect(seen.opts.cwd).toBe(worktree);
      expect(report.exitCode).toBe(0);
      expect(report.logFile).toBe(logFile ?? join(gitDir, 'gemini-direct-task.jsonl'));
      expect(report.logFile.startsWith(join(worktree, '.git') + '/')).toBe(false);
      expect(readFileSync(report.logFile, 'utf8')).toBe(stdout);
      expect(report.diff.hasChanges).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('spawns exact argv in cwd, closes valid stdin JSON, logs chunked JSONL even with no-stream', async () => {
    const dir = tempDir();
    const logFile = join(dir, 'events.jsonl');
    const stdout = jsonl(REAL_EVENTS);
    const { fn, seen } = fakeSpawn(stdout, { chunks: [stdout.slice(0, 30), stdout.slice(30)] });
    const opts = { model: 'future-model', effort: 'high', addDirs: ['/other'], sandbox: true, timeoutMs: 5010 };
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = await runAgyDirectExec({ dir, task: '/settings\nDo the thing', logFile, stream: false, spawnFn: fn, ...opts });
    expect(seen.cli).toBe(AGY_CLI);
    expect(seen.argv).toEqual(buildAgyDirectTaskArgv({ ...opts, printTimeoutMs: 5010 }));
    expect(seen.opts).toEqual({ cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    expect(seen.stdin).toBe(buildAgyStdinLine(buildAgyPrompt('/settings\nDo the thing', dir)));
    expect(JSON.parse(seen.stdin).message.content).toContain('do not run `git commit`');
    expect(seen.argv.join(' ')).not.toContain('Do the thing');
    expect(seen.ended).toBe(true);
    expect(result).toMatchObject({ stdout, stderr: '', code: 0, timedOut: false, argv: seen.argv });
    expect(readFileSync(logFile, 'utf8')).toBe(stdout);
    expect(output).not.toHaveBeenCalled();
  });
  it('streams live by default and accepts an explicit binary override', async () => {
    const dir = tempDir();
    const { fn, seen } = fakeSpawn('event\n', { code: 1, stderr: 'remedy' });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const r = await runAgyDirectExec({ dir, task: 't', logFile: join(dir, 'log'), cli: '/bin/custom-agy', spawnFn: fn });
    expect(output).toHaveBeenCalledWith('event\n');
    expect(seen.cli).toBe('/bin/custom-agy');
    expect(r).toMatchObject({ code: 1, stderr: 'remedy' });
  });
  it.each([false, true])('SIGKILLs the process group and child on timeout (group kill throws: %s)', async (groupKillThrows) => {
    const groupKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (groupKillThrows) throw new Error('group unavailable');
      return true;
    });
    vi.useFakeTimers();
    const dir = tempDir();
    const { fn, seen } = fakeSpawn(jsonl(REAL_EVENTS.slice(0, 2)), { hang: true });
    const pending = runAgyDirectExec({ dir, task: 't', logFile: join(dir, 'log'), stream: false, timeoutMs: 5, spawnFn: fn });
    seen.child.pid = 12345;
    await vi.advanceTimersByTimeAsync(6);
    const r = await pending;
    expect(seen.opts.detached).toBe(true);
    expect(groupKill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    expect(seen.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(r).toMatchObject({ code: null, timedOut: true, stdout: jsonl(REAL_EVENTS.slice(0, 2)) });
    expect(summarizeAgyEvents(parseJsonlEvents(r.stdout)).terminal).toBeNull();
  });
  it.each(['throw', 'event'])('resolves a %s spawn failure with stderr and no invented terminal', async (mode) => {
    const dir = tempDir();
    const spawnFn = mode === 'throw' ? () => { throw new Error('ENOENT'); } : fakeSpawn('', { error: 'ENOENT' }).fn;
    await expect(runAgyDirectExec({ dir, task: 't', logFile: join(dir, 'log'), stream: false, spawnFn }))
      .resolves.toMatchObject({ code: null, stderr: 'ENOENT\n', timedOut: false });
  });
  it('resolves validation/log creation failures without spawning', async () => {
    const spawnFn = vi.fn();
    const r = await runAgyDirectExec({ dir: '/d', task: 't', logFile: join(tempDir(), 'missing/log'), spawnFn });
    expect(r.code).toBeNull();
    expect(r.stderr).toMatch(/ENOENT/);
    expect(spawnFn).not.toHaveBeenCalled();
  });
  it('explicit dir: resolves absolute target, records start SHA, then diffs and gates without cloning', async () => {
    const dir = tempDir();
    const calls = [];
    const execFn = fakeExec(calls);
    const { fn: spawnFn, seen } = fakeSpawn(jsonl(REAL_WRITE_EVENTS));
    const report = await geminiDirectTask({ task: 'edit a file', dir, gate: 'full', stream: false, execFn, spawnFn });
    expect(report).toMatchObject({ dir, scratch: { created: false }, startSha: 'startsha123', exitCode: 0,
      timedOut: false, resumed: false, resumeConversationId: null,
      events: { terminal: 'SUCCESS' }, diff: { hasChanges: true }, gate: { pass: true, mode: 'full' } });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(report.argv).toEqual(seen.argv);
    expect(report.logFile).toBe(join(dir, 'git-metadata', 'gemini-direct-task.jsonl'));
    expect(Object.keys(report).sort()).toEqual(['model', 'effort', 'dir', 'scratch', 'startSha', 'argv', 'logFile', 'exitCode', 'timedOut', 'resumed', 'resumeConversationId', 'events', 'diff', 'gate', 'requestedModel', 'servedModel', 'servedBackend', 'modelEvidence', 'quotaState', 'quotaResetsAt', 'fallbackDecision'].sort());
    expect(calls[0].args).toEqual(['-C', dir, 'rev-parse', 'HEAD']);
    expect(calls.some((c) => c.args.includes('clone'))).toBe(false);
    expect(calls.some((c) => c.args.join(' ') === `-C ${dir} diff startsha123`)).toBe(true);
    expect(calls.filter((c) => c.bin === 'git').every((c) => !c.args.includes('commit') && !c.args.includes('push') && (!c.args.includes('add') || c.args.includes('--intent-to-add')))).toBe(true);
  });
  it('no dir + repoRoot: clones FIRST, runs agy in clone, diffs clone, never source', async () => {
    const dir = tempDir();
    const calls = [];
    const execFn = fakeExec(calls);
    const { fn, seen } = fakeSpawn(jsonl(REAL_EVENTS));
    const spawnFn = (...args) => { expect(calls[0].args).toEqual(['clone', '--quiet', '/source', dir]); return fn(...args); };
    const r = await geminiDirectTask({ task: 't', repoRoot: '/source', stream: false, execFn, spawnFn,
      mkTempDir: () => dir, existsFn: () => false });
    expect(r.scratch).toEqual({ created: true, source: '/source', depsInstall: null, realOrigin: null, originWired: false });
    expect(seen.opts.cwd).toBe(dir);
    expect(calls.filter((c) => c.args.includes('diff')).every((c) => c.args[1] === dir)).toBe(true);
    expect(calls.filter((c) => c.bin === 'git').every((c) => !c.args.includes('commit') && !c.args.includes('push') && (!c.args.includes('add') || c.args.includes('--intent-to-add')))).toBe(true);
  });
  it.each([{ task: 't' }, { task: '' }, { task: 't', dir: '' }, { task: 't', dir: '/d', timeoutMs: NaN }, { task: 't', dir: '/d', gate: 'oops' }])('rejects missing/invalid required fields before mutations: %j', async (opts) => {
    const execFn = vi.fn(); const spawnFn = vi.fn();
    await expect(geminiDirectTask({ ...opts, execFn, spawnFn })).rejects.toThrow();
    expect(execFn).not.toHaveBeenCalled(); expect(spawnFn).not.toHaveBeenCalled();
  });
  it('rejects nonexistent target', async () => {
    await expect(geminiDirectTask({ task: 't', dir: '/missing', existsFn: () => false, execFn: vi.fn() })).rejects.toThrow(/does not exist/);
  });
  it('captures diff even after startup failure and preserves the stderr remedy', async () => {
    const dir = tempDir();
    const report = await geminiDirectTask({ dir, task: 't', stream: false, execFn: fakeExec(), spawnFn: () => { throw new Error('install agy'); } });
    expect(report.events).toMatchObject({ terminal: null, errorMessage: 'install agy' });
    expect(report.diff.hasChanges).toBe(true);
  });
});

describe('CLI — flag parsing and truthful reports without a real process', () => {
  const report = {
    dir: '/d', scratch: { created: false }, startSha: 'abc', argv: [], logFile: '/d/.git/log', exitCode: 0, timedOut: false,
    events: summarizeAgyEvents(REAL_EVENTS), diff: { status: ' M file', diff: '+actual change', diffStat: '1 file', commits: [], hasChanges: true },
    gate: { ran: false, mode: 'none', pass: true, steps: [] },
  };
  it.each([
    ['write_to_file', 1], ['replace_file_content', 1], ['sed_file', 1],
    ['multi_replace_file_content', 1], ['notebook_edit', 1], ['view_file', 0], ['run_command', 0],
  ])('surfaces %s TOOL_ERROR followed by SUCCESS and sets wrapper exit %s', async (tool_name, exitCode) => {
    const dir = tempDir();
    const [failure, terminal] = WRITE_ERROR_EVENTS;
    const events = [{ ...failure, step_update: { ...failure.step_update, tool_name } }, terminal];
    const { fn: spawnFn } = fakeSpawn(jsonl(events));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = 0;
    const result = await main(['--task=t', `--dir=${dir}`, '--no-stream'], {
      taskFn: (opts) => geminiDirectTask({ ...opts, execFn: fakeExec(), spawnFn }),
    });
    expect(result).toMatchObject({ exitCode: 0, events: { terminal: 'SUCCESS',
      toolErrors: [{ name: tool_name, output: 'permission check failed' }] } });
    expect(process.exitCode).toBe(exitCode);
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledOnce();
    const text = output.mock.calls[0][0];
    expect(text.split('\n')[2]).toBe('WARNING: TOOL ERRORS DURING RUN (1) — the terminal status above may not reflect real success:');
    expect(text).toContain(`${tool_name}: permission check failed`);
  });
  it('preserves equals inside values and repeated add-dir flags', () => {
    expect(parseFlags(['--task=a=b', '--add-dir=/one', '--add-dir=/two', '--sandbox'])).toEqual({ task: 'a=b', 'add-dir': ['/one', '/two'], sandbox: true });
  });
  it.each(['--unknown', 'positional', '--dir', '--task=', '--sandbox=false'])('rejects malformed CLI input %s', (arg) => {
    expect(() => parseFlags([arg])).toThrow();
  });
  it('wires every value/boolean flag and emits exactly one JSON report', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const taskFn = vi.fn(async () => report);
    const readFileFn = vi.fn(() => 'task from file');
    await main(['--task-file=task.txt', '--dir=target', '--repo-root=repo', '--model=chosen', '--effort=medium',
      '--add-dir=one', '--add-dir=two', '--sandbox', '--timeout-ms=1234', '--gate=full', '--no-stream', '--log=log.jsonl', '--no-install', '--json'], { taskFn, readFileFn });
    expect(readFileFn).toHaveBeenCalledWith(resolve('task.txt'), 'utf8');
    expect(taskFn).toHaveBeenCalledWith(expect.objectContaining({ task: 'task from file', dir: resolve('target'),
      repoRoot: resolve('repo'), model: 'chosen', effort: 'medium', addDirs: [resolve('one'), resolve('two')], sandbox: true,
      timeoutMs: 1234, gate: 'full', stream: false, logFile: resolve('log.jsonl'), installDeps: false }));
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output.mock.calls[0][0])).toEqual(report);
  });
  it('JSON implies no-stream even without an explicit no-stream flag', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const taskFn = vi.fn(async () => report);
    await main(['--task=t', '--repo-root=/repo', '--json'], { taskFn });
    expect(taskFn).toHaveBeenCalledWith(expect.objectContaining({ dir: undefined, repoRoot: '/repo', stream: false, timeoutMs: DEFAULT_TIMEOUT_MS, model: undefined, effort: undefined }));
  });
  it('help never invokes a task and documents confinement limits inline', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const taskFn = vi.fn();
    await main(['--help'], { taskFn });
    expect(taskFn).not.toHaveBeenCalled();
    expect(output.mock.calls[0][0]).toContain('bookkeeping only');
    expect(output.mock.calls[0][0]).toContain("NOT agy's own native file tools");
    expect(output.mock.calls[0][0]).toContain('resume exactly once via --conversation <ID>');
    expect(output.mock.calls[0][0]).toContain('No ID means no retry');
    expect(output.mock.calls[0][0]).toContain('up to twice --timeout-ms');
  });
  it.each([{ argv: [] }, { argv: ['--task=t', '--task-file=f'] }])('requires exactly one task source: %j', async ({ argv }) => {
    await expect(main(argv, { taskFn: vi.fn() })).rejects.toThrow(/exactly one/);
  });
  it('prints the full diff, actual status, and sandbox limitation prominently', () => {
    const text = formatReport(report);
    expect(text).toContain('+actual change');
    expect(text).toContain(' M file');
    expect(text).toContain('NOTHING WAS COMMITTED OR PUSHED BY THIS SCRIPT');
    expect(text).toContain('NO real sandbox');
    expect(text).toContain('even with --sandbox on');
    expect(text.indexOf('NO real sandbox')).toBeLessThan(text.indexOf('+actual change'));
  });
  it('does not falsely claim the agent made no commits when git log says otherwise', () => {
    const text = formatReport({ ...report, diff: { ...report.diff, commits: ['bad123 unwanted commit'] } });
    expect(text).toContain('AGENT MADE COMMITS');
    expect(text).toContain('bad123 unwanted commit');
    expect(text).toContain('NO real sandbox');
  });
  it('shows the resumed conversation in the human report', () => {
    expect(formatReport({ ...report, resumed: true, resumeConversationId: 'known-id' })).toContain('resumed once: known-id');
  });
  it.each([
    { exitCode: 1 }, { timedOut: true }, { events: { ...report.events, terminal: 'ERROR' } },
    { events: { ...report.events, terminal: null } }, { gate: { ...report.gate, pass: false } },
  ])('sets a failure exit status while still printing a report: %j', async (failure) => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--task=t', '--dir=/d', '--json'], { taskFn: async () => ({ ...report, ...failure }) });
    expect(process.exitCode).toBe(1);
    expect(output).toHaveBeenCalledOnce();
  });
});
