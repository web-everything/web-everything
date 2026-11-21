// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { verify } from '../lib/drain-verdict.mjs';
import { runBatch } from '../drain-classify-only.mjs';

const computedAt = '2026-11-09T12:00:00.000Z';
const now = Date.parse(computedAt);
const headSha = 'a'.repeat(40), mainSha = 'b'.repeat(40);
const OWN = 'o/r', OTHER = 'frontierui/plateau-app';
const batchArgv = ['--batch', '--verdict-dir=verdicts'];
const okDryRun = num => ({ ok: true, dryRun: true, heldCoupleMembers: 0, skipped: [], parked: [], skipReasons: [],
  toMerge: [{ num, repo: OWN, headSha }] });
const listingFailure = (repo, num = 7) => ({ ...okDryRun(num), failedRepos: [{ repo, kind: 'listing', text: `FAILED open-PR listing for ${repo}`, retryable: false }] });

function batchIo({ prs = [7, 8], dryRunFor }) {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'schedule',
    GITHUB_RUN_ID: '123456', GITHUB_REPOSITORY: OWN, GITHUB_TOKEN: 'read-only-fixture' };
  return { env, now: () => now, mkdirSync: vi.fn(), writeFileSync: vi.fn(),
    execFileSync: vi.fn((cmd, args) => {
      if (cmd === 'git') return mainSha + '\n';
      if (cmd === 'gh') return JSON.stringify(prs.map(number => ({ number, labels: [{ name: 'ready-to-merge' }] })));
      const n = Number(args.find(a => a.startsWith('--only=')).slice(7));
      return JSON.stringify(dryRunFor(n));
    }) };
}
const written = io => Object.fromEntries(io.writeFileSync.mock.calls.map(c => [c[0], JSON.parse(String(c[1]))]));
const quiet = fn => {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try { return [fn(), spy.mock.calls.map(c => String(c[0])).join('')]; } finally { spy.mockRestore(); }
};

describe('drain-classify-only: cross-repo listing failure degrades to unknown', () => {
  it('per-PR classification failure writes verdict unknown and batch exits 0', () => {
    const io = batchIo({ dryRunFor: n => (n === 7 ? listingFailure(OTHER) : okDryRun(n)) });
    const [out] = quiet(() => runBatch(batchArgv, io));
    expect(out.failed).toBe(0);
    expect(out.written).toBe(1);
    const files = written(io);
    expect(files['verdicts/pr-7.json']).toMatchObject({ pr: 7, decision: 'unknown' });
    expect(files['verdicts/pr-8.json']).toMatchObject({ pr: 8, decision: 'enqueue' });
  });

  it('unknown carries its reason', () => {
    const io = batchIo({ dryRunFor: n => (n === 7 ? listingFailure(OTHER) : okDryRun(n)) });
    quiet(() => runBatch(batchArgv, io));
    const v = written(io)['verdicts/pr-7.json'];
    expect(v.reason).toMatch(/cross-repo listing/);
    expect(v.reason).toContain(OTHER);
  });

  it('an unknown verdict is never mergeable: verify refuses it', () => {
    const io = batchIo({ dryRunFor: n => (n === 7 ? listingFailure(OTHER) : okDryRun(n)) });
    quiet(() => runBatch(batchArgv, io));
    const v = written(io)['verdicts/pr-7.json'];
    const provenance = v.provenance;
    const live = { repo: v.repo, pr: 7, headSha, mainSha, provenance };
    expect(verify(v, live, { now }).ok).toBe(false);
    // Non-vacuous: the same artifact completed to a fully valid shape is refused ONLY because of decision 'unknown'.
    const complete = decision => ({ ...v, decision, headSha, mainSha,
      localOnly: Object.fromEntries(['red-main-freeze', 'card-group', 'manifest-baseline', 'couple-whole', 'test-gaming-scan'].map(k => [k, 'unknown'])) });
    const withoutReason = decision => { const c = complete(decision); delete c.reason; return c; };
    expect(verify(withoutReason('enqueue'), live, { now }).ok).toBe(true);
    expect(verify(withoutReason('unknown'), live, { now }).ok).toBe(false);
  });

  it('a retryable (outage/rate-limit) or malformed cross-repo failure is not downgraded to unknown', () => {
    for (const dry of [
      n => ({ ...listingFailure(OTHER), failedRepos: [{ repo: OTHER, retryable: true }] }),
      n => ({ ...listingFailure(OTHER), failedRepos: [{ repo: '', retryable: false }] }),
      n => ({ ...listingFailure(OTHER), failedRepos: [{ repo: OWN.toUpperCase(), retryable: false }] }),
      n => ({ ...listingFailure(OTHER), toMerge: undefined }),
    ]) {
      const io = batchIo({ prs: [7], dryRunFor: dry });
      const [out] = quiet(() => runBatch(batchArgv, io));
      expect(out).toMatchObject({ written: 0, failed: 1 });
      expect(io.writeFileSync).not.toHaveBeenCalled();
    }
  });

  it('a listing failure on the run own repo still fails the PR (exit 1, nothing unknown)', () => {
    const io = batchIo({ dryRunFor: n => (n === 7 ? listingFailure(OWN) : okDryRun(n)) });
    const [out] = quiet(() => runBatch(batchArgv, io));
    expect(out.failed).toBe(1);
    expect(written(io)['verdicts/pr-7.json']).toBeUndefined();
  });

  it('no verdict written at all still exits 1', () => {
    const io = batchIo({ prs: [7], dryRunFor: () => ({ ok: false }) });
    const [out] = quiet(() => runBatch(batchArgv, io));
    expect(out).toMatchObject({ written: 0, failed: 1 });
  });

  it('every PR unknown fails the run with a summary', () => {
    const io = batchIo({ dryRunFor: n => listingFailure(OTHER, n) });
    const [out, err] = quiet(() => runBatch(batchArgv, io));
    expect(out.failed).toBe(1);
    expect(out.written).toBe(0);
    expect(err).toMatch(/all 2 PR\(s\) unknown/);
  });
});
