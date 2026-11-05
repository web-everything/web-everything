import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { reverifyStaleReferrals, resolveReferralReverifyMax } from '../referral-reverify.mjs';

// Any accidental escape from the injected IO must fail rather than launch a judge or contact GitHub.
vi.mock('../../lib/codex-judge-spawn.mjs', () => ({
  codexJudgeSpawn: vi.fn(() => { throw new Error('unexpected real judge spawn'); }),
}));
vi.mock('../../lib/gh-throttle.mjs', () => ({
  execFileSyncThrottled: vi.fn(() => { throw new Error('unexpected GitHub call'); }),
}));
import { codexJudgeSpawn } from '../../lib/codex-judge-spawn.mjs';
import { execFileSyncThrottled } from '../../lib/gh-throttle.mjs';

const repo = 'web-everything/web-everything';
const prNumber = 6244;
const oldHead = 'a'.repeat(40);
const head = 'b'.repeat(40);
const now = Date.parse('2026-11-05T12:00:00Z');
const finding = (i, raisedHeads = [oldHead]) => Object.freeze({
  key: `judge:finding-${i}`, runId: 'prior-review', seat: 'judge', attempted: true,
  file: `scripts/example-${i}.mjs`, line: 10 + i,
  summary: `Missing guard ${i}`, raisedHeads: Object.freeze([...raisedHeads]),
});
const evidence = f => `${f.file}:${f.line}: the current diff now guards the missing input`;
const keys = findings => findings.map(f => f.key);

