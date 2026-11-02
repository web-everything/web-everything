// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { decideFinalHeadSeats, resolveFinalHeadSeats } from '../../lib/review-final-head-seats.mjs';
import { createReviewJobIo, runReviewJob } from '../review-job.mjs';
import * as redTeamPolicy from '../../lib/review-red-team-policy.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Fail locally if the wrapper bypasses its injected runner; never launch a real subprocess.
vi.mock('../../lib/proc-read.mjs', async importOriginal => ({
  ...await importOriginal(), execRead: vi.fn(() => { throw Error('unexpected non-injected command'); }),
}));

const repo = 'web-everything/web-everything', pr = 6001, head = 'a'.repeat(40), newer = 'b'.repeat(40);
const payload = (verdict = 'accept') => ({ runId: 'r', stopped: 'complete',
  verdict: { verdict, loop: { outcome: 'converged' }, findings: [], admittedFindings: [] },
  findings: { read: { title: 't', body: '', diffText: 'diff --git a/x b/x\n+1\n', netChangedFiles: ['x'], netRenameSources: [], netBasis: { rev: head } } } });
const on = { mode: 'on' };

describe('decideFinalHeadSeats', () => {
  it('intermediate head (mandatory lenses asked for changes) gets no seat', () => {
    expect(decideFinalHeadSeats({ loopPayload: payload('changes'), liveHead: head, setting: on })).toMatchObject({ skip: true, run: false });
  });
  it('final accepted head gets its seat', () => {
    expect(decideFinalHeadSeats({ loopPayload: payload(), liveHead: head, setting: on })).toMatchObject({ skip: false, run: true });
  });
  it('superseded head gets no seat', () => {
    expect(decideFinalHeadSeats({ loopPayload: payload(), liveHead: newer, setting: on })).toMatchObject({ skip: true, run: false });
  });
  it('a still-live accepted head needs no push timestamp', () => {
    expect(decideFinalHeadSeats({ loopPayload: payload(), liveHead: head, setting: on }).run).toBe(true);
  });
  it('changes + red-team-owed head still runs seats', () => {
    // The current shared policy owes red team only on accepts/advisory accepts. Stub its
    // answer to pin this defensive exception independently of that policy's verdict set.
    const owed = vi.spyOn(redTeamPolicy, 'redTeamOwedFor').mockReturnValue(true);
    try {
      expect(decideFinalHeadSeats({ loopPayload: payload('changes'), liveHead: head, setting: on }))
        .toMatchObject({ run: true, skip: false });
      expect(owed).toHaveBeenCalled();
    } finally { owed.mockRestore(); }
  });
  it('a red-team-owed changes head still checks for confirmed supersession', () => {
    const owed = vi.spyOn(redTeamPolicy, 'redTeamOwedFor').mockReturnValue(true);
    try {
      const io = job(payload('changes'), newer, 'on');
      expect(io.liveHead).toHaveBeenCalledTimes(1);
      expect(io.runExtraSeats).not.toHaveBeenCalled();
    } finally { owed.mockRestore(); }
  });
  it.each(['accept', 'needs-human'])('the real policy owes red team on %s and seats still run', verdict => {
    const p = payload(verdict);
    p.verdict.humanRequired = true;
    p.verdict.lensVerdicts = { correctness: 'accept', security: 'accept' };
    expect(redTeamPolicy.redTeamOwedFor(p)).toBe(true);
    expect(job(p, head, 'on').runExtraSeats).toHaveBeenCalledTimes(1);
  });
  it.each(['live', 'reviewed'])('mixed-case %s representation of the same full SHA still runs seats', position => {
    const p = payload();
    if (position === 'reviewed') p.findings.read.netBasis.rev = head.toUpperCase();
    expect(decideFinalHeadSeats({ loopPayload: p, liveHead: position === 'live' ? head.toUpperCase() : head, setting: on }))
      .toMatchObject({ run: true, skip: false });
  });
  it.each(['live', 'reviewed'])('abbreviated or malformed %s SHA cannot suppress seats', position => {
    for (const value of [null, undefined, '', 'b'.repeat(7), 'b'.repeat(39), 'b'.repeat(41), 'g'.repeat(40), ` ${newer}`, `${newer}\n`]) {
      const p = payload();
      if (position === 'reviewed') p.findings.read.netBasis.rev = value;
      expect(decideFinalHeadSeats({ loopPayload: p, liveHead: position === 'live' ? value : newer, setting: on }), String(value))
        .toMatchObject({ run: true, skip: false });
    }
  });
  it.each([
    ['missing payload', null], ['missing verdict', { ...payload(), verdict: undefined }],
    ['scalar verdict', { ...payload(), verdict: 'changes' }],
  ])('%s fails open even with a different live head', (_name, loopPayload) => {
    expect(decideFinalHeadSeats({ loopPayload, liveHead: newer, setting: on })).toMatchObject({ run: true, skip: false });
  });
  it('shadow reports but still runs; off and unknowns run', () => {
    expect(decideFinalHeadSeats({ loopPayload: payload('changes'), setting: { mode: 'shadow' } })).toMatchObject({ run: true, skip: false });
    expect(decideFinalHeadSeats({ loopPayload: payload('changes'), setting: { mode: 'off' } }).run).toBe(true);
    expect(decideFinalHeadSeats({ loopPayload: payload(), liveHead: null, setting: on }).run).toBe(true);
    expect(decideFinalHeadSeats({ loopPayload: null, setting: on }).run).toBe(true);
    expect(decideFinalHeadSeats({ loopPayload: payload('needs-human'), liveHead: null, setting: on }).run).toBe(true);
    expect(decideFinalHeadSeats({ loopPayload: { ...payload(), verdict: {} }, setting: on }).run).toBe(true);
    expect(decideFinalHeadSeats({ loopPayload: payload(), liveHead: 'unknown', setting: on }).run).toBe(true);
  });
});

