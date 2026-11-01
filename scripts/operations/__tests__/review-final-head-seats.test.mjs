// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { decideFinalHeadSeats, resolveFinalHeadSeats } from '../../lib/review-final-head-seats.mjs';
import { runReviewJob } from '../review-job.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  it('a still-live accepted head is never skipped by age', () => {
    expect(decideFinalHeadSeats({ loopPayload: payload(), liveHead: head, headPushedAtMs: 1000, nowMs: 2000, setting: on }).run).toBe(true);
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
  it('defaults to shadow; env wins; bad env ignored', () => {
    const log = () => {};
    expect(resolveFinalHeadSeats({ env: {}, readFile: () => '{}', log }).mode).toBe('shadow');
    expect(resolveFinalHeadSeats({ env: { WE_REVIEW_FINAL_HEAD_SEATS: 'on' }, readFile: () => '{}', log }).mode).toBe('on');
    expect(resolveFinalHeadSeats({ env: { WE_REVIEW_FINAL_HEAD_SEATS: 'x' }, readFile: () => '{"finalHeadSeats":{"mode":"off"}}', log }).mode).toBe('off');
  });
});

function job(loopPayload, liveHead, mode) {
  const io = {
    root: process.cwd(), now: () => 1_000, newActorId: () => 'actor', readPrevCompletion: () => null,
    claim: () => ({ ok: true }), updateRecord: vi.fn(), unclaim: vi.fn(),
    acquireLane: () => ({ lanePath: join(tmpdir(), 'fhs-lane') }), releaseLane: vi.fn(), prepareLane: () => ({ head }),
    report: vi.fn(), log: vi.fn(),
    runLoop: vi.fn(() => ({ status: 0, stdout: JSON.stringify(loopPayload), stderr: '' })),
    runExtraSeats: vi.fn(() => ({ status: 'ran', seats: [] })), speculativeRedTeamSetting: () => ({ enabled: false }),
    finalHeadSeatsSetting: () => ({ mode }), liveHead: () => liveHead,
  };
  runReviewJob({ repo, pr }, io);
  return io;
}

describe('review job wiring', () => {
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