describe('stale referral re-verification (R618)', () => {
  let root;
  let env;
  let serial;

  beforeEach(() => {
    if (!process.env.TMPDIR) throw new Error('TMPDIR must be set for hermetic referral fixtures');
    root = mkdtempSync(join(process.env.TMPDIR, 'referral-reverify-'));
    const platform = join(root, 'platform.json');
    writeFileSync(platform, '{}');
    env = { WE_PLATFORM_PREFERENCES_FILE: platform, WE_REFERRAL_REVERIFY_MAX: '3', WE_POLICY_CASCADE_LOG: '0' };
    serial = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      expect(codexJudgeSpawn).not.toHaveBeenCalled();
      expect(execFileSyncThrottled).not.toHaveBeenCalled();
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  function setup(pending, overrides = {}) {
    const dir = join(root, `receipts-${serial++}`);
    mkdirSync(dir);
    return {
      repo, prNumber, head, comments: [], pending, env, dir, now,
      log: vi.fn(), spawn: vi.fn(async () => ({ reproduces: true, evidence: '' })),
      post: vi.fn(async () => ({ ok: true })), ...overrides,
    };
  }

  it('moved head + stale referral that no longer reproduces -> exactly one consolidated proposal comment with evidence, no ruling written', async () => {
    const pending = Object.freeze([finding(1, [oldHead, head]), finding(2)]);
    const original = structuredClone(pending);
    const args = setup(pending, {
      spawn: vi.fn(async f => ({ reproduces: false, evidence: evidence(f) })),
    });
    expect(await reverifyStaleReferrals(args)).toEqual({ proposed: keys(pending), kept: [], skipped: [] });
    expect(args.spawn).toHaveBeenCalledTimes(2);
    for (const f of pending) expect(args.spawn).toHaveBeenCalledWith(f);
    expect(args.post).toHaveBeenCalledTimes(1);
    const body = args.post.mock.calls[0][0];
    expect(typeof body).toBe('string');
    expect(body).toContain('not-real (stale-head-reraise)');
    expect(body).toContain(head);
    expect(body).toMatch(/operator[^\n]*(?:still|must)[^\n]*rul/i);
    for (const f of pending) {
      expect(body).toContain(f.key);
      expect(body).toContain(evidence(f));
    }
    // A proposal must not publish the machine-readable record used to apply rulings.
    expect(body).not.toContain('<!-- mandatory-referrals-v1:');
    expect(pending).toEqual(original);

    // A later tick with the same durable receipt must not post another proposal.
    await reverifyStaleReferrals({ ...args, now: now + 60_000 });
    expect(args.spawn).toHaveBeenCalledTimes(2);
    expect(args.post).toHaveBeenCalledTimes(1);

    // Even after losing local receipts, the trusted thread marker prevents reposting.
    const trusted = setup(pending, {
      comments: [{ body, viewerDidAuthor: true, author: { login: 'automation' } }],
      spawn: vi.fn(async f => ({ reproduces: false, evidence: evidence(f) })),
    });
    await reverifyStaleReferrals(trusted);
    expect(trusted.post).not.toHaveBeenCalled();

    // Copying the very same marker into an untrusted comment must not suppress the proposal.
    const forged = setup(pending, {
      comments: [{ body, author: { login: 'untrusted-contributor' } }],
      spawn: vi.fn(async f => ({ reproduces: false, evidence: evidence(f) })),
    });
    expect((await reverifyStaleReferrals(forged)).proposed).toEqual(keys(pending));
    expect(forged.post).toHaveBeenCalledTimes(1);
  });

  it('same-head -> no spawn, no proposal', async () => {
    const pending = [finding(1, [head]), finding(2, [head])];
    const args = setup(pending);
    expect(await reverifyStaleReferrals(args)).toEqual({ proposed: [], kept: keys(pending), skipped: [] });
    expect(args.spawn).not.toHaveBeenCalled();
    expect(args.post).not.toHaveBeenCalled();
  });

  it('re-check still reproduces -> kept, no proposal', async () => {
    const pending = [finding(1)];
    const args = setup(pending, {
      spawn: vi.fn(async f => ({ reproduces: true, evidence: `${f.file}:${f.line}: guard is still missing` })),
    });
    expect(await reverifyStaleReferrals(args)).toEqual({ proposed: [], kept: keys(pending), skipped: [] });
    expect(args.spawn).toHaveBeenCalledTimes(1);
    expect(args.post).not.toHaveBeenCalled();
  });

  it('unreadable result (garbage / throw) -> kept, no proposal', async () => {
    const unreadable = [
      async () => 'garbage', async () => undefined,
      async () => ({ reproduces: 'false', evidence: 'scripts/example-1.mjs:11: fixed' }),
      async () => ({ reproduces: false, evidence: '' }),
      async () => ({ reproduces: false, evidence: 'looks fixed' }),
      async () => { throw new Error('unreadable judge output'); },
      async () => { throw Object.assign(new Error('judge timed out'), { code: 'ETIMEDOUT' }); },
    ];
    for (const result of unreadable) {
      const pending = [finding(1)];
      const args = setup(pending, { spawn: vi.fn(result) });
      expect(await reverifyStaleReferrals(args)).toEqual({ proposed: [], kept: keys(pending), skipped: [] });
      expect(args.spawn).toHaveBeenCalledTimes(1);
      expect(args.post).not.toHaveBeenCalled();
    }
  });

  it('bound enforced (max 2 with 4 stale findings -> 2 spawns), restart-safe count, and max=0 disables', async () => {
    const pending = [finding(1), finding(2), finding(3), finding(4)];
    const boundedEnv = { ...env, WE_REFERRAL_REVERIFY_MAX: '2' };
    expect(resolveReferralReverifyMax(boundedEnv)).toEqual({ maxPerPrHead: 2, source: 'env' });
    const args = setup(pending, { env: boundedEnv });
    // skipped identifies the unverified subset of kept: those still require an operator ruling.
    expect(await reverifyStaleReferrals(args)).toEqual({ proposed: [], kept: keys(pending), skipped: keys(pending.slice(2)) });
    expect(args.spawn).toHaveBeenCalledTimes(2);
    expect(args.spawn.mock.calls.map(([f]) => f.key)).toEqual(keys(pending.slice(0, 2)));
    expect(args.post).not.toHaveBeenCalled();
    expect(args.log.mock.calls.flat().join('\n')).toMatch(/maxPerPrHead[^\n]*2[^\n]*env/);

    // Fresh callbacks and deserialized input emulate a restart with only the on-disk receipts retained.
    const restart = {
      ...args, pending: structuredClone(pending), now: now + 60_000,
      spawn: vi.fn(async () => ({ reproduces: true, evidence: '' })), post: vi.fn(), log: vi.fn(),
    };
    const resumed = await reverifyStaleReferrals(restart);
    expect(resumed.proposed).toEqual([]);
    expect(resumed.kept).toEqual(keys(pending));
    expect(resumed.skipped).toEqual(expect.arrayContaining(keys(pending.slice(2))));
    expect(restart.spawn).not.toHaveBeenCalled();
    expect(restart.post).not.toHaveBeenCalled();

    // The budget is scoped to this PR and head, rather than to the entire receipt directory.
    for (const subject of [{ head: 'c'.repeat(40) }, { prNumber: prNumber + 1 }, { repo: 'another/repo' }]) {
      const fresh = { ...restart, ...subject, spawn: vi.fn(async () => ({ reproduces: true, evidence: '' })) };
      await reverifyStaleReferrals(fresh);
      expect(fresh.spawn).toHaveBeenCalledTimes(2);
    }

    const disabledEnv = { ...env, WE_REFERRAL_REVERIFY_MAX: '0' };
    expect(resolveReferralReverifyMax(disabledEnv)).toEqual({ maxPerPrHead: 0, source: 'env' });
    const disabled = setup(pending, { env: disabledEnv });
    expect(await reverifyStaleReferrals(disabled)).toEqual({ proposed: [], kept: keys(pending), skipped: keys(pending) });
    expect(disabled.spawn).not.toHaveBeenCalled();
    expect(disabled.post).not.toHaveBeenCalled();

    const standardEnv = { ...env };
    delete standardEnv.WE_REFERRAL_REVERIFY_MAX;
    expect(resolveReferralReverifyMax(standardEnv)).toEqual({ maxPerPrHead: 3, source: 'standard' });
    for (const invalid of ['-1', '11', '1.5', 'garbage', '']) {
      expect(resolveReferralReverifyMax({ ...standardEnv, WE_REFERRAL_REVERIFY_MAX: invalid }))
        .toEqual({ maxPerPrHead: 3, source: 'standard' });
    }
    expect(resolveReferralReverifyMax({ ...env, WE_REFERRAL_REVERIFY_MAX: '10' }))
      .toEqual({ maxPerPrHead: 10, source: 'env' });
    writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ referralReverify: { maxPerPrHead: 1 } }));
    expect(resolveReferralReverifyMax(standardEnv)).toEqual({ maxPerPrHead: 1, source: 'platform' });
    expect(resolveReferralReverifyMax(boundedEnv)).toEqual({ maxPerPrHead: 2, source: 'env' });
  });
});