describe('resolveFinalHeadSeats', () => {
  it.each([
    ['standard when no layers are set', {}, {}, undefined, 'shadow'],
    ['platform overrides standard', { mode: 'off' }, {}, undefined, 'off'],
    ['tool overrides platform', { mode: 'on' }, { mode: 'off' }, undefined, 'off'],
    ['environment overrides tool and platform', { mode: 'off' }, { mode: 'shadow' }, ' ON ', 'on'],
    ['invalid environment falls back to tool', { mode: 'on' }, { mode: 'off' }, 'bad', 'off'],
    ['invalid tool falls back to platform', { mode: 'on' }, { mode: 'bad' }, undefined, 'on'],
    ['invalid platform falls back to standard', { mode: 'bad' }, {}, undefined, 'shadow'],
  ])('final-head settings honor cascade precedence: %s', (_name, platform, tool, envMode, expected) => {
    expect(resolveFinalHeadSeats({ platform, env: { WE_REVIEW_FINAL_HEAD_SEATS: envMode },
      readFile: () => JSON.stringify({ finalHeadSeats: tool }), log: () => {} }).mode).toBe(expected);
  });
  it.each([
    ['unreadable settings', () => { throw Error('unreadable'); }],
    ['malformed settings', () => '{'], ['non-object settings', () => '{"finalHeadSeats":"off"}'],
  ])('%s falls back to the explicit platform layer', (_name, readFile) => {
    expect(resolveFinalHeadSeats({ env: {}, platform: { mode: 'on' }, readFile, log: () => {} }).mode).toBe('on');
  });
  it('defaults to shadow; env wins; bad env ignored', () => {
    const log = () => {};
    expect(resolveFinalHeadSeats({ env: {}, readFile: () => '{}', log }).mode).toBe('shadow');
    expect(resolveFinalHeadSeats({ env: { WE_REVIEW_FINAL_HEAD_SEATS: 'on' }, readFile: () => '{}', log }).mode).toBe('on');
    expect(resolveFinalHeadSeats({ env: { WE_REVIEW_FINAL_HEAD_SEATS: 'x' }, readFile: () => '{"finalHeadSeats":{"mode":"off"}}', log }).mode).toBe('off');
  });
});

function job(loopPayload, liveHead, mode, overrides = {}) {
  const io = {
    root: process.cwd(), now: () => 1_000, newActorId: () => 'actor', readPrevCompletion: () => null,
    claim: () => ({ ok: true }), updateRecord: vi.fn(), unclaim: vi.fn(),
    acquireLane: () => ({ lanePath: join(tmpdir(), 'fhs-lane') }), releaseLane: vi.fn(), prepareLane: () => ({ head }),
    report: vi.fn(), log: vi.fn(),
    runLoop: vi.fn(() => ({ status: 0, stdout: JSON.stringify(loopPayload), stderr: '' })),
    runExtraSeats: vi.fn(() => ({ status: 'ran', seats: [] })), speculativeRedTeamSetting: () => ({ enabled: false }),
    finalHeadSeatsSetting: () => ({ mode }), liveHead: vi.fn(() => liveHead), ...overrides,
  };
  runReviewJob({ repo, pr }, io);
  return io;
}

