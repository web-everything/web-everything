// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgyReviewJuror, stateChangingToolCalls } from '../agy-review-juror.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const transcript = (steps) => steps.map((step_update) => JSON.stringify({ event: 'step_update', step_update })).join('\n');
const tool = (path, extra = {}) => ({
  step_type: 'tool', step_index: 1, conversation_id: 'own-id', state: 'DONE', tool_name: 'view_file',
  tool_info: { parameters: { AbsolutePath: path } }, ...extra,
});
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (dir) => { git(dir, 'add', '.'); git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'); };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agy-escape-'));
  roots.push(root);
  const lane = join(root, 'review');
  const shared = join(root, 'shared');
  const extra = join(root, 'extra');
  const home = join(root, 'home');
  mkdirSync(lane);
  mkdirSync(home);
  git(lane, 'init', '-q');
  writeFileSync(join(lane, 'file.txt'), 'initial\n');
  writeFileSync(join(lane, 'untouched.txt'), 'initial\n');
  commit(lane);
  execFileSync('git', ['clone', '-q', lane, shared]);
  execFileSync('git', ['clone', '-q', lane, extra]);
  const calls = [];
  let mutated = false;
  const run = (act = () => {}, steps = (cwd) => [tool(join(cwd, 'file.txt'))], options = {}) => runAgyReviewJuror({
    request: { mandate: 'review', input: 'diff', shape: {} }, laneCwd: lane, model: 'test', watch: [extra],
    deps: {
      repoRoot: shared, home,
      mkTempDir: () => mkdtempSync(join(root, 'juror-')),
      exec: (bin, args) => {
        calls.push({ bin, args, after: mutated });
        if (options.unreadable && args.includes(options.unreadable)) throw new Error('unreadable fixture');
        return execFileSync(bin, bin === 'git' ? ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args] : args,
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      },
      spawnJudge: async ({ cwd }) => {
        act(cwd);
        mutated = true;
        const t = join(root, 'transcript.jsonl');
        writeFileSync(t, transcript(steps(cwd)));
        return { value: { summary: 'review', findings: [] }, sessionId: 'own-id', transcriptFile: t };
      },
      readFile: (p) => readFileSync(p, 'utf8'),
      removeDir: (p) => rmSync(p, { recursive: true, force: true }),
    },
  });
  return { root, lane, shared, extra, home, calls, run };
}
const touchedReason = 'change outside the juror lane touched by the juror: this checkout';

describe('shared checkouts correlate changes with every transcript tool update', () => {
  it('a shared HEAD reset and tracked edit do not void a juror reading only its lane', async () => {
    const fx = fixture();
    const out = await fx.run(() => {
      writeFileSync(join(fx.shared, 'file.txt'), 'new main\n');
      commit(fx.shared);
      writeFileSync(join(fx.shared, 'untouched.txt'), 'concurrent edit\n');
    });
    expect(out.status).toBe('ok');
    expect(out.reasons).toEqual([]);
    expect(fx.calls.some(({ args }) => args.includes('diff') && args.includes('--name-only'))).toBe(true);
  });

  it.each(['working tree', 'HEAD', 'already dirty'])('a %s change named by an errored tool voids', async (kind) => {
    const fx = fixture();
    if (kind === 'already dirty') writeFileSync(join(fx.shared, 'file.txt'), 'dirty before\n');
    const out = await fx.run(() => {
      writeFileSync(join(fx.shared, 'file.txt'), 'changed\n');
      if (kind === 'HEAD') commit(fx.shared);
    }, () => [tool(join(fx.shared, 'file.txt'), { status: 'TOOL_ERROR', tool_name: kind === 'already dirty' ? 'write_to_file' : 'view_file' })]);
    expect(out.status).toBe('voided');
    expect(out.reasons).toEqual([touchedReason]);
    expect(out.value).toBeUndefined();
    expect(out.reasons.join(' ')).not.toContain(fx.root);
  });

  it('a HEAD rename includes the touched old pathname', async () => {
    const fx = fixture();
    const out = await fx.run(() => {
      git(fx.shared, 'mv', 'file.txt', 'renamed.txt');
      commit(fx.shared);
    }, () => [tool(join(fx.shared, 'file.txt'), { status: 'TOOL_ERROR' })]);
    expect(out.reasons).toEqual([touchedReason]);
  });

  it('only changed dirty paths count, not an unchanged dirty path the juror named', async () => {
    const fx = fixture();
    writeFileSync(join(fx.shared, 'file.txt'), 'dirty before\n');
    const out = await fx.run(() => writeFileSync(join(fx.shared, 'untouched.txt'), 'changed\n'),
      () => [tool(join(fx.shared, 'file.txt'), { status: 'TOOL_ERROR' })]);
    expect(out.status).toBe('ok');
  });

  it.each(['directory', 'parent', 'nested URI', 'later update'])('matches a touched %s path', async (kind) => {
    const fx = fixture();
    const steps = () => {
      const path = kind === 'parent' ? fx.root : fx.shared;
      if (kind === 'nested URI') return [tool('', { status: 'TOOL_ERROR', tool_info: { parameters: JSON.stringify({ Target: { Files: [`file://${join(fx.shared, 'file.txt')}`] } }) } })];
      if (kind === 'later update') return [tool('file.txt', { state: 'ACTIVE' }), tool(join(fx.shared, 'file.txt'), { status: 'TOOL_ERROR' })];
      return [tool(path, { status: 'TOOL_ERROR' })];
    };
    const out = await fx.run(() => writeFileSync(join(fx.shared, 'file.txt'), 'changed\n'), steps);
    expect(out.reasons).toContain(touchedReason);
  });

  it('extra watched directories use the same shared rule', async () => {
    const fx = fixture();
    expect((await fx.run(() => writeFileSync(join(fx.extra, 'file.txt'), 'changed\n'))).status).toBe('ok');
    const out = await fx.run(() => writeFileSync(join(fx.extra, 'file.txt'), 'changed again\n'),
      () => [tool(join(fx.extra, 'file.txt'), { status: 'TOOL_ERROR' })]);
    expect(out.reasons).toContain('change outside the juror lane touched by the juror: watched checkout #3');
  });

  it.each([false, true])('changed shared control files skip post-run git (touched=%s)', async (touched) => {
    const fx = fixture();
    const out = await fx.run(() => writeFileSync(join(fx.shared, '.gitattributes'), '*.txt filter=hostile\n'),
      (cwd) => [tool(touched ? join(fx.shared, 'unrelated.txt') : join(cwd, 'file.txt'), { status: 'TOOL_ERROR' })]);
    expect(out.status).toBe(touched ? 'voided' : 'ok');
    expect(out.reasons).toEqual(touched ? [touchedReason] : []);
    expect(fx.calls.filter(({ args, after }) => after && args.includes(fx.shared))).toEqual([]);
  });

  it.each([false, true])('unreadable shared snapshots void only if touched (touched=%s)', async (touched) => {
    const fx = fixture();
    const out = await fx.run(undefined,
      (cwd) => [tool(touched ? join(fx.shared, 'file.txt') : join(cwd, 'file.txt'), { status: 'TOOL_ERROR' })],
      { unreadable: fx.shared });
    expect(out.status).toBe(touched ? 'voided' : 'ok');
    expect(out.reasons).toEqual(touched ? [touchedReason] : []);
  });

  it('review lane changes remain strict', async () => {
    const fx = fixture();
    const out = await fx.run(() => writeFileSync(join(fx.lane, 'file.txt'), 'changed\n'));
    expect(out.status).toBe('voided');
    expect(out.reasons).toContain('change outside the juror lane: the review lane');
  });

  it('juror lane changes remain strict', async () => {
    const fx = fixture();
    const out = await fx.run((cwd) => writeFileSync(join(cwd, 'file.txt'), 'changed\n'));
    expect(out.status).toBe('voided');
    expect(out.reasons.join(' ')).toContain('juror lane changed on a read-only seat');
  });
});

