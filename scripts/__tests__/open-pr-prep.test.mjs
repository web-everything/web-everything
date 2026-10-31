import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPrLandRunner } from '../operations/open-pr-io.mjs';

const prep = 'PREP:\nAcceptance: visible outcome\nPre-mortem: missing events\nFiles: scripts/example.mjs\nTests: focused unit tests';
function fixture(test) {
  const dir = mkdtempSync(join(tmpdir(), 'open-pr-prep-'));
  const bodyFile = join(dir, 'body.md');
  const logPath = join(dir, 'events.log');
  const spawn = vi.fn(() => ({ status: 0, stdout: '{"pr":123,"url":"example"}' }));
  const review = vi.fn(() => ({ action: 'pass' }));
  const runner = (options = {}) => createPrLandRunner({ spawn, prePrReview: review, cwd: dir, prepLogPath: logPath, ...options });
  const argv = ['--ref=lane/prep', '--title=feature', `--body-file=${bodyFile}`];
  try { test({ dir, bodyFile, logPath, spawn, review, runner, argv }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('open-pr prep admission', () => {
  it.each(['A description without prep.', prep.replace('visible outcome', ''), prep.replace('missing events', 'TODO')])('refuses missing/incomplete readable prep before review: %s', (body) => fixture(({ bodyFile, spawn, review, runner, argv }) => {
    writeFileSync(bodyFile, body);
    expect(runner()({ argv })).toMatchObject({ outcome: 'refused', reason: 'prep-block-missing', detail: expect.stringContaining('PREP:') });
    expect(spawn).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  }));
  it('refuses an absent body-file argument', () => fixture(({ runner, argv }) => {
    expect(runner()({ argv: argv.filter((arg) => !arg.startsWith('--body-file=')) })).toMatchObject({ outcome: 'refused', reason: 'prep-block-missing' });
  }));
  it('allows complete PREP read from a real relative body file', () => fixture(({ bodyFile, spawn, runner, argv }) => {
    writeFileSync(bodyFile, prep);
    expect(runner()({ argv: [...argv.slice(0, 2), '--body-file=body.md'] }).outcome).toBe('opened');
    expect(spawn).toHaveBeenCalledOnce();
  }));
  it.each([['description without prep', 'refused'], [prep, 'opened']])('expands ~/ in body-file and enforces prep: %s', (body, outcome) => fixture(({ runner, argv, spawn, review }) => {
    const readPrepBody = vi.fn(() => body);
    const result = runner({ readPrepBody })({ argv: [...argv.slice(0, 2), '--body-file=~/prep/body.md'] });
    expect(readPrepBody.mock.calls).toEqual([[join(homedir(), 'prep', 'body.md'), 'utf8']]);
    expect(result.outcome).toBe(outcome);
    if (outcome === 'refused') {
      expect(result.reason).toBe('prep-block-missing');
      expect(spawn).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
    } else expect(spawn).toHaveBeenCalledOnce();
  }));
  it.each(['~', '~draft.md', '~someone/body.md', '~\n'])('matches pr-land leading-home expansion when reading prep from %j', (path) => fixture(({ runner, argv, spawn }) => {
    const readPrepBody = vi.fn(() => prep);
    expect(runner({ readPrepBody })({ argv: [...argv.slice(0, 2), `--body-file=${path}`] }).outcome).toBe('opened');
    expect(readPrepBody.mock.calls).toEqual([[path.replace(/^~/, homedir()), 'utf8']]);
    expect(spawn).toHaveBeenCalledOnce();
  }));
  it.each(['~', '~/prep/body.md', '~draft.md', '~someone/body.md', '~\n', 'body.md', 'nested/~body.md'])('prep gate and bypass copy read the file selected by pr-land home expansion for %j', (path) => fixture(({ dir }) => {
    const home = join(dir, path === '~' ? 'body.md' : 'home');
    // The oracle is pr-land's expandHome, followed by resolution in its working directory.
    const source = resolve(dir, path && path.startsWith('~') ? path.replace(/^~/, home) : path);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, prep);
    const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../operations/open-pr-io.mjs')).href;
    // A child gives relative paths a real scratch cwd without changing the Vitest worker's cwd.
    const script = `
      import { readFileSync } from 'node:fs';
      import { createPrLandRunner } from ${JSON.stringify(moduleUrl)};
      import { prepVerdict } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../lib/prep-block.mjs')).href)};
      let copiedBody, gatedBody, prepPath, spawns = 0;
      const run = createPrLandRunner({
        readPrepBody: (path, encoding) => {
          prepPath = path;
          return readFileSync(path, encoding);
        },
        prepGate: (body) => {
          gatedBody = body;
          return prepVerdict(body);
        },
        prePrReview: () => ({ action: 'pass', bypass: { reason: 'operator reason', actor: 'operator', operatorInstruction: 'Ship this change' } }),
        spawn: (_command, args) => {
          spawns++;
          copiedBody = readFileSync(args.find(arg => arg.startsWith('--body-file=')).slice(12), 'utf8');
          return { status: 0, stdout: '{"pr":123,"url":"example"}' };
        },
      });
      const result = run({ argv: ['--ref=lane/prep', '--title=feature', '--body-file=' + process.argv[1]] });
      process.stdout.write(JSON.stringify({ result, gatedBody, prepPath, copiedBody, spawns }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, path], {
      cwd: dir, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    expect(child.status, child.stderr).toBe(0);
    const { result, gatedBody, prepPath, copiedBody, spawns } = JSON.parse(child.stdout);
    expect(result).toMatchObject({ outcome: 'opened' });
    // A native child's cwd can use the canonical spelling of a symlinked TMPDIR.
    expect(realpathSync(prepPath)).toBe(realpathSync(source));
    expect(gatedBody).toBe(prep);
    expect(copiedBody.startsWith(gatedBody)).toBe(true);
    expect(copiedBody).toContain(prep);
    expect(copiedBody).toContain('operator reason');
    expect(spawns).toBe(1);
    expect(readFileSync(source, 'utf8')).toBe(prep);
  }));
  it('allows a waiver and records its reason', () => fixture(({ bodyFile, logPath, runner, argv }) => {
    writeFileSync(bodyFile, 'prep: waived — urgent incident');
    expect(runner()({ argv }).outcome).toBe('opened');
    expect(JSON.parse(readFileSync(logPath, 'utf8'))).toMatchObject({ kind: 'waiver', detail: 'urgent incident' });
  }));
  it.each(['resolve the conflict', 'resolve conflict', 'merge conflict', 'rebase onto main', 're-run checks', 'rerun CI', 'retrigger', 'red-team', 'redteam', 'review the PR', 'review this PR', 'code review', 'jury', 'read-only', 'do not edit', 'no code changes', 'file a backlog card', 'file the item', 'card-only'])('allows shared exemption in title only: %s', (text) => fixture(({ bodyFile, runner, argv, spawn, review }) => {
    writeFileSync(bodyFile, text);
    expect(runner()({ argv })).toMatchObject({ outcome: 'refused', reason: 'prep-block-missing' });
    expect(spawn).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
    writeFileSync(bodyFile, 'description');
    expect(runner()({ argv: [...argv.filter((arg) => !arg.startsWith('--title=')), `--title=${text}`] }).outcome).toBe('opened');
  }));
  it.each(['implement', 'build', 'add', 'fix', 'refactor', 'write'])('refuses build-worded title containing an exemption before review: %s', (verb) => fixture(({ bodyFile, runner, argv, spawn, review }) => {
    writeFileSync(bodyFile, 'Description without PREP.');
    expect(runner()({ argv: [...argv.filter((arg) => !arg.startsWith('--title=')), `--title=${verb} code review guard`] }))
      .toMatchObject({ outcome: 'refused', reason: 'prep-block-missing', detail: expect.stringContaining('PREP:') });
    expect(spawn).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  }));
  it.each(['resolve merge conflict', 'fix merge conflict', 're-run CI; inspect the fix', 'retrigger CI; inspect the fix',
    'file a backlog card for the fix', 'review the PR for the fix'])('opens explicit exempt title without PREP: %s', (title) => fixture(({ bodyFile, runner, argv, spawn, review }) => {
    writeFileSync(bodyFile, 'Description without PREP.');
    expect(runner()({ argv: [...argv.filter((arg) => !arg.startsWith('--title=')), `--title=${title}`] }).outcome).toBe('opened');
    expect(spawn).toHaveBeenCalledOnce(); expect(review).toHaveBeenCalledOnce();
  }));
  it.each(['The jury discussed this implementation.', 'This implementation needs code review.'])('refuses a build title whose body mentions exempt work: %s', (body) => fixture(({ bodyFile, runner, argv, spawn, review }) => {
    writeFileSync(bodyFile, body);
    expect(runner()({ argv })).toMatchObject({ outcome: 'refused', reason: 'prep-block-missing' });
    expect(spawn).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  }));
  it('does not read or gate a dry-run', () => fixture(({ runner, argv, spawn }) => {
    const readPrepBody = vi.fn(() => { throw new Error('must not read'); });
    const prepGate = vi.fn(() => { throw new Error('must not gate'); });
    runner({ readPrepBody, prepGate })({ argv: [...argv, '--dry-run'] });
    expect(readPrepBody).not.toHaveBeenCalled(); expect(prepGate).not.toHaveBeenCalled(); expect(spawn).toHaveBeenCalledOnce();
  }));
  it('warns and defers unreadable body handling, keeping terminal controls inert', () => fixture(({ runner, argv, spawn }) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const prepGate = vi.fn();
    try {
      runner({ readPrepBody: () => { throw new Error('bad\x1b[31m\ninput'); }, prepGate })({ argv });
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/WARNING.*prep body unreadable/));
      expect(stderr.mock.calls[0][0]).not.toContain('\x1b');
      expect(prepGate).not.toHaveBeenCalled(); expect(spawn).toHaveBeenCalledOnce();
    } finally { stderr.mockRestore(); }
  }));
  it('keeps the gate and reader injectable for other runner tests', () => fixture(({ runner, argv }) => {
    const readPrepBody = vi.fn(() => 'legacy fixture');
    const prepGate = vi.fn(() => ({ ok: true }));
    expect(runner({ readPrepBody, prepGate })({ argv }).outcome).toBe('opened');
    expect(prepGate).toHaveBeenCalledWith('legacy fixture');
  }));
});
