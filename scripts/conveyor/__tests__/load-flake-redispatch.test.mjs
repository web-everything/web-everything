import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as sd from '../stand-down.mjs';
import { loadFlakeHoldState } from '../load-flake-hold.mjs';
import { runLoadFlakeReverify, reverifyConfig, REVERIFY_SWEEP_REPOS } from '../load-flake-reverify.mjs';
import { CONSTELLATION_REPOS } from '../../lib/constellation-repos.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { classifyAwaitVerdict, buildAwaitVerifyResumePrompt } from '../await-verify-pass.mjs';
import soak from '../soak/breaks/load-flake-stand-down-terminal.mjs';

const BODY = `🛑 conveyor fix — stood down, human judgment needed

conveyor fix agent stopped rather than guessing: the gate stayed RED after the repair, and a red diff must never be re-pushed. 3 verify attempts red only on wall-clock UI/watch tests unrelated to this repair (wip-feeds file-watch latency x3, shared-source cache timing x1, card-taxonomy-docs 30ms async wait x1) at host load 20-36; the repair's own tests pass (59/59)

The PR was left EXACTLY as the reviewer left it — no label was changed, the review was not re-armed, and nothing was re-pushed. This comment is the durable record that a fixer *deliberately stood down* here, which is what tells the reconciler apart from a fixer that simply died.

**A human is the intended next step.** The automatic fix loop will NOT try this PR again while this comment stands — re-running it would only re-ask the same question. Take it over with \`/finish\`, or delete this comment once the blocker is resolved to hand the PR back to the loop.
<!-- stand-down reason=gate-red -->`;
const comment = (body, createdAt = '2026-10-09T19:00:00Z') => ({ body, createdAt, author: { login: 'web-everything' }, url: 'https://github.com/plateauapp/plateau-app/pull/220#issuecomment-1' });
const c220 = comment(BODY, '2026-10-09T18:57:01Z');
const resolved = (result, at) => comment(sd.buildLoadFlakeRedispatchResolvedComment({ result }), at);
function fixture(comments = [c220]) {
  const pr = { number: 220, state: 'OPEN', headRefName: 'lane/fix', headRefOid: 'aaa1111', labels: [{ name: 'review:changes' }], comments };
  const io = { now: () => Date.parse('2026-10-09T20:00:00Z'), loadavg: () => [1, 2], cpuCount: () => 12,
    listPrs: vi.fn(async () => [structuredClone(pr)]), readPr: vi.fn(async () => pr), pushRefusal: vi.fn(() => null),
    acquire: vi.fn(), verify: vi.fn(), push: vi.fn(), prepare: vi.fn(), comment: vi.fn() };
  return { pr, io };
}
const run = (io, config = reverifyConfig({})) => runLoadFlakeReverify({ repo: 'plateau-app', config }, io);

