/** @file Operator readiness gates (label gate, label/comment cross-check, transient mergeability) and the read-only CLI report over inline gh fixtures. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { evaluatePr, main, pollMergeable, standDownRow, stuckInspectedRow } from '../operations/operator-queue.mjs';
import { STAND_DOWN_MARKER, buildStandDownComment } from '../conveyor/stand-down.mjs';
import { STUCK_DISPATCH_MARKER, buildStuckDispatchComment } from '../conveyor/stuck-pr-dispatch-marker.mjs';

vi.mock('node:child_process', () => {
  const execFileSync = vi.fn();
  return { execFileSync, default: { execFileSync } };
});
afterEach(() => vi.restoreAllMocks());

/** A path that never exists, so `main` never reads the real `.conveyor/unsupported-repo.json` sidecar. */
const NO_UNSUPPORTED = '/nonexistent-operator-queue-test/unsupported-repo.json';
const HEAD = 'fd37ce270aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** A LEGACY advisory comment (no `**Advisory outcome:**` line) — the verdict line is all a reader had. */
const advisory = (head = HEAD, verdict = 'approve', createdAt = '2026-09-18T12:00:00Z') => ({
  body: `**Verdict:** ${verdict}\nNet basis: \`${BASE}..${head}\``, createdAt,
});
/** A current-format advisory: on a `review:human` PR the verdict line is always "human review required". */
const advisoryWithOutcome = (outcome, head = HEAD, createdAt = '2026-09-18T12:00:00Z') => ({
  body: `**Verdict:** 🚦 human review required\n**Advisory outcome:** \`${outcome}\` — x.\nNet basis: \`${BASE}..${head}\``, createdAt,
});
const HUMAN = { name: 'review:human' };
const ACCEPTED = { name: 'advisory:accepted' };
const CHANGES = { name: 'advisory:changes' };
const PENDING = { name: 'review:pending' };
const fixture = (overrides = {}) => ({
  number: 42, title: 'Ready for review', labels: [HUMAN, ACCEPTED],
  headRefOid: HEAD, mergeable: 'MERGEABLE', comments: [advisory()],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  ...overrides,
});

