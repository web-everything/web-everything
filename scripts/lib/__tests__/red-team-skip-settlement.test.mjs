// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planRedTeamOnSkip, runRedTeamOnSkip } from '../review-red-team-on-skip.mjs';
import { proveEquivalentRedTeamDiff } from '../red-team-empty-net-diff.mjs';
import { syncRedTeamStatusLabels } from '../red-team-status-labels.mjs';
import { redTeamMarker } from '../red-team-gate.mjs';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { runGhSync } from '../gh-throttle.mjs';

vi.mock('../gh-throttle.mjs', async original => ({ ...await original(), runGhSync: vi.fn() }));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });
const repo = 'example/project', pr = 42, head = 'a'.repeat(40), old = 'b'.repeat(40), base = 'c'.repeat(40);
const trusted = body => ({ body, author: { login: 'web-everything' }, createdAt: '2026-11-10T12:00:00Z' });
const accept = rev => trusted(`✅ review — accepted\n<!-- reviewed-sha: ${rev} -->`);
const result = (rev = head, blocked = false) => trusted(renderRedTeamComment({ pr, rev, provider: 'codex', model: 'm',
  findings: blocked ? [{ confirmedByRecheck: true, category: 'edge-case', impactIfUnfixed: 'broken', file: 'scripts/example.mjs', line: 1, summary: 'break' }] : [],
  recheckStatus: 'not-needed', foldedVerdict: blocked ? 'changes' : 'accept' }));
const patch = 'diff --git a/example.mjs b/example.mjs\n--- a/example.mjs\n+++ b/example.mjs\n@@ -1 +1 @@\n-old\n+new\n';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'red-team-settlement-')); roots.push(root);
  const env = { WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_CHECK_LOCK_DIR: join(root, 'locks'), WE_RED_TEAM_STATUS_LABELS: '1' };
  const raw = { number: pr, headRefOid: head, labels: ['review:accepted', 'red-team:pending'], reviews: [], comments: [accept(head), result()] };
  const payload = { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head }, diffText: patch, netChangedFiles: ['example.mjs'] } } };
  const evidence = { loopPayload: payload, inFlight: false, recorded: false, seatRecorded: false, completedRecorded: false };
  const provider = { readPrState: vi.fn(() => raw), readComments: () => raw.comments, readPrFiles: () => ['example.mjs'],
    ensureLabel: vi.fn(), setLabels: vi.fn((_repo, _pr, change) => {
      raw.labels = raw.labels.filter(label => !change.remove.includes(label));
      if (change.add) raw.labels.push(change.add);
    }) };
  const options = { repo, env, rawPrs: [raw], plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
    readEvidence: () => evidence, readStatus: () => null, readSeal: () => null, provider,
    readComments: () => raw.comments, syncLabels: vi.fn(syncRedTeamStatusLabels),
    setting: { enabled: true, retryCooldownMin: 30 }, lastDispatch: new Map(), now: () => 2_000_000,
    capacity: { lanes: 1, budget: { left: 1 } }, dispatch: vi.fn(() => ({ jobPid: 123 })), escalate: vi.fn(),
    publishCarriedCheck: vi.fn(() => ({ ok: true })), publishCheck: vi.fn(() => ({ ok: true })),
    exec: vi.fn((_file, args) => args[0] === 'merge-base' ? `${base}\n` : args[0] === 'patch-id' ? `${base} ${old}\n` : patch) };
  runGhSync.mockImplementation((_args, io) => { raw.comments.push(trusted(io.input)); return ''; });
  const plan = () => planRedTeamOnSkip({ ...options, refusals: options.plan.refusals, now: options.now(), gitExec: options.exec });
  return { raw, evidence, options, provider, plan };
}