describe('own brain reads extend only the read allowlist', () => {
  it('a completed own-session view_file is allowed by the runner', async () => {
    const fx = fixture();
    const own = join(fx.home, '.gemini', 'antigravity-cli', 'brain', 'own-id');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'task.md'), 'session task');
    const out = await fx.run(undefined, () => [tool(join(own, 'task.md'))]);
    expect(out.status).toBe('ok');
  });

  it.each(['other-id/x', ''])('reads of brain/%s still void', async (suffix) => {
    const fx = fixture();
    const out = await fx.run(undefined, () => [tool(join(fx.home, '.gemini', 'antigravity-cli', 'brain', suffix))]);
    expect(out.status).toBe('voided');
    expect(out.reasons.join(' ')).toContain('view_file (read outside the juror lane)');
  });

  it.each(['outside', 'brain'])('completed writes to %s still void', async (target) => {
    const fx = fixture();
    const path = target === 'brain' ? join(fx.home, '.gemini', 'antigravity-cli', 'brain', 'own-id', 'task.md') : join(fx.root, 'outside.txt');
    const out = await fx.run(undefined, () => [tool(path, { tool_name: 'write_to_file' })]);
    expect(out.status).toBe('voided');
    expect(out.reasons.join(' ')).toContain('completed state-changing tool call(s): write_to_file');
  });

  it('ids may come from the outcome or transcript and invalid ids grant no root', () => {
    const fx = fixture();
    const brain = join(fx.home, '.gemini', 'antigravity-cli', 'brain');
    const options = { home: fx.home, allowedRoots: [fx.lane] };
    expect(stateChangingToolCalls(transcript([tool(join(brain, 'own-id', 'task.md'))]), options)).toEqual([]);
    expect(stateChangingToolCalls(transcript([tool(join(brain, 'outcome-id', 'task.md'), { conversation_id: undefined })]), { ...options, sessionId: 'outcome-id' })).toEqual([]);
    for (const id of ['.', '..', '../other', '', 'bad/id']) {
      expect(stateChangingToolCalls(transcript([tool(brain, { conversation_id: id })]), { ...options, sessionId: id })).toEqual(['view_file (read outside the juror lane)']);
    }
  });

  it('follows symlinks in brain reads before checking containment', () => {
    const fx = fixture();
    const own = join(fx.home, '.gemini', 'antigravity-cli', 'brain', 'own-id');
    mkdirSync(own, { recursive: true });
    symlinkSync(fx.shared, join(own, 'escape'));
    expect(stateChangingToolCalls(transcript([tool(join(own, 'escape', 'file.txt'))]), {
      allowedRoots: [fx.lane], home: fx.home,
    })).toEqual(['view_file (read outside the juror lane)']);
  });
});