describe('evaluatePr', () => {
  it('passes a fully ready PR without mutating it', () => {
    const pr = fixture();
    const before = structuredClone(pr);
    expect(evaluatePr(pr)).toEqual({ ready: true, reasons: [], transient: false });
    expect(pr).toEqual(before);
  });

  it.each([
    ['missing human label', { labels: [ACCEPTED] }, 'no review:human label'],
    ['no advisory', { comments: [], labels: [HUMAN] }, 'no advisory verdict'],
    ['verdict changes', { comments: [advisory(HEAD, 'Changes requested')], labels: [HUMAN, CHANGES] }, 'changes requested'],
    ['changes label', { labels: [HUMAN, ACCEPTED, { name: 'review:changes' }] }, 'changes requested'],
    ['failing check', { statusCheckRollup: [{ name: 'smoke', status: 'COMPLETED', conclusion: 'FAILURE' }] }, 'CI failing: smoke'],
    ['pending check', { statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS', conclusion: null }] }, 'CI pending: test'],
    ['failed label', { labels: [HUMAN, ACCEPTED, { name: 'ci:failed' }] }, 'ci:failed label'],
    ['conflicting', { mergeable: 'CONFLICTING' }, 'conflicts with base'],
    ['conflict label', { labels: [HUMAN, ACCEPTED, { name: 'merge-status:conflicting' }] }, 'conflicts with base'],
  ])('fails only the expected gate: %s', (_, overrides, reason) => {
    expect(evaluatePr(fixture(overrides))).toEqual({ ready: false, reasons: [reason], transient: false });
  });

  it('skips a newer escalation verdict without Net basis', () => {
    expect(evaluatePr(fixture({ comments: [advisory(), {
      body: '🚦 human review required\n**Verdict:** changes requested',
      createdAt: '2026-09-19T12:00:00Z',
    }] })).ready).toBe(true);
  });

  it('uses the most recent real advisory even if comments are out of order', () => {
    expect(evaluatePr(fixture({ labels: [HUMAN], comments: [
      advisory('21aaedb0b', 'changes requested', '2026-09-19T12:00:00Z'), advisory(),
    ] })).reasons).toEqual(['advisory is on 21aaedb0b, head is fd37ce270', 'changes requested']);
  });

  it.each([
    { comments: [advisory(HEAD.slice(0, 9))] },
    { headRefOid: HEAD.slice(0, 9) },
  ])('accepts a matching SHA prefix in either direction', (overrides) => {
    expect(evaluatePr(fixture(overrides)).ready).toBe(true);
  });

  it('ignores review-gate failure and accepts skipped and neutral checks', () => {
    expect(evaluatePr(fixture({ statusCheckRollup: [
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'optional', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { name: 'lint', status: 'COMPLETED', conclusion: 'NEUTRAL' },
    ] })).ready).toBe(true);
  });

  it('reads the current-format outcome line, not the always-"human review required" verdict line', () => {
    expect(evaluatePr(fixture({ comments: [advisoryWithOutcome('accept')] })).ready).toBe(true);
    expect(evaluatePr(fixture({ labels: [HUMAN, CHANGES], comments: [advisoryWithOutcome('changes')] })))
      .toEqual({ ready: false, reasons: ['changes requested'], transient: false });
  });
});

// THE LABEL GATE. NEEDS YOU requires `review:human` + `advisory:accepted` and NEITHER `review:pending` NOR
// `review:changes`; the parsed comment is the cross-check, and any disagreement is reported, never resolved.
describe('evaluatePr — the advisory label gate', () => {
  it('label PRESENT and the comment agrees → ready', () => {
    expect(evaluatePr(fixture({ labels: [HUMAN, ACCEPTED], comments: [advisoryWithOutcome('accept')] })).ready).toBe(true);
  });

  it('label ABSENT while the comment accepts this head → NOT READY, the disagreement is the reason', () => {
    expect(evaluatePr(fixture({ labels: [HUMAN] }))).toEqual({
      ready: false,
      reasons: ['label/comment disagreement: advisory comment says accept on this head but advisory:accepted is absent'],
      transient: false,
    });
  });

  it.each([
    ['no advisory comment at all', { comments: [] },
      ['no advisory verdict', 'label/comment disagreement: advisory:accepted is set but no advisory comment']],
    ['the comment is on an older head', { comments: [advisory('21aaedb0b')] },
      ['advisory is on 21aaedb0b, head is fd37ce270',
        'label/comment disagreement: advisory:accepted is set but advisory comment is not on this head']],
    ['the comment requests changes', { comments: [advisoryWithOutcome('changes')] },
      ['changes requested',
        'label/comment disagreement: advisory:accepted is set but advisory comment says changes on this head']],
  ])('label says accepted but %s → NOT READY with the disagreement', (_, overrides, reasons) => {
    expect(evaluatePr(fixture(overrides))).toEqual({ ready: false, reasons, transient: false });
  });

  it('advisory:changes on a PR whose comment accepts → disagreement', () => {
    expect(evaluatePr(fixture({ labels: [HUMAN, CHANGES] })).reasons).toEqual([
      'label/comment disagreement: advisory:changes is set but advisory comment says accept on this head',
    ]);
  });

  it('both advisory labels set → disagreement', () => {
    expect(evaluatePr(fixture({ labels: [HUMAN, ACCEPTED, CHANGES] })).reasons).toEqual([
      'label/comment disagreement: advisory:accepted and advisory:changes are both set',
    ]);
  });

  it('review:pending is never ready, even with a clean label and comment', () => {
    expect(evaluatePr(fixture({ labels: [HUMAN, ACCEPTED, PENDING] }))).toEqual({
      ready: false, reasons: ['review:pending label (advisory not accepted yet)'], transient: false,
    });
  });

  it('review:changes is never ready, even with a clean label and comment', () => {
    expect(evaluatePr(fixture({ labels: [HUMAN, ACCEPTED, { name: 'review:changes' }] })).ready).toBe(false);
  });

  it('a clean comment with NEITHER advisory label yet is reported, not silently promoted', () => {
    const { ready, reasons } = evaluatePr(fixture({ labels: [HUMAN, PENDING] }));
    expect(ready).toBe(false);
    expect(reasons).toHaveLength(2);
    expect(reasons[1]).toContain('advisory:accepted is absent');
  });
});

// `mergeable: UNKNOWN` is GitHub's transient still-computing state — not agent work.
describe('evaluatePr — transient mergeability', () => {
  it.each(['UNKNOWN', undefined, ''])('%j on an otherwise-ready PR is transient: not ready, no reasons', (mergeable) => {
    expect(evaluatePr(fixture({ mergeable }))).toEqual({ ready: false, reasons: [], transient: true });
  });

  it('is not transient when a real gate also fails — and does not list mergeability among the reasons', () => {
    expect(evaluatePr(fixture({ mergeable: 'UNKNOWN', labels: [HUMAN] }))).toEqual({
      ready: false,
      reasons: ['label/comment disagreement: advisory comment says accept on this head but advisory:accepted is absent'],
      transient: false,
    });
  });
});

describe('pollMergeable', () => {
  const view = (mergeable) => JSON.stringify({ mergeable });

  it('returns as soon as GitHub gives a definite answer, backing off between polls', () => {
    const exec = vi.fn().mockReturnValueOnce(view('UNKNOWN')).mockReturnValueOnce(view('MERGEABLE'));
    const sleep = vi.fn();
    expect(pollMergeable({ repo: 'o/n', number: 7, exec, sleep })).toBe('MERGEABLE');
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'view', '7', '--repo', 'o/n', '--json', 'mergeable'], expect.any(Object));
  });

  it('gives up as UNKNOWN after the attempts run out; a failing poll counts as still unknown', () => {
    const exec = vi.fn().mockReturnValueOnce(view('UNKNOWN')).mockImplementationOnce(() => { throw new Error('boom'); })
      .mockReturnValue(view('UNKNOWN'));
    const sleep = vi.fn();
    expect(pollMergeable({ repo: 'o/n', number: 7, exec, sleep })).toBe('UNKNOWN');
    expect(exec).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000, 8000]);
  });
});