describe('one red-team result settlement path', () => {
  it('variant 3: plans and applies an exact-head clear result, removing pending without escalation', () => {
    const f = fixture();
    expect(f.plan()[0]).toMatchObject({ action: 'settle-result' });
    expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'settle-result' });
    expect(f.raw.labels).toEqual(['review:accepted', 'red-team:clear']);
    expect(f.options.dispatch).not.toHaveBeenCalled();
    expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it('variant 1: settles pending before publishing an owed carried check', () => {
    const f = fixture();
    f.raw.comments[1].body = `<!-- review-verdict-carried from=${old} to=${head} patch-id=${base} -->\nReview verdict carried across an identical contribution.\n${f.raw.comments[1].body}`;
    f.options.readCarriedCheck = () => true;
    f.options.publishCarriedCheck.mockImplementation(() => {
      expect(f.raw.labels).toContain('red-team:clear');
      expect(f.raw.labels).not.toContain('red-team:pending');
      return { ok: true };
    });
    expect(f.plan()[0]).toMatchObject({ action: 'publish-carried-check' });
    runRedTeamOnSkip(f.options);
    expect(f.options.publishCarriedCheck).toHaveBeenCalledOnce();
    expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it('variant 2: sealed finished not-owed on a proven accepted head settles through stored policy clear', () => {
    const f = fixture(); f.raw.comments = [accept(head)];
    f.evidence.loopPayload.verdict.verdict = 'changes';
    const status = { repo, pr, head, status: 'finished', result: 'not-owed', sealedBreaks: [], loopPayload: f.evidence.loopPayload };
    f.evidence.status = status; f.options.readStatus = () => status;
    expect(f.plan()[0]).toMatchObject({ action: 'clear', why: 'not owed (stored review)' });
    expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'clear' });
    expect(f.raw.comments.at(-1).body).toContain('not owed (stored review)');
    expect(f.raw.labels).toEqual(['review:accepted', 'red-team:clear']);
    expect(redTeamEnqueueHold({ ...f.evidence, repo, pr, head, comments: f.raw.comments, env: f.options.env })).toBeNull();
    expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it.each(['unfinished', 'unsealed', 'wrong head', 'guard-deferred', 'blocked'])('not-owed fails closed with %s evidence', kind => {
    const f = fixture(); f.raw.comments = [accept(head)]; f.evidence.loopPayload.verdict.verdict = 'changes';
    const status = { head, status: 'finished', result: 'not-owed', sealedBreaks: [], loopPayload: f.evidence.loopPayload };
    if (kind === 'unfinished') status.status = 'running';
    if (kind === 'unsealed') delete status.sealedBreaks;
    if (kind === 'wrong head') status.head = old;
    if (kind === 'guard-deferred') status.result = { status: 'not-owed', deferredByGuard: true };
    if (kind === 'blocked') status.sealedBreaks = ['break'];
    f.evidence.status = status; f.options.readStatus = () => status;
    expect(f.plan()[0].action).not.toBe('clear');
    runRedTeamOnSkip(f.options);
    expect(f.provider.setLabels).not.toHaveBeenCalled();
    expect(f.options.publishCheck).not.toHaveBeenCalled();
  });
  it('a blocked exact-head result applies blocked and removes pending without becoming clear', () => {
    const f = fixture(); f.raw.comments[1] = result(head, true);
    expect(f.plan()[0]).toMatchObject({ action: 'settle-result' });
    runRedTeamOnSkip(f.options);
    expect(f.raw.labels).toEqual(['review:accepted', 'red-team:blocked']);
    expect(f.options.publishCheck).not.toHaveBeenCalled();
    expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it('a blocked label on the head wins even over a clean result', () => {
    const f = fixture(); f.raw.labels.push('red-team:blocked');
    expect(f.plan()[0]).toMatchObject({ action: 'settle-result' });
    runRedTeamOnSkip(f.options);
    expect(f.raw.labels).toContain('red-team:blocked'); expect(f.raw.labels).not.toContain('red-team:clear');
    expect(f.provider.setLabels).not.toHaveBeenCalled();
  });
  it.each(['missing', 'untrusted'])('never clears without a real result (%s)', kind => {
    const f = fixture();
    if (kind === 'missing') f.raw.comments.pop(); else f.raw.comments[1].author.login = 'outsider';
    expect(f.plan()[0].action).toBe('dispatch');
    runRedTeamOnSkip(f.options);
    expect(f.provider.setLabels).not.toHaveBeenCalled();
    expect(f.options.dispatch).toHaveBeenCalledOnce();
  });
  it('carries a valid result only when the complete net patches are equal', () => {
    const f = fixture(); f.raw.comments = [accept(old), result(old)];
    f.evidence.loopPayload.findings.read.netBasis.rev = old;
    expect(f.plan()[0]).toMatchObject({ action: 'settle-result', from: old });
    expect(runRedTeamOnSkip(f.options).rows[0]).toMatchObject({ action: 'settle-result', from: old });
    expect(f.raw.comments.at(-1).body).toContain(redTeamMarker(pr, head));
    expect(f.raw.labels).toContain('red-team:clear');
    expect(f.options.publishCarriedCheck).toHaveBeenCalledOnce();
    expect(f.options.dispatch).not.toHaveBeenCalled();
  });
  it.each(['different', 'unreadable', 'oversized'])('re-runs instead of carrying a %s net diff', kind => {
    const f = fixture(); f.raw.comments = [accept(old), result(old)];
    f.evidence.loopPayload.findings.read.netBasis.rev = old;
    f.options.exec.mockImplementation((_file, args) => {
      if (kind === 'unreadable') throw Error('objects unavailable');
      if (args[0] === 'merge-base') return `${base}\n`;
      return kind === 'oversized' ? 'x'.repeat(1024 * 1024 + 1) : args.includes(`${base}..${head}`) ? `${patch}+different\n` : patch;
    });
    expect(f.plan()[0]).toMatchObject({ action: 'review', why: 'unprovable head move needs a full review' });
    runRedTeamOnSkip(f.options);
    expect(f.options.dispatch).toHaveBeenCalledWith({ repo, pr });
    expect(f.provider.setLabels).not.toHaveBeenCalled(); expect(runGhSync).not.toHaveBeenCalled();
  });
  it.each(['unreadable seal', 'unknown evidence'])('unreadable evidence fails closed and retries before escalation (%s)', kind => {
    const f = fixture();
    if (kind === 'unreadable seal') f.options.readSeal = () => ({ unreadable: true }); else f.evidence.ok = false;
    runRedTeamOnSkip(f.options);
    expect(f.provider.setLabels).not.toHaveBeenCalled(); expect(f.options.publishCarriedCheck).not.toHaveBeenCalled();
    expect(f.options.dispatch).toHaveBeenCalledOnce(); expect(f.options.escalate).not.toHaveBeenCalled();
    f.options.capacity.lanes = 1; f.options.capacity.budget.left = 1;
    const second = runRedTeamOnSkip(f.options).rows[0];
    expect(second).toMatchObject({ action: 'skip', escalate: true, why: expect.stringContaining('retry budget spent') });
    expect(f.options.dispatch).toHaveBeenCalledOnce(); expect(f.options.escalate).toHaveBeenCalledOnce();
  });
  it('a head moving during settlement changes no labels or checks and starts no job', () => {
    const f = fixture();
    f.provider.readPrState.mockImplementation(() => ({ ...f.raw, headRefOid: old }));
    runRedTeamOnSkip(f.options);
    expect(f.provider.setLabels).not.toHaveBeenCalled(); expect(f.options.publishCarriedCheck).not.toHaveBeenCalled();
    expect(f.options.dispatch).not.toHaveBeenCalled(); expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it('a head moving at the final label write changes nothing', () => {
    const f = fixture(); let reads = 0;
    f.provider.readPrState.mockImplementation(() => ({ ...f.raw, headRefOid: ++reads >= 4 ? old : head }));
    runRedTeamOnSkip(f.options);
    expect(f.provider.setLabels).not.toHaveBeenCalled(); expect(f.options.dispatch).not.toHaveBeenCalled();
  });
  it('a seal becoming unreadable at the final label write changes nothing and retries', () => {
    const f = fixture(); let reads = 0;
    f.options.readSeal = () => ++reads === 1 ? null : { unreadable: true };
    runRedTeamOnSkip(f.options);
    expect(f.provider.setLabels).not.toHaveBeenCalled(); expect(f.options.dispatch).toHaveBeenCalledOnce();
    expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it('a net patch changing between planning and settlement re-runs without carrying', () => {
    const f = fixture(); f.raw.comments = [accept(old), result(old)];
    f.evidence.loopPayload.findings.read.netBasis.rev = old;
    let patches = 0;
    f.options.exec.mockImplementation((_file, args) => args[0] === 'merge-base' ? `${base}\n`
      : args[0] === 'patch-id' ? `${base} ${old}\n` : ++patches > 2 ? `${patch}+changed\n${patches}\n` : patch);
    runRedTeamOnSkip(f.options);
    expect(runGhSync).not.toHaveBeenCalled(); expect(f.provider.setLabels).not.toHaveBeenCalled();
    expect(f.options.dispatch).toHaveBeenCalledOnce(); expect(f.options.escalate).not.toHaveBeenCalled();
  });
  it('a persisted spent retry escalates unreadable evidence without launching another job', () => {
    const f = fixture(); f.options.readSeal = () => ({ unreadable: true });
    f.options.readStatus = () => ({ head, retryCount: 1 });
    const row = runRedTeamOnSkip(f.options).rows[0];
    expect(row).toMatchObject({ action: 'skip', escalate: true, why: expect.stringContaining('retry budget spent') });
    expect(f.provider.setLabels).not.toHaveBeenCalled(); expect(f.options.dispatch).not.toHaveBeenCalled();
    expect(f.options.escalate).toHaveBeenCalledOnce();
  });
});

describe('bounded net-diff proof', () => {
  it('refuses carry for different binary payloads and requires --binary when generating both net patches', () => {
    const root = mkdtempSync(join(tmpdir(), 'red-team-binary-patches-')); roots.push(root);
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-global-gitconfig'),
      GIT_AUTHOR_NAME: 'Binary fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Binary fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_AUTHOR_DATE: '2026-11-10T12:00:00Z', GIT_COMMITTER_DATE: '2026-11-10T12:00:00Z' };
    const git = args => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    git(['init', '--quiet', '--initial-branch=main']);
    git(['config', 'core.hooksPath', 'no-hooks']);
    const commitBinary = payload => {
      writeFileSync(join(root, 'asset.bin'), Buffer.from(payload));
      git(['add', '--', 'asset.bin']);
      git(['commit', '--quiet', '--no-gpg-sign', '-m', 'Binary fixture']);
      return git(['rev-parse', 'HEAD']).trim();
    };
    const mainRef = commitBinary([0, 0, 0, 0, 0, 0]);
    const fromSha = commitBinary([0, 1, 2, 3, 4, 5]);
    git(['checkout', '--quiet', '--detach', mainRef]);
    const toSha = commitBinary([0, 5, 4, 3, 2, 1]);
    const patches = [];
    const exec = vi.fn((file, args, options) => {
      const output = execFileSync(file, args, { ...options, env });
      if (args[0] === 'diff') patches.push(output);
      return output;
    });

    expect(proveEquivalentRedTeamDiff({ fromSha, toSha, mainRef, cwd: root, exec })).toEqual({ ok: false });
    // Keep these outside the injected executor: the proof catches executor errors and fails closed.
    expect(exec.mock.calls.filter(([, args]) => args[0] === 'diff').map(([, args]) => args)).toEqual([
      expect.arrayContaining(['--binary', `${mainRef}..${fromSha}`]),
      expect.arrayContaining(['--binary', `${mainRef}..${toSha}`]),
    ]);
    expect(patches).toHaveLength(2);
    expect(patches[0]).toContain('GIT binary patch');
    expect(patches[1]).toContain('GIT binary patch');
    expect(patches[0].slice(patches[0].indexOf('GIT binary patch')))
      .not.toBe(patches[1].slice(patches[1].indexOf('GIT binary patch')));
  });

  it('never carries empty patches; empty-net-diff settlement keeps its separate positive-proof rules', () => {
    const exec = vi.fn((_file, args) => args[0] === 'merge-base' ? `${base}\n` : '');
    expect(proveEquivalentRedTeamDiff({ fromSha: old, toSha: head, exec })).toEqual({ ok: false });
  });
});
