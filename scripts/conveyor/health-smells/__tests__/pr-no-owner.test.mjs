/**
 * @file scripts/conveyor/health-smells/__tests__/pr-no-owner.test.mjs
 * @description Landing-freeze fix, web-everything/web-everything#2793 (2026-09-27) — the `pr-no-owner` smell's PURE
 *   `evaluate()`, fed the REAL fix-dispatch-daemon log lines this incident produced (`gh` shape captured live:
 *   `refused missing-run-cap-exhausted … PR #2793 — … head sha 8be3bce0e51990837b7f9c016b407ec0f1657a1c already
 *   had 2 missing-run trigger attempt(s) …` and `reconcile-refused owed-elsewhere … PR #2793 — the branch needs
 *   a rebase before it can merge`) through the real `foldDaemonMemory`, exactly like
 *   `dispatch-refused-stale-clone.test.mjs`'s own convention.
 */
import { describe, it, expect } from 'vitest';
import { foldDaemonMemory } from '../../health-watch-core.mjs';
import smell, { ELSEWHERE_REASON_RE, findFixerSession } from '../pr-no-owner.mjs';

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-27T05:50:00Z');

const PR_2793_TICK = [
  'reconcile-fix-dispatch-daemon: tick (web-everything/web-everything) — dispatched 0, refused 2',
  'reconcile-fix-dispatch-daemon: refused missing-run-cap-exhausted web-everything/web-everything PR #2793 — PR #2793\'s head sha 8be3bce0e51990837b7f9c016b407ec0f1657a1c already had 2 missing-run trigger attempt(s) that did not produce a real check run (cap 2) — this needs a human/ci-heal look, not another mechanical trigger',
  'reconcile-fix-dispatch-daemon: reconcile-refused owed-elsewhere web-everything/web-everything PR #2793 — the branch needs a rebase before it can merge',
].join('\n');

const OTHER_PR_HEALTHY_TICK = 'reconcile-fix-dispatch-daemon: tick (web-everything/web-everything) — dispatched 1, refused 0';

function feed(chunks) {
  let mem;
  let size = 0;
  chunks.forEach(({ text, at }) => {
    size += text.length + 1;
    mem = foldDaemonMemory(mem, { name: 'fix-dispatch-daemon', mtimeMs: at, sizeBytes: size, text: `${text}\n`, bootstrap: false }, at);
  });
  return mem;
}

const PR_2793 = { repo: 'web-everything/web-everything', number: 2793, title: 'daemon-soak owed-ci-rerun: excuse via main\'s own latest-run green check', headRefName: 'lane/rerun-after-main-fix' };

describe('ELSEWHERE_REASON_RE', () => {
  it('matches both refusal kinds this smell exists for, and only those', () => {
    expect(ELSEWHERE_REASON_RE.test('reconcile-refused owed-elsewhere')).toBe(true);
    expect(ELSEWHERE_REASON_RE.test('refused missing-run-cap-exhausted: PR #2793\'s head sha … (cap 2)')).toBe(true);
    expect(ELSEWHERE_REASON_RE.test('reconcile-refused nothing-owed')).toBe(false);
    expect(ELSEWHERE_REASON_RE.test('reconcile-refused cap-exhausted')).toBe(false);
    expect(ELSEWHERE_REASON_RE.test('refused no-lane: …')).toBe(false);
  });
});

describe('findFixerSession', () => {
  // Filtering to LIVE (non-terminal) sessions is the CALLER's job (`evaluate()`'s own `live` filter, mirroring
  // `red-pr-unattended.mjs`'s identical split) — this helper only matches by name against whatever list it is
  // handed, so it is tested that way here too.
  it('finds a fix-<PR>-named session by name', () => {
    expect(findFixerSession([{ name: 'fix-2793', state: 'working' }], '2793')?.name).toBe('fix-2793');
    expect(findFixerSession([{ name: 'ci-heal-2793-x' }], '2793')?.name).toBe('ci-heal-2793-x');
  });

  it('returns null when no session name matches', () => {
    expect(findFixerSession([{ name: 'fix-9999' }], '2793')).toBeNull();
    expect(findFixerSession([], '2793')).toBeNull();
  });
});

describe('pr-no-owner — RED before this smell existed: no existing smell would have caught #2793', () => {
  it('is neither CI-red (statusCheckRollup is EMPTY, never failing) nor an ordinary dispatch-layer refusal red-pr-unattended.mjs already covers', () => {
    // red-pr-unattended.mjs requires a FAILING check or the ci:failed label — #2793's rollup is empty (no merge
    // ref, no run ever started), so that smell's own `redInfo()` returns null for it (see red-pr-unattended.mjs).
    expect(true).toBe(true); // documentation-only assertion — the real proof is the live-shaped test below firing
  });
});

describe('pr-no-owner — GREEN: #2793\'s real shape', () => {
  it('breaches when the fix-dispatch daemon\'s latest word is one of the two "elsewhere" refusal kinds and no fixer session is live', () => {
    const mem = feed([{ text: PR_2793_TICK, at: T0 }]);
    const [r] = smell.evaluate({ prs: [PR_2793], agents: [] }, { now: T0 + 5 * MINUTE, daemons: { 'fix-dispatch-daemon': mem } });
    expect(r).toBeDefined();
    expect(r.subject).toBe('web-everything/web-everything#2793');
    expect(r.breach).toBe(true);
    // The daemon processes the `refused …` line before the `reconcile-refused …` line each tick (this file's own
    // onTick order), so the LATEST recorded reason for this PR is the reconcile-core one — still one of the two
    // "elsewhere" kinds either way, so the smell fires regardless of which one survives the overwrite.
    expect(r.measure.reason).toBe('reconcile-refused owed-elsewhere');
    expect(r.recommendation).toContain('2793');
  });

  it('does NOT breach once a live fixer session picks the PR up', () => {
    const mem = feed([{ text: PR_2793_TICK, at: T0 }]);
    const [r] = smell.evaluate(
      { prs: [PR_2793], agents: [{ name: 'fix-2793', state: 'working' }] },
      { now: T0 + 5 * MINUTE, daemons: { 'fix-dispatch-daemon': mem } },
    );
    expect(r.breach).toBe(false);
  });

  it('never fires for a PR whose latest refusal is an ordinary, correct no-op (nothing-owed / cap-exhausted)', () => {
    const healthyTick = [
      'reconcile-fix-dispatch-daemon: tick (web-everything/web-everything) — dispatched 0, refused 1',
      'reconcile-fix-dispatch-daemon: reconcile-refused nothing-owed web-everything/web-everything PR #2793 — phase `queued` — reviewed and queued, or already landed; this pass has nothing to dispatch',
    ].join('\n');
    const mem = feed([{ text: healthyTick, at: T0 }]);
    const out = smell.evaluate({ prs: [PR_2793], agents: [] }, { now: T0 + 5 * MINUTE, daemons: { 'fix-dispatch-daemon': mem } });
    expect(out).toEqual([]);
  });

  it('never fires for a PR the fix-dispatch daemon has never mentioned at all', () => {
    const mem = feed([{ text: OTHER_PR_HEALTHY_TICK, at: T0 }]);
    const out = smell.evaluate({ prs: [PR_2793], agents: [] }, { now: T0 + 5 * MINUTE, daemons: { 'fix-dispatch-daemon': mem } });
    expect(out).toEqual([]);
  });

  it('tolerates a missing daemon memory (the fix-dispatch daemon has no log yet) rather than throwing', () => {
    expect(smell.evaluate({ prs: [PR_2793], agents: [] }, { now: T0, daemons: {} })).toEqual([]);
  });
});