describe('main', () => {
  const list = (...prs) => vi.mocked(execFileSync).mockReset().mockReturnValueOnce(JSON.stringify(prs));

  it('filters out PRs without review:human and continues after a repo error', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(execFileSync).mockReset()
      .mockImplementationOnce(() => { throw new Error('unavailable'); })
      .mockReturnValueOnce(JSON.stringify([
        fixture({ number: 1, labels: [] }), fixture(), fixture({ number: 43, labels: [HUMAN] }),
      ]));
    main(['--repo=owner/broken', '--repo=owner/good', '--json'], { unsupportedPath: NO_UNSUPPORTED });
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      ready: [{ repo: 'owner/good', number: 42, title: 'Ready for review' }],
      pending: [],
      notReady: [{
        repo: 'owner/good', number: 43, title: 'Ready for review',
        reasons: ['label/comment disagreement: advisory comment says accept on this head but advisory:accepted is absent'],
      }],
      stoodDown: [],
      stuck: [],
      errors: ['owner/broken: unavailable'],
      unsupported: [],
      laneDecisions: [],
    });
    expect(execFileSync).toHaveBeenLastCalledWith('gh', [
      'pr', 'list', '--repo', 'owner/good', '--state', 'open', '--limit', '200', '--json',
      'number,title,labels,headRefOid,mergeable,statusCheckRollup,comments',
    ], expect.objectContaining({ encoding: 'utf8' }));
  });

  it('UNKNOWN then MERGEABLE on re-poll → NEEDS YOU (the flapping gate settles)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sleep = vi.fn();
    list(fixture({ number: 43, mergeable: 'UNKNOWN' }));
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify({ mergeable: 'UNKNOWN' }))
      .mockReturnValueOnce(JSON.stringify({ mergeable: 'MERGEABLE' }));
    main(['--repo=o/n', '--json'], { sleep, unsupportedPath: NO_UNSUPPORTED });
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      ready: [{ repo: 'o/n', number: 43, title: 'Ready for review' }], pending: [], notReady: [], stoodDown: [], stuck: [], errors: [], unsupported: [], laneDecisions: [],
    });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
  });

  it('UNKNOWN throughout → the transient PENDING bucket, never NOT READY', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sleep = vi.fn();
    list(fixture({ number: 43, mergeable: 'UNKNOWN' }));
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ mergeable: 'UNKNOWN' }));
    main(['--repo=o/n', '--json'], { sleep, unsupportedPath: NO_UNSUPPORTED });
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      ready: [], pending: [{ repo: 'o/n', number: 43, title: 'Ready for review' }], notReady: [], stoodDown: [], stuck: [], errors: [], unsupported: [], laneDecisions: [],
    });
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it('does not re-poll a PR that already fails a real gate', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sleep = vi.fn();
    list(fixture({ number: 43, mergeable: 'UNKNOWN', labels: [HUMAN, ACCEPTED, PENDING] }));
    main(['--repo=o/n', '--json'], { sleep, unsupportedPath: NO_UNSUPPORTED });
    expect(sleep).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0]).notReady[0].reasons).toEqual(['review:pending label (advisory not accepted yet)']);
  });

  it('prints all three sections in the text report, PENDING labelled as transient', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    list(fixture({ number: 43, mergeable: 'UNKNOWN' }));
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ mergeable: 'UNKNOWN' }));
    main(['--repo=o/n'], { sleep: vi.fn(), unsupportedPath: NO_UNSUPPORTED });
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'NEEDS YOU (review:human + advisory:accepted, all gates pass):', '(none)',
      'PENDING — transient, re-run (GitHub is still computing mergeability; no agent work owed):', 'o/n#43  Ready for review',
      'UNSUPPORTED REPO — owed work the conveyor cannot dispatch for this repo:', '(none)',
      'NOT READY — agent work (review:human but gates fail):', '(none)',
      'STOOD DOWN — needs your judgment (a fix agent asked a question; no label changed):', '(none)',
      'STUCK — inspected (epic #3383 dispatched a diagnosis-only agent; read its comment):', '(none)',
      'LANE RECLAIM — needs your decision (#3383, see `node scripts/lane-whois.mjs`):', '(none)',
    ]);
  });

  it('prints exactly the empty sections and queries all default repos', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(execFileSync).mockReset().mockReturnValue('[]');
    main([], { unsupportedPath: NO_UNSUPPORTED });
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'NEEDS YOU (review:human + advisory:accepted, all gates pass):', '(none)',
      'PENDING — transient, re-run (GitHub is still computing mergeability; no agent work owed):', '(none)',
      'UNSUPPORTED REPO — owed work the conveyor cannot dispatch for this repo:', '(none)',
      'NOT READY — agent work (review:human but gates fail):', '(none)',
      'STOOD DOWN — needs your judgment (a fix agent asked a question; no label changed):', '(none)',
      'STUCK — inspected (epic #3383 dispatched a diagnosis-only agent; read its comment):', '(none)',
      'LANE RECLAIM — needs your decision (#3383, see `node scripts/lane-whois.mjs`):', '(none)',
    ]);
    expect(vi.mocked(execFileSync).mock.calls.map(([, args]) => args[3])).toEqual([
      'chalbert/web-everything', 'chalbert/frontierui', 'chalbert/plateau-app',
    ]);
  });
});