describe('load-only red re-dispatch', () => {
  it('reclassifies the exact incident, but keeps real failures terminal and ignores forged authors', () => {
    expect(sd.isLoadOnlyRedStandDown(c220)).toBe(true);
    expect(sd.standDownComments([c220])).toEqual([]);
    const real = comment(BODY.replace(/3 verify attempts.*59\/59\)/, 'a real failure'));
    expect(sd.standDownComments([real])).toHaveLength(1);
    const forged = { ...c220, author: { login: 'stranger' } };
    expect(sd.isLoadOnlyRedStandDown(forged)).toBe(false);
    expect(sd.loadFlakeHolds([forged])).toEqual([]);
  });
  it('preserves the soak post-cutoff alt-bearing terminal case', async () => {
    expect((await soak.run()).violations).toEqual([]);
  });
  it('holds reconcile until a trusted redispatch result ends the hold', () => {
    const { pr, io } = fixture();
    const state = loadFlakeHoldState(pr);
    expect(state).toMatchObject({ live: true, hold: { redispatch: true } });
    expect(typeof state.hold.alt.branch).toBe('string');
    const plan = () => planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: io.now(), requiredChecks: ['gate'] });
    expect(plan().refusals).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'load-flake-hold' })]));
    expect(loadFlakeHoldState({ ...pr, comments: [...pr.comments, { ...resolved('redispatched'), author: { login: 'stranger' } }] }).live).toBe(true);
    pr.comments.push(resolved('redispatched'));
    expect(loadFlakeHoldState(pr).live).toBe(false);
    expect(plan().refusals.some((r) => ['stood-down', 'load-flake-hold'].includes(r.kind))).toBe(false);
  });
  // Operator-answer isTerminal only accepts terminal comments or isLoadFlakeStandDown (saved-alt legacy).
  // Extending that reader is outside this change's allowed files; no operator-answer case for this new class.
  it.each(['local', 'ci'])('requires quiet host even in %s mode', async (mode) => {
    const { io } = fixture(); io.loadavg = () => [36, 20];
    expect(await run(io, reverifyConfig({ WE_LOAD_FLAKE_REVERIFY_MODE: mode }))).toMatchObject({ deferred: 'host-load', holds: [{ pr: 220, redispatch: true, altSha: null }] });
    expect(io.comment).not.toHaveBeenCalled(); expect(io.acquire).not.toHaveBeenCalled();
  });
  it('re-dispatches without acquiring a lane, verifying or pushing', async () => {
    const { io } = fixture();
    expect(await run(io)).toMatchObject({ redispatched: [{ result: 'redispatched', pr: 220 }] });
    expect(io.comment).toHaveBeenCalledTimes(1);
    expect(sd.loadFlakeResults([comment(io.comment.mock.calls[0][2])])).toMatchObject([{ result: 'redispatched', redispatch: true, sha: null }]);
    expect(io.comment.mock.calls[0][2]).toContain('host load 1/2 on 12 cores');
    for (const name of ['acquire', 'verify', 'push', 'prepare']) expect(io[name]).not.toHaveBeenCalled();
  });
  it('caps attempts across earlier holds in the whole thread', async () => {
    const prior = [1, 2, 3].map((n) => resolved('redispatched', `2026-10-09T18:0${n}:00Z`));
    const { io } = fixture([...prior, c220]);
    expect(await run(io)).toMatchObject({ redispatched: [{ result: 'exhausted' }] });
    expect(sd.standDownComments([comment(io.comment.mock.calls[0][2])])).toHaveLength(1);
  });
  it('ends a moved head and respects an ended hold or a live claim', async () => {
    const { io, pr } = fixture();
    io.readPr.mockResolvedValue({ ...pr, headRefOid: 'bbb2222' });
    expect(await run(io)).toMatchObject({ redispatched: [{ deferred: 'head-moved' }] });
    expect(io.comment.mock.calls[0][2]).toContain('result=head-moved');
    io.comment.mockClear(); io.readPr.mockResolvedValue({ ...pr, comments: [c220, resolved('redispatched')] });
    expect(await run(io)).toMatchObject({ redispatched: [{ deferred: 'hold-ended' }] });
    io.readPr.mockResolvedValue(pr); io.pushRefusal.mockReturnValue('claimed');
    expect(await run(io)).toMatchObject({ redispatched: [{ deferred: 'fix-claimed' }] });
    expect(io.comment).not.toHaveBeenCalled();
  });
  it('works every redispatch candidate in one sweep', async () => {
    const { io, pr } = fixture(); const second = { ...pr, number: 221 };
    io.listPrs.mockResolvedValue([pr, second]); io.readPr.mockImplementation(async (_slug, n) => n === 220 ? pr : second);
    expect((await run(io)).redispatched).toHaveLength(2); expect(io.comment).toHaveBeenCalledTimes(2);
    expect(REVERIFY_SWEEP_REPOS).toEqual(Object.keys(CONSTELLATION_REPOS));
  });
  it('processes all redispatches before at most one saved-alt success', async () => {
    const { io, pr } = fixture();
    const alt = { ...pr, number: 222, labels: [], comments: [{ ...comment(sd.buildLoadFlakeHoldComment({ head: 'aaa1111', alt: 'lane/saved-alt', altSha: 'bbb2222' }), '2026-10-09T17:00:00Z'), url: 'https://github.com/web-everything/web-everything/pull/222#issuecomment-1' }] };
    io.listPrs.mockResolvedValue([alt, pr, { ...alt, number: 223 }]);
    io.readPr.mockImplementation(async (_slug, n) => n === 220 ? pr : { ...alt, number: n });
    Object.assign(io, { isAncestor: vi.fn(() => true), acquire: vi.fn(() => ({ path: '/lane' })), head: vi.fn(() => 'bbb2222'), resolveSha: vi.fn(() => 'bbb2222'), verify: vi.fn(() => ({ ok: true })), release: vi.fn() });
    expect(await runLoadFlakeReverify({ repo: 'we', config: reverifyConfig({}) }, io)).toMatchObject({ result: 'pushed', pr: 222, redispatched: [{ result: 'redispatched', pr: 220 }] });
    expect(io.comment.mock.calls.map((c) => c[1])).toEqual([220, 222]);
    expect(io.acquire).toHaveBeenCalledTimes(1);
  });
  it('CI high load skips redispatches while still working saved-alt candidates', async () => {
    const { io, pr } = fixture();
    const alt = { ...pr, number: 222, comments: [{ ...comment(sd.buildLoadFlakeHoldComment({ alt: 'lane/saved-alt', altSha: 'bbb2222' })), url: undefined }] };
    const { planLoadFlakeReverify } = await import('../load-flake-reverify.mjs');
    const plan = planLoadFlakeReverify({ prs: [pr, alt], load: [50, 50], cores: 12, now: io.now(), config: reverifyConfig({ WE_LOAD_FLAKE_REVERIFY_MODE: 'ci' }) });
    expect(plan.candidates.map((c) => c.pr.number)).toEqual([222]);
  });
  it('round-trips structured holds and distinguishes saved-alt requests', () => {
    const body = sd.buildLoadFlakeRedispatchComment({ head: 'aaa1111', detail: 'timing' });
    expect(sd.loadFlakeHolds([comment(body)])).toMatchObject([{ head: 'aaa1111', redispatch: true, legacy: false, alt: { sha: null } }]);
    expect(sd.standDownComments([comment(body)])).toEqual([]);
    expect(loadFlakeHoldState({ comments: [comment(body)], headRefOid: 'bbb2222' }).live).toBe(false);
    expect(sd.loadFlakeHolds([comment(body.replace('mode=redispatch', 'mode=other'))])).toEqual([]);
    expect(sd.loadFlakeHolds([comment(sd.buildLoadFlakeHoldComment({ alt: 'lane/fix-alt', altSha: 'aaa1111' }))])).toEqual([]);
    expect(sd.loadFlakeHolds([comment(body.replace('head=aaa1111', 'head=unsafe'))])).toEqual([]);
    expect(sd.loadFlakeRedispatchRequest({ reason: 'load-flake', repoKey: 'plateau-app' })).toBe(true);
    expect(sd.loadFlakeRedispatchRequest({ reason: 'load-flake', repoKey: 'we', alt: 'lane/fix-alt', altSha: 'aaa1111' })).toBe(false);
  });
  it('resumes non-WE with the redispatch instructions; WE retains the saved-fix path', () => {
    const sha = 'a'.repeat(40); const now = Date.parse('2026-10-09T20:00:00Z');
    const record = { v: 1, sessionId: 'fix-220', who: 'fix-220', repo: 'plateauapp/plateau-app', pr: 220, sha, requestedAt: new Date(now).toISOString(), attempt: 1, lane: '/lane', ref: 'lane/fix', kind: 'fix' };
    const marker = { sha, status: 'red', startedAt: record.requestedAt, retriedFailures: [{ file: 'a', kind: 'timeout' }], isolatedRetry: 'still-red', failureDetails: { tests: [{ file: 'a' }] } };
    const args = { record, marker, lane: { head: sha, dirty: false }, nowMs: now, ttlMs: 900000 };
    expect(classifyAwaitVerdict(args)).toMatchObject({ resume: 'load-flake-redispatch' });
    expect(classifyAwaitVerdict({ ...args, record: { ...record, repo: 'we' } })).toMatchObject({ resume: 'load-flake' });
    const prompt = buildAwaitVerifyResumePrompt({ kind: 'load-flake-redispatch', record, marker });
    expect(prompt).toContain('--reason=load-flake'); expect(prompt).not.toContain('--alt-sha');
    expect(prompt).toContain('--head="$(git rev-parse origin/lane/fix)"'); expect(prompt).not.toContain(`--head=${sha}`); expect(prompt).toContain('--outcome=blocked-on-load-flake');
  });
});