describe('review job wiring', () => {
  it.each([
    ['off mode', payload(), 'off'], ['definitive changes in on mode', payload('changes'), 'on'],
    ['definitive changes in shadow mode', payload('changes'), 'shadow'],
    ['missing verdict', { ...payload(), verdict: undefined }, 'on'],
  ])('does not call liveHead for %s', (_name, p, mode) => {
    const io = job(p, newer, mode);
    expect(io.liveHead).not.toHaveBeenCalled();
    expect(io.runExtraSeats).toHaveBeenCalledTimes(mode === 'on' && p.verdict?.verdict === 'changes' ? 0 : 1);
  });
  it('accepted heads look up the live head exactly once with the PR identity', () => {
    const io = job(payload(), head, 'on');
    expect(io.liveHead).toHaveBeenCalledTimes(1);
    expect(io.liveHead).toHaveBeenCalledWith({ pr, repo });
    expect(io.runExtraSeats).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['throwing liveHead', { liveHead: () => { throw Error('lookup unavailable'); } }],
    ['missing liveHead', { liveHead: undefined }],
    ['abbreviated liveHead', { liveHead: () => newer.slice(0, 7) }],
    ['missing setting', { finalHeadSeatsSetting: undefined }],
    ['null setting', { finalHeadSeatsSetting: () => null }],
  ])('%s fails open and runs seats', (_name, overrides) => {
    expect(job(payload(), head, 'on', overrides).runExtraSeats).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['intermediate', payload('changes'), head, 'mandatory lenses asked for changes'],
    ['superseded', payload(), newer, 'head superseded'],
  ])('shadow logs would-skip reason for %s heads and still runs seats', (_name, p, live, reason) => {
    const io = job(p, live, 'shadow');
    expect(io.runExtraSeats).toHaveBeenCalledTimes(1);
    expect(io.log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`final-head seats \\(shadow\\): would skip \\(shadow, running\\).*${reason}`)));
  });
  it('a throwing gate setting still runs the seats', () => {
    const io = job(payload('changes'), head, 'on');
    expect(io.runExtraSeats).not.toHaveBeenCalled();
    const bad = { ...io, finalHeadSeatsSetting: () => { throw new Error('boom'); }, runExtraSeats: vi.fn(() => ({ status: 'ran', seats: [] })) };
    runReviewJob({ repo, pr }, bad);
    expect(bad.runExtraSeats).toHaveBeenCalledTimes(1);
  });
  it('on: intermediate and superseded heads skip the seat run, the final head runs it', () => {
    expect(job(payload('changes'), head, 'on').runExtraSeats).not.toHaveBeenCalled();
    expect(job(payload(), newer, 'on').runExtraSeats).not.toHaveBeenCalled();
    expect(job(payload(), head, 'on').runExtraSeats).toHaveBeenCalledTimes(1);
  });
  it('shadow: every head still runs', () => {
    expect(job(payload('changes'), head, 'shadow').runExtraSeats).toHaveBeenCalledTimes(1);
  });
});

describe('createReviewJobIo.liveHead wrapper', () => {
  it('reads the head using the injected runner and forwards root and environment', () => {
    const env = { WRAPPER_TEST: 'offline' }, root = process.cwd();
    const exec = vi.fn(() => JSON.stringify({ headRefOid: head }));
    const io = createReviewJobIo({ root, env, exec });
    expect(io.liveHead({ pr, repo })).toBe(head);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', String(pr), `--repo=${repo}`, '--json', 'headRefOid'],
      expect.objectContaining({ cwd: root, env }));
  });
  it.each([
    ['command failure', () => { throw Error('offline'); }],
    ['malformed JSON', () => '{'], ['missing head', () => '{}'], ['null response', () => 'null'],
  ])('%s returns null and the real wrapper still allows seats', (_name, exec) => {
    const runner = vi.fn(exec);
    const liveHead = createReviewJobIo({ env: {}, exec: runner }).liveHead;
    expect(liveHead({ pr, repo })).toBeNull();
    expect(job(payload(), head, 'on', { liveHead }).runExtraSeats).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