// STOOD DOWN — we:backlog/x6cjgz5. A conveyor stand-down comment changes no label, so a stood-down PR without
// `review:human` was in nobody's queue (live: PR #2505). This section lists every open PR carrying at least one
// leading-line stand-down comment, regardless of label, and never repeats a PR already shown in NEEDS YOU.
describe('standDownRow', () => {
  it('returns null for a PR with no stand-down comment', () => {
    expect(standDownRow('o/n', fixture())).toBeNull();
  });

  it('extracts the stated reason and timestamp from a leading-line stand-down comment', () => {
    const body = buildStandDownComment({ reason: 'gate-red' });
    const pr = fixture({ labels: [], comments: [{ body, createdAt: '2026-09-20T10:00:00Z' }] });
    expect(standDownRow('o/n', pr)).toEqual({
      repo: 'o/n', number: 42, title: 'Ready for review',
      standDownAt: '2026-09-20T10:00:00Z',
      reason: 'the gate stayed RED after the repair, and a red diff must never be re-pushed',
      alsoReviewHuman: false,
    });
  });

  it('ignores a marker that is only QUOTED, not the leading line', () => {
    const pr = fixture({ labels: [], comments: [{ body: `> ${STAND_DOWN_MARKER}\n\nI'll take it.`, createdAt: 't' }] });
    expect(standDownRow('o/n', pr)).toBeNull();
  });

  it('flags alsoReviewHuman when the PR still carries review:human', () => {
    const body = buildStandDownComment({ reason: 'conflict' });
    const pr = fixture({ labels: [HUMAN], comments: [{ body, createdAt: 't' }] });
    expect(standDownRow('o/n', pr).alsoReviewHuman).toBe(true);
  });

  it('picks the most recent stand-down comment when a PR has stood down more than once', () => {
    const pr = fixture({ labels: [], comments: [
      { body: buildStandDownComment({ reason: 'gate-red' }), createdAt: '2026-09-20T10:00:00Z' },
      { body: buildStandDownComment({ reason: 'conflict' }), createdAt: '2026-09-18T10:00:00Z' },
    ] });
    expect(standDownRow('o/n', pr).reason).toContain('gate stayed RED');
  });
});

