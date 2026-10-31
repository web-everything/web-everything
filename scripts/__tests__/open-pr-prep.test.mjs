import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
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