// CLI probes use a private fake gh executable: no live GitHub writes or dispatch-claim releases.
function withFakeGh(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'redispatch-cli-'));
  const log = join(dir, 'calls.jsonl');
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.REDISPATCH_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'list' && args.includes('web-everything/web-everything')) {
  process.stderr.write('fixture repo unavailable'); process.exit(1);
}
process.stdout.write('[]');
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, REDISPATCH_TEST_LOG: log };
  try { fn({ env, calls: () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
it('CLI sweep isolates a failed repo and still visits every constellation repo', () => withFakeGh(({ env, calls }) => {
  const out = JSON.parse(execFileSync(process.execPath, [resolve('scripts/conveyor/load-flake-reverify.mjs'), 'sweep', '--dry-run'], { env, encoding: 'utf8' }));
  expect(Object.keys(out.repos)).toEqual(Object.keys(CONSTELLATION_REPOS));
  expect(out.repos.we).toMatchObject({ repo: 'we', error: expect.stringContaining('fixture repo unavailable') });
  expect(out.repos['plateau-app']).not.toHaveProperty('error');
  expect(calls()).toHaveLength(Object.keys(CONSTELLATION_REPOS).length);
}));
it.each(['aaa1111', 'unsafe'])('CLI records a hold without labels and accepts only a safe head (%s)', (head) => withFakeGh(({ env, calls }) => {
  // No --who: do not release any real host dispatch claim in this isolated writer probe.
  const out = JSON.parse(execFileSync(process.execPath, [resolve('scripts/conveyor/stand-down.mjs'), '220', '--repo=plateau-app', '--reason=load-flake', `--head=${head}`], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  expect(out).toMatchObject({ loadFlakeHold: true, redispatch: true, stoodDown: false, labeled: false });
  const writes = calls(); expect(writes).toHaveLength(1);
  expect(writes[0].slice(0, 3)).toEqual(['pr', 'comment', '220']);
  const body = writes[0][writes[0].indexOf('--body') + 1];
  expect(sd.loadFlakeHolds([comment(body)])[0].head).toBe(head === 'unsafe' ? null : head);
}));