describe('main — STOOD DOWN section', () => {
  const list = (...prs) => vi.mocked(execFileSync).mockReset().mockReturnValueOnce(JSON.stringify(prs));

  it('lists an open PR with a leading-line stand-down comment regardless of labels, with its reason', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const body = buildStandDownComment({ reason: 'needs-judgment' });
    list(fixture({ number: 99, labels: [], comments: [{ body, createdAt: '2026-09-20T00:00:00Z' }] }));
    main(['--repo=o/n', '--json'], { unsupportedPath: NO_UNSUPPORTED });
    expect(JSON.parse(log.mock.calls[0][0]).stoodDown).toEqual([{
      repo: 'o/n', number: 99, title: 'Ready for review',
      standDownAt: '2026-09-20T00:00:00Z',
      reason: 'the reviewer\'s finding needs a judgment the fix agent could not safely make, so it did NOT guess',
      alsoReviewHuman: false,
    }]);
  });

  it('does not list a PR whose stand-down marker is only quoted, not leading', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    list(fixture({ number: 99, labels: [], comments: [{ body: `> ${STAND_DOWN_MARKER}\nI'll take it.`, createdAt: 't' }] }));
    main(['--repo=o/n', '--json'], { unsupportedPath: NO_UNSUPPORTED });
    expect(JSON.parse(log.mock.calls[0][0]).stoodDown).toEqual([]);
  });

  it('never duplicates a PR already listed in NEEDS YOU', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const body = buildStandDownComment({ reason: 'conflict' });
    // fixture() is a fully-ready PR by default; give it a stand-down comment too (e.g. stood down, then cleared
    // and re-armed by a human without deleting the old comment).
    list(fixture({ comments: [advisory(), { body, createdAt: 't' }] }));
    main(['--repo=o/n', '--json'], { unsupportedPath: NO_UNSUPPORTED });
    const report = JSON.parse(log.mock.calls[0][0]);
    expect(report.ready).toEqual([{ repo: 'o/n', number: 42, title: 'Ready for review' }]);
    expect(report.stoodDown).toEqual([]);
  });

  it('notes when a listed PR also still carries review:human, rather than hiding it', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const body = buildStandDownComment({ reason: 'lane-ref-gone' });
    // review:human alone, with no advisory/CI, is NOT ready — so it is not in NEEDS YOU and is free to also
    // appear here, flagged.
    list(fixture({ number: 7, labels: [HUMAN], comments: [{ body, createdAt: 't' }] }));
    main(['--repo=o/n', '--json'], { unsupportedPath: NO_UNSUPPORTED });
    const report = JSON.parse(log.mock.calls[0][0]);
    expect(report.stoodDown).toEqual([{
      repo: 'o/n', number: 7, title: 'Ready for review', standDownAt: 't',
      reason: 'the PR\'s lane ref no longer resolves, so the ~done work could not be reconstituted',
      alsoReviewHuman: true,
    }]);
    expect(report.notReady.some((pr) => pr.number === 7)).toBe(true);
  });

  it('renders the text section, empty state included, and with a reason and quoted marker present', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    list();
    main(['--repo=o/n'], { unsupportedPath: NO_UNSUPPORTED });
    const out = log.mock.calls.map(([line]) => line).join('\n');
    expect(out).toContain('STOOD DOWN — needs your judgment (a fix agent asked a question; no label changed):');
    expect(out.trim().endsWith('(none)')).toBe(true);
  });

  it('renders a real stood-down row as text, with reason and repo#number', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const body = buildStandDownComment({ reason: 'gate-red' });
    list(fixture({ number: 55, labels: [], comments: [{ body, createdAt: '2026-09-21T00:00:00Z' }] }));
    main(['--repo=o/n'], { unsupportedPath: NO_UNSUPPORTED });
    const out = log.mock.calls.map(([line]) => line).join('\n');
    expect(out).toContain('o/n#55  Ready for review');
    expect(out).toContain('stood down 2026-09-21T00:00:00Z');
    expect(out).toContain('gate stayed RED');
  });
});

// STUCK — INSPECTED — epic #3383's stuck-PR watch. Reuses the SAME durable marker the watch itself reads
// (`stuckDispatchEpisodes`) rather than re-deriving a second parse of it, mirroring the STOOD DOWN section above.
describe('stuckInspectedRow', () => {
  it('returns null for a PR with no dispatch-marker comment', () => {
    expect(stuckInspectedRow('o/n', fixture())).toBeNull();
  });

  it('extracts the episode count and most recent episode from a real marker comment', () => {
    const body = buildStuckDispatchComment({ stage: 'fix', minutesSince: 50, thresholdMinutes: 45, activityAt: '2026-09-20T10:00:00Z', sessionSlug: 'inspect-42' });
    const pr = fixture({ number: 42, labels: [], comments: [{ body, createdAt: '2026-09-20T10:05:00Z' }] });
    expect(stuckInspectedRow('o/n', pr)).toEqual({
      repo: 'o/n', number: 42, title: 'Ready for review', episodes: 1, lastEpisode: '2026-09-20T10:00:00Z',
    });
  });

  it('ignores a marker that is only quoted, not the leading line', () => {
    const pr = fixture({ labels: [], comments: [{ body: `> ${STUCK_DISPATCH_MARKER}\n\nepisode: 2026-09-20T10:00:00Z`, createdAt: 't' }] });
    expect(stuckInspectedRow('o/n', pr)).toBeNull();
  });
});

describe('main — STUCK section', () => {
  const list = (...prs) => vi.mocked(execFileSync).mockReset().mockReturnValueOnce(JSON.stringify(prs));

  it('lists an open PR carrying a stuck-watch dispatch marker, with its episode count', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const body = buildStuckDispatchComment({ stage: 'conflict', minutesSince: 390, thresholdMinutes: 45, activityAt: '2026-09-23T12:27:00Z', sessionSlug: 'inspect-2505' });
    list(fixture({ number: 2505, labels: [{ name: 'review:accepted' }], comments: [{ body, createdAt: 't' }] }));
    main(['--repo=o/n', '--json'], { unsupportedPath: NO_UNSUPPORTED });
    expect(JSON.parse(log.mock.calls[0][0]).stuck).toEqual([{
      repo: 'o/n', number: 2505, title: 'Ready for review', episodes: 1, lastEpisode: '2026-09-23T12:27:00Z',
    }]);
  });

  it('never duplicates a PR already listed in NEEDS YOU', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const body = buildStuckDispatchComment({ stage: 'review', minutesSince: 50, thresholdMinutes: 45, activityAt: 'T1', sessionSlug: 'inspect-42' });
    list(fixture({ comments: [advisory(), { body, createdAt: 't' }] })); // fixture() is fully ready by default
    main(['--repo=o/n', '--json'], { unsupportedPath: NO_UNSUPPORTED });
    const report = JSON.parse(log.mock.calls[0][0]);
    expect(report.ready).toEqual([{ repo: 'o/n', number: 42, title: 'Ready for review' }]);
    expect(report.stuck).toEqual([]);
  });

  it('renders the text section, empty state included', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    list();
    main(['--repo=o/n'], { unsupportedPath: NO_UNSUPPORTED });
    const out = log.mock.calls.map(([line]) => line).join('\n');
    expect(out).toContain('STUCK — inspected (epic #3383 dispatched a diagnosis-only agent; read its comment):');
    expect(out.trim().endsWith('(none)')).toBe(true);
  });
});
