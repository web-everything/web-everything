/**
 * @file scripts/conveyor/__tests__/reconcile-core-exhaustion-notes.test.mjs
 * @description xilx617 (epic #4075/#3383) — clears the 6 flow-checker gap findings (xwuof33/xb4yerj/xwo3j0l)
 * this card slices by file: `fix round-cap-hit` (silent-failure), `fix fixer-blocked-infra` (uncapped-retry),
 * `review round-cap-exhausted` (silent-failure + uncapped-retry), `review blocked-on-infra` (uncapped-retry),
 * `ci-heal ci-heal-session-running` (unbounded-wait).
 *
 * THREE NEW NOTE KINDS, each "refuse AND surface" (the SAME shape `awaiting-permission`/`ci-heal-exhausted`
 * already use — see `reconcile-core.mjs`'s own file header):
 *   1. `round-cap-exhausted` — every `cap-exhausted` refusal EXCEPT the ci-red one (which already had its own
 *      `ci-heal-exhausted` note) now ALSO pushes a note naming its population (`capKind`).
 *   2. `infra-retry-exhausted` — a durable per-SESSION `blocked-on-infra` STREAK, persisted by the completion
 *      STORE's own write path (`we:scripts/operations/completion-store.mjs#writeCompletion`), read back by
 *      `markSelfReportedDone`. At `INFRA_RETRY_CAP` the cool-off grows (`INFRA_RETRY_CAPPED_COOLOFF_MS`) and a
 *      note is pushed; below the cap the ordinary `INFRA_RETRY_COOLOFF_MS` still applies, silently.
 *   3. `session-overrun` — a `live-process` refusal (never `awaiting-permission`, which already notes) past
 *      `LIVE_SESSION_OVERRUN_MS` also gets a note. STILL REFUSES — this never kills or reaps a session.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import {
  resolveRoundCap, planReconcile, markSelfReportedDone, assessLiveness,
  INFRA_RETRY_CAP, INFRA_RETRY_COOLOFF_MS, INFRA_RETRY_CAPPED_COOLOFF_MS, LIVE_SESSION_OVERRUN_MS,
  CONFLICT_FIX_ROUND_CAP, ADVISORY_FIX_ROUND_CAP, CI_HEAL_ROUND_CAP,
} from '../reconcile-core.mjs';
import { buildRoundExtensionComment } from '../round-extension-mark.mjs';
import { OPERATOR_LOGINS } from '../../lib/marker-authorship.mjs';
import { noteEpisodeKey, buildNoteComment, hasPostedNoteComment } from '../reconcile-note-comment.mjs';
import { NEGOTIATION_ROUND_CAP } from '../../lib/jury-core.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
import { CONFLICT_FIX_COMMENT_MARKER } from '../conflict-fix-round-count.mjs';
import { buildAdvisoryFixComment } from '../advisory-fix-mark.mjs';
import { buildCiHealComment } from '../ci-heal-mark.mjs';
import { ADVISORY_LABELS } from '../../lib/advisory-labels.mjs';
import { newCompletionRecord, DENIED_MAX_LENGTH } from '../../operations/completion-record.mjs';
import { writeCompletion, tryReadCompletion } from '../../operations/completion-store.mjs';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const AUTOMATION = { login: 'web-everything' };
const lbl = (...names) => names.map((name) => ({ name }));
const greenRollup = [{ name: 'gate', status: 'completed', conclusion: 'success' }];
const finding = (text = 'a real reviewer finding') => ({ body: `🔁 human review — changes requested\n\n${text}` });

/** A minimal, bounced PR — the population the GENERIC round cap (REFUSAL 3) binds. */
const prBounced = (over = {}) => ({
  number: 3001,
  state: 'OPEN',
  headRefName: 'lane/xilx617-bounced',
  headRefOid: '3001'.repeat(10).slice(0, 40),
  labels: lbl('review:changes'),
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: greenRollup,
  comments: [finding()],
  ...over,
});

/** A `review:pending` PR with ZERO findings — the zero-findings review branch's own cap. */
const prZeroFindingsReview = (over = {}) => ({
  number: 3002,
  state: 'OPEN',
  headRefName: 'lane/xilx617-zero-findings',
  headRefOid: '3002'.repeat(10).slice(0, 40),
  labels: lbl('review:pending'),
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: greenRollup,
  comments: [],
  ...over,
});

/** A `needs-human` PR carrying an unaddressed `advisory:changes` finding — the advisory-fix cap. */
const prAdvisoryFix = (over = {}) => ({
  number: 3003,
  state: 'OPEN',
  headRefName: 'lane/xilx617-advisory-fix',
  headRefOid: '3003'.repeat(10).slice(0, 40),
  labels: lbl('review:human', ADVISORY_LABELS.CHANGES),
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: greenRollup,
  comments: [{ body: `${ADVISORY_NOTE_MARKER}\n\nSome admitted finding text.`, author: AUTOMATION }],
  ...over,
});

/** A `bounced` + `merge-status:conflicting` PR — the conflict-fix cap. */
const prConflictFix = (over = {}) => ({
  number: 3004,
  state: 'OPEN',
  headRefName: 'lane/xilx617-conflict-fix',
  headRefOid: '3004'.repeat(10).slice(0, 40),
  labels: lbl('review:changes', 'merge-status:conflicting'),
  mergeStateStatus: 'DIRTY',
  statusCheckRollup: greenRollup,
  comments: [finding()],
  ...over,
});

/** A `conflicted` PR stacked on another lane's base (not `main`) — the stacked-rebase cap. */
const prStackedRebase = (over = {}) => ({
  number: 3005,
  state: 'OPEN',
  headRefName: 'lane/xilx617-stacked',
  headRefOid: '3005'.repeat(10).slice(0, 40),
  labels: lbl('review:accepted', 'merge-status:conflicting'),
  mergeStateStatus: 'DIRTY',
  baseRefName: 'lane/some-other-lane',
  statusCheckRollup: greenRollup,
  comments: [],
  ...over,
});

describe('xilx617 — round-cap-exhausted notes, one per non-ci-heal `cap-exhausted` population', () => {
  it('the generic REFUSAL 3 (a bounced PR at the shared round cap) pushes a note with capKind "fix"', () => {
    const comments = [finding(), ...Array.from({ length: NEGOTIATION_ROUND_CAP }, () => ({ body: REARM_COMMENT_MARKER, author: AUTOMATION }))];
    const plan = planReconcile({ prs: [prBounced({ comments })], agents: [], now: NOW });
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', capKind: 'fix' })]);
    expect(plan.notes).toEqual([expect.objectContaining({
      kind: 'round-cap-exhausted', prNumber: 3001, capKind: 'fix', attempts: NEGOTIATION_ROUND_CAP, cap: NEGOTIATION_ROUND_CAP,
    })]);
    expect(plan.notes[0].text).toBe(`PR #3001: fix auto-repair rounds exhausted (${NEGOTIATION_ROUND_CAP}/${NEGOTIATION_ROUND_CAP}) — a person must take it over`);
  });

  it('the zero-findings review branch above the cap pushes a note with capKind "review"', () => {
    const plan = planReconcile({ prs: [prZeroFindingsReview()], agents: [], durableCounts: { 3002: NEGOTIATION_ROUND_CAP + 1 }, now: NOW });
    // This branch ALSO always pushes the ordinary `no-findings` refusal first (a review population with
    // nothing to fix is still refused as no-findings — see `reconcile-core.mjs`'s own REFUSAL 2 note); the
    // `cap-exhausted` one rides alongside it, never replacing it.
    expect(plan.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'cap-exhausted', capKind: 'review' })]));
    expect(plan.notes).toEqual([expect.objectContaining({ kind: 'round-cap-exhausted', prNumber: 3002, capKind: 'review' })]);
  });

  it('the advisory-fix branch pushes a note with capKind "advisory-fix"', () => {
    // Mirrors `reconcile-core.test.mjs`'s own pinned advisory-fix-cap fixture: ADVISORY_FIX_ROUND_CAP rounds,
    // each followed by ANOTHER advisory note that still found something wrong (so the fix count never "catches
    // up" to the note count — order, not count, is what `isLatestAdvisoryFindingAddressed` reads).
    const comments = [];
    for (let i = 0; i < ADVISORY_FIX_ROUND_CAP; i += 1) {
      comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\nround ${i}`, author: AUTOMATION });
      comments.push({ body: buildAdvisoryFixComment({}), author: AUTOMATION });
    }
    comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\none more, still broken`, author: AUTOMATION });
    const plan = planReconcile({ prs: [prAdvisoryFix({ comments })], agents: [], now: NOW });
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', capKind: 'advisory-fix' })]);
    expect(plan.notes).toEqual([expect.objectContaining({ kind: 'round-cap-exhausted', prNumber: 3003, capKind: 'advisory-fix' })]);
  });

  it('the conflict-fix bounce branch pushes a note with capKind "conflict-fix"', () => {
    const comments = [finding(), ...Array.from({ length: CONFLICT_FIX_ROUND_CAP }, () => ({ body: CONFLICT_FIX_COMMENT_MARKER, author: AUTOMATION }))];
    const plan = planReconcile({ prs: [prConflictFix({ comments })], agents: [], now: NOW });
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', capKind: 'conflict-fix' })]);
    expect(plan.notes).toEqual([expect.objectContaining({ kind: 'round-cap-exhausted', prNumber: 3004, capKind: 'conflict-fix' })]);
  });

  it('the STACKED-BASE conflict branch pushes a note with its OWN capKind "stacked-rebase", distinct from a plain conflict-fix bounce', () => {
    const comments = Array.from({ length: CONFLICT_FIX_ROUND_CAP }, () => ({ body: CONFLICT_FIX_COMMENT_MARKER, author: AUTOMATION }));
    const plan = planReconcile({ prs: [prStackedRebase({ comments })], agents: [], now: NOW });
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'cap-exhausted', capKind: 'stacked-rebase' })]);
    expect(plan.notes).toEqual([expect.objectContaining({ kind: 'round-cap-exhausted', prNumber: 3005, capKind: 'stacked-rebase' })]);
  });

  it('the ci-red branch is UNCHANGED — it still only pushes its own `ci-heal-exhausted` note, never a duplicate `round-cap-exhausted` one', () => {
    const prCiRed = {
      number: 3006, state: 'OPEN', headRefName: 'lane/xilx617-ci-red', headRefOid: 'a'.repeat(40),
      labels: lbl('checking'), mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'failure' }],
      comments: Array.from({ length: CI_HEAL_ROUND_CAP }, () => ({ body: buildCiHealComment({}), author: AUTOMATION })),
    };
    const plan = planReconcile({ prs: [prCiRed], agents: [], now: NOW });
    expect(plan.notes.map((n) => n.kind)).toEqual(['ci-heal-exhausted']);
  });

  it('the note text is STABLE across two ticks with identical inputs — no clock-derived number', () => {
    const comments = [finding(), ...Array.from({ length: NEGOTIATION_ROUND_CAP }, () => ({ body: REARM_COMMENT_MARKER, author: AUTOMATION }))];
    const tick1 = planReconcile({ prs: [prBounced({ comments })], agents: [], now: NOW });
    const tick2 = planReconcile({ prs: [prBounced({ comments })], agents: [], now: NOW + 60_000 });
    expect(tick1.notes[0].text).toBe(tick2.notes[0].text);
    expect(noteEpisodeKey(tick1.notes[0])).toBe(noteEpisodeKey(tick2.notes[0]));
  });
});

describe('xilx617 — the durable per-session blocked-on-infra STREAK, persisted by the completion store', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-op-completions-infra-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a FIRST blocked-on-infra done write starts the streak at 1, with `since` == its own updatedAt', () => {
    const rec = newCompletionRecord({ session: 'fix-9001', kind: 'fix', pr: 9001, now: () => '2026-09-26T10:00:00.000Z' });
    writeCompletion({ ...rec, status: 'done', outcome: 'blocked-on-infra', updatedAt: '2026-09-26T10:05:00.000Z' }, dir);
    const stored = tryReadCompletion('fix-9001', dir);
    expect(stored.infraStreak).toBe(1);
    expect(stored.infraStreakSince).toBe('2026-09-26T10:05:00.000Z');
  });

  it('a SECOND consecutive blocked-on-infra done write increments the streak and keeps the FIRST `since`', () => {
    const started = () => newCompletionRecord({ session: 'fix-9002', kind: 'fix', pr: 9002, now: () => '2026-09-26T10:00:00.000Z' });
    writeCompletion({ ...started(), status: 'done', outcome: 'blocked-on-infra', updatedAt: '2026-09-26T10:05:00.000Z' }, dir);
    // A fresh dispatch generation reuses the session name and mints a BRAND NEW record (mirrors
    // `completion-cli.mjs#runReport`'s own `started` path) — the store's write path must carry the streak
    // through this, or it is lost before the NEXT `done` write ever sees it.
    writeCompletion(started(), dir);
    const midway = tryReadCompletion('fix-9002', dir);
    expect(midway.infraStreak).toBe(1); // carried through the `started` write, unchanged
    expect(midway.infraStreakSince).toBe('2026-09-26T10:05:00.000Z');

    writeCompletion({ ...midway, status: 'done', outcome: 'blocked-on-infra', updatedAt: '2026-09-26T11:05:00.000Z' }, dir);
    const stored = tryReadCompletion('fix-9002', dir);
    expect(stored.infraStreak).toBe(2);
    expect(stored.infraStreakSince).toBe('2026-09-26T10:05:00.000Z'); // still the FIRST timestamp
  });

  it('ANY OTHER outcome drops the streak entirely', () => {
    const started = () => newCompletionRecord({ session: 'fix-9003', kind: 'fix', pr: 9003, now: () => '2026-09-26T10:00:00.000Z' });
    writeCompletion({ ...started(), status: 'done', outcome: 'blocked-on-infra', updatedAt: '2026-09-26T10:05:00.000Z' }, dir);
    writeCompletion(started(), dir); // fresh generation, carries the streak forward
    const midway = tryReadCompletion('fix-9003', dir);
    writeCompletion({ ...midway, status: 'done', outcome: 'accepted', updatedAt: '2026-09-26T11:05:00.000Z' }, dir);
    const stored = tryReadCompletion('fix-9003', dir);
    expect(stored.infraStreak).toBeUndefined();
    expect(stored.infraStreakSince).toBeUndefined();
  });

  it('markSelfReportedDone: BELOW the cap, the ordinary 15-minute cool-off still applies', () => {
    const listed = { name: 'fix-9004', state: 'blocked', startedAt: Date.parse('2026-09-26T09:00:00Z') };
    const rec = {
      status: 'done', outcome: 'blocked-on-infra', updatedAt: '2026-09-26T09:05:00Z',
      infraStreak: INFRA_RETRY_CAP - 1, infraStreakSince: '2026-09-26T08:00:00Z',
    };
    const recFor = () => rec;
    const insideCooloff = Date.parse('2026-09-26T09:05:00Z') + INFRA_RETRY_COOLOFF_MS - 1000;
    const [inside] = markSelfReportedDone([listed], recFor, insideCooloff);
    expect(inside.awaitingInfraCooloff).toBe(true);
    expect(inside.infraStreakCapped).toBe(false);

    const pastOrdinaryCooloff = Date.parse('2026-09-26T09:05:00Z') + INFRA_RETRY_COOLOFF_MS + 1000;
    const [after] = markSelfReportedDone([listed], recFor, pastOrdinaryCooloff);
    expect(after.selfReportedDone).toBe(true);
    expect(after.infraStreakCapped).toBe(false);
  });

  it('markSelfReportedDone: AT the cap, the cool-off grows to 60 minutes and the row is flagged `infraStreakCapped`', () => {
    const listed = { name: 'fix-9005', state: 'blocked', startedAt: Date.parse('2026-09-26T09:00:00Z') };
    const rec = {
      status: 'done', outcome: 'blocked-on-infra', updatedAt: '2026-09-26T09:05:00Z',
      infraStreak: INFRA_RETRY_CAP, infraStreakSince: '2026-09-26T05:00:00Z',
    };
    const recFor = () => rec;
    // Past the ORDINARY 15-minute cool-off, but still inside the CAPPED 60-minute one.
    const pastOrdinaryStillInsideCapped = Date.parse('2026-09-26T09:05:00Z') + INFRA_RETRY_COOLOFF_MS + 1000;
    const [stillWaiting] = markSelfReportedDone([listed], recFor, pastOrdinaryStillInsideCapped);
    expect(stillWaiting.awaitingInfraCooloff).toBe(true);
    expect(stillWaiting.infraStreakCapped).toBe(true);

    const pastCappedCooloff = Date.parse('2026-09-26T09:05:00Z') + INFRA_RETRY_CAPPED_COOLOFF_MS + 1000;
    const [after] = markSelfReportedDone([listed], recFor, pastCappedCooloff);
    expect(after.selfReportedDone).toBe(true); // the retry continues — never stopped outright
    expect(after.infraStreakCapped).toBe(true);
    expect(after.infraStreakSince).toBe('2026-09-26T05:00:00Z');
  });

  it('end to end: planReconcile pushes an `infra-retry-exhausted` note for the PR the capped session is bound to, and keeps refusing (never dispatches)', () => {
    const pr = prBounced({ number: 9006, headRefOid: 'b'.repeat(40) });
    const listed = { name: 'fix-9006', state: 'blocked', startedAt: Date.parse('2026-09-26T09:00:00Z'), laneHeadOid: pr.headRefOid };
    const rec = {
      status: 'done', outcome: 'blocked-on-infra', updatedAt: '2026-09-26T09:05:00Z',
      infraStreak: INFRA_RETRY_CAP, infraStreakSince: '2026-09-26T05:00:00Z',
    };
    const nowMs = Date.parse('2026-09-26T09:05:00Z') + INFRA_RETRY_COOLOFF_MS + 1000; // past ordinary, inside capped
    const agents = markSelfReportedDone([listed], () => rec, nowMs);
    const plan = planReconcile({ prs: [pr], agents, now: nowMs });
    expect(plan.dispatch).toHaveLength(0); // still inside the (longer) cool-off — not yet redispatched
    expect(plan.notes).toEqual([expect.objectContaining({
      kind: 'infra-retry-exhausted', prNumber: 9006, streak: INFRA_RETRY_CAP, cap: INFRA_RETRY_CAP, since: '2026-09-26T05:00:00Z',
    })]);
  });

  it('noteEpisodeKey for `infra-retry-exhausted` is stable across two ticks (keyed on prNumber + since, never the growing streak)', () => {
    const note1 = { kind: 'infra-retry-exhausted', prNumber: 9006, streak: INFRA_RETRY_CAP, cap: INFRA_RETRY_CAP, since: '2026-09-26T05:00:00Z' };
    const note2 = { ...note1, streak: INFRA_RETRY_CAP + 3 }; // streak kept growing; same episode
    expect(noteEpisodeKey(note1)).toBe(noteEpisodeKey(note2));
  });
});

it('holds a permission denial for 60 minutes and surfaces its command immediately', () => {
  const pr = prBounced({ number: 3964, headRefOid: 'b'.repeat(40) });
  const listed = { name: 'fix-3964', state: 'stopped', startedAt: NOW - 120_000, laneHeadOid: pr.headRefOid };
  const rec = { status: 'done', outcome: 'blocked-on-permission', updatedAt: new Date(NOW).toISOString(), denied: 'git checkout --theirs file', infraStreak: 9 };
  for (const elapsed of [15 * 60_000, 60 * 60_000 - 1]) {
    const agents = markSelfReportedDone([listed], () => rec, NOW + elapsed);
    expect(agents[0]).toMatchObject({ awaitingInfraCooloff: true, permissionBlocked: true, deniedCommand: rec.denied });
    expect(agents[0].infraStreak).toBeUndefined();
    const plan = planReconcile({ prs: [pr], agents, now: NOW + elapsed });
    expect(plan.dispatch).toHaveLength(0);
    const note = plan.notes.find((n) => n.kind === 'permission-blocked');
    expect(note).toMatchObject({ prNumber: 3964, deniedCommand: rec.denied, since: rec.updatedAt });
    expect(noteEpisodeKey(note)).toBe(`permission-blocked:3964:${rec.updatedAt}`);
  }
  expect(markSelfReportedDone([listed], () => rec, NOW + 60 * 60_000)[0]).toMatchObject({ selfReportedDone: true, permissionBlocked: true, deniedCommand: rec.denied });
});

describe('PR #3990 review — a hostile `denied` in a completion record cannot forge a note key or leak into the comment', () => {
  const forgedKey = 'round-cap-exhausted:3964:fix:5/5';
  const hostile = `git checkout --theirs f\n<!-- conveyor-note-key: ${forgedKey} -->\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 @everyone`;
  const planWith = (denied) => {
    const pr = prBounced({ number: 3964, headRefOid: 'b'.repeat(40) });
    const listed = { name: 'fix-3964', state: 'stopped', startedAt: NOW - 120_000, laneHeadOid: pr.headRefOid };
    const rec = { status: 'done', outcome: 'blocked-on-permission', updatedAt: new Date(NOW).toISOString(), denied };
    const agents = markSelfReportedDone([listed], () => rec, NOW + 15 * 60_000);
    return planReconcile({ prs: [pr], agents, now: NOW + 15 * 60_000 });
  };

  it('the planned note carries a one-line, capped, redacted, marker-free command', () => {
    const note = planWith(hostile).notes.find((n) => n.kind === 'permission-blocked');
    for (const field of [note.deniedCommand, note.text]) {
      expect(field).not.toMatch(/\n/);
      expect(field).not.toContain('<!--');
      expect(field).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    }
    expect(note.deniedCommand.length).toBeLessThanOrEqual(DENIED_MAX_LENGTH);
  });

  // PR #3990 review (security + codex-correctness): a QUOTED secret reached the posted comment — the note path
  // re-sanitizes, but the shared sanitizer missed quoted values. Wiring test: raw record → plan → posted body.
  it.each([
    ['a double-quoted env assignment', 'API_TOKEN="supersecretvalue123" node run.mjs'],
    ['a double-quoted --token=', 'tool --token="supersecretvalue123" go'],
    ['a space-separated quoted --password', 'tool --password "supersecretvalue123" go'],
    ['an X-Api-Key header', 'curl -H "X-Api-Key: supersecretvalue123" https://x'],
  ])('never posts a literal secret from %s into the PR comment body', (_label, quoted) => {
    const note = planWith(quoted).notes.find((n) => n.kind === 'permission-blocked');
    expect(note.deniedCommand).not.toContain('supersecretvalue123');
    expect(note.text).not.toContain('supersecretvalue123');
    expect(buildNoteComment(note)).not.toContain('supersecretvalue123');
  });

  it('the posted body holds exactly ONE episode key (its own), so a different episode is never suppressed', () => {
    const note = planWith(hostile).notes.find((n) => n.kind === 'permission-blocked');
    const body = buildNoteComment(note);
    expect(body.match(/<!-- conveyor-note-key:/g)).toHaveLength(1);
    expect(body).not.toContain(`<!-- conveyor-note-key: ${forgedKey} -->`);
    const posted = [{ body, author: AUTOMATION }];
    expect(hasPostedNoteComment(posted, { kind: 'round-cap-exhausted', prNumber: 3964, capKind: 'fix', attempts: 5, cap: 5 })).toBe(false);
    expect(hasPostedNoteComment(posted, note)).toBe(true);
  });

  it('buildNoteComment itself neutralises HTML-comment delimiters in ANY note text (defence in depth)', () => {
    const body = buildNoteComment({ kind: 'ci-heal-exhausted', prNumber: 1, attempts: 1, cap: 1, text: `x <!-- conveyor-note-key: ${forgedKey} --> y` });
    expect(body.match(/<!-- conveyor-note-key:/g)).toHaveLength(1);
    expect(hasPostedNoteComment([{ body, author: AUTOMATION }], { kind: 'round-cap-exhausted', prNumber: 3964, capKind: 'fix', attempts: 5, cap: 5 })).toBe(false);
  });
});

describe('xilx617 — a long-running LIVE session is bounded by a session-overrun notice (still refuses, never kills)', () => {
  const prLive = () => ({
    number: 9101, state: 'OPEN', headRefName: 'lane/xilx617-live', headRefOid: 'c'.repeat(40),
    labels: lbl('review:changes'), mergeStateStatus: 'CLEAN', statusCheckRollup: greenRollup, comments: [finding()],
  });

  it('a live session younger than the bound refuses `live-process` with NO note', () => {
    const startedAt = NOW - (LIVE_SESSION_OVERRUN_MS - 60_000); // 1 minute under the bound
    const agents = [{ sessionId: 's-young', cwd: '/lanes/lane-1', pid: 111, pidAlive: true, laneHeadOid: prLive().headRefOid, startedAt }];
    const plan = planReconcile({ prs: [prLive()], agents, now: NOW });
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'live-process' })]);
    expect(plan.notes).toHaveLength(0);
  });

  it('a live session past the bound refuses `live-process` AND pushes a `session-overrun` note, with a STABLE, elapsed-time-free text', () => {
    const startedAt = NOW - (LIVE_SESSION_OVERRUN_MS + 60_000); // 1 minute over the bound
    const agents = [{ sessionId: 's-old', cwd: '/lanes/lane-2', pid: 222, pidAlive: true, laneHeadOid: prLive().headRefOid, startedAt }];
    const plan = planReconcile({ prs: [prLive()], agents, now: NOW });
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'live-process' })]); // STILL refuses — never killed
    expect(plan.dispatch).toHaveLength(0);
    expect(plan.notes).toEqual([expect.objectContaining({
      kind: 'session-overrun', prNumber: 9101, sessionId: 's-old', pid: 222,
    })]);
    const boundMin = Math.round(LIVE_SESSION_OVERRUN_MS / 60_000);
    expect(plan.notes[0].text).toBe(`PR #9101: a session (s-old) has been live past the ${boundMin}-minute bound — still refusing to dispatch a second agent, but a person should check whether it is stuck`);

    // Run it again an hour later — same session, same startedAt: the text (no elapsed time) is IDENTICAL.
    const laterTick = planReconcile({ prs: [prLive()], agents, now: NOW + 3_600_000 });
    expect(laterTick.notes[0].text).toBe(plan.notes[0].text);
  });

  it('never fires for `awaiting-permission` — that liveness kind already gets its own note', () => {
    const startedAt = NOW - (LIVE_SESSION_OVERRUN_MS + 60_000);
    const agents = [{
      sessionId: 's-perm', cwd: '/lanes/lane-3', pid: 333, pidAlive: true, laneHeadOid: prLive().headRefOid,
      status: 'waiting', waitingFor: 'permission prompt', startedAt,
    }];
    const plan = planReconcile({ prs: [prLive()], agents, now: NOW });
    expect(plan.refusals).toEqual([expect.objectContaining({ kind: 'awaiting-permission' })]);
    expect(plan.notes.map((n) => n.kind)).toEqual(['awaiting-permission']); // never ALSO session-overrun
  });

  it('a caller-supplied `liveSessionOverrunMs` overrides the default bound', () => {
    const startedAt = NOW - 10 * 60_000; // 10 minutes ago
    const agents = [{ sessionId: 's-short', cwd: '/lanes/lane-4', pid: 444, pidAlive: true, laneHeadOid: prLive().headRefOid, startedAt }];
    const plan = planReconcile({ prs: [prLive()], agents, now: NOW, liveSessionOverrunMs: 5 * 60_000 });
    expect(plan.notes).toEqual([expect.objectContaining({ kind: 'session-overrun', prNumber: 9101 })]);
  });

  it('noteEpisodeKey for `session-overrun` is keyed on sessionId (falling back to pid), stable across two ticks', () => {
    const note1 = { kind: 'session-overrun', prNumber: 9101, sessionId: 's-old', pid: 222, boundMin: 90 };
    const note2 = { ...note1 };
    expect(noteEpisodeKey(note1)).toBe(noteEpisodeKey(note2));
    const notePidOnly1 = { kind: 'session-overrun', prNumber: 9101, sessionId: undefined, pid: 555 };
    const notePidOnly2 = { ...notePidOnly1 };
    expect(noteEpisodeKey(notePidOnly1)).toBe(noteEpisodeKey(notePidOnly2));
    expect(noteEpisodeKey(notePidOnly1)).not.toBe(noteEpisodeKey(note1));
  });
});

describe('last allowed fix review and round configuration', () => {
  it.each([[[]], [[finding()]]])('allows the final review, with or without findings', (comments) => {
    const plan = planReconcile({ prs: [prZeroFindingsReview({ comments })], durableCounts: { 3002: 5 }, requiredChecks: ['gate'] });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'review', finalReview: true })]);
    expect(plan.notes).toHaveLength(0);
  });
  it('refuses review above the cap', () => {
    const plan = planReconcile({ prs: [prZeroFindingsReview({ comments: [finding()] })], durableCounts: { 3002: 6 } });
    expect(plan.refusals).toContainEqual(expect.objectContaining({ kind: 'cap-exhausted' }));
    expect(plan.notes).toContainEqual(expect.objectContaining({ capKind: 'review' }));
  });
  it('parks an exhausted fixer', () => {
    const plan = planReconcile({ prs: [prBounced()], durableCounts: { 3001: 5 } });
    expect(plan.notes).toContainEqual(expect.objectContaining({ capKind: 'fix', parkToHuman: true }));
  });
  it('resolves a positive integer config, otherwise the default', () => {
    for (const value of [undefined, '', ' ', '0', '-1', '2.5', 'no', 'Infinity', '9007199254740992']) {
      expect(resolveRoundCap({ WE_REVIEW_ROUND_CAP: value })).toBe(5);
    }
    expect(resolveRoundCap({ WE_REVIEW_ROUND_CAP: '7' })).toBe(7);
  });
});


describe('only the generic fix exhaustion parks to review:human', () => {
  const exhausted = {
    fix: () => planReconcile({ prs: [prBounced()], durableCounts: { 3001: NEGOTIATION_ROUND_CAP } }),
    review: () => planReconcile({ prs: [prZeroFindingsReview({ comments: [finding()] })], durableCounts: { 3002: NEGOTIATION_ROUND_CAP + 1 } }),
    'advisory-fix': () => {
      const comments = [];
      for (let i = 0; i < ADVISORY_FIX_ROUND_CAP; i += 1) {
        comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\nround ${i}`, author: AUTOMATION });
        comments.push({ body: buildAdvisoryFixComment({}), author: AUTOMATION });
      }
      comments.push({ body: `${ADVISORY_NOTE_MARKER}\n\none more, still broken`, author: AUTOMATION });
      return planReconcile({ prs: [prAdvisoryFix({ comments })] });
    },
    'conflict-fix': () => planReconcile({ prs: [prConflictFix({
      comments: [finding(), ...Array.from({ length: CONFLICT_FIX_ROUND_CAP }, () => ({ body: CONFLICT_FIX_COMMENT_MARKER, author: AUTOMATION }))],
    })] }),
    'stacked-rebase': () => planReconcile({ prs: [prStackedRebase({
      comments: Array.from({ length: CONFLICT_FIX_ROUND_CAP }, () => ({ body: CONFLICT_FIX_COMMENT_MARKER, author: AUTOMATION })),
    })] }),
  };
  it.each(Object.keys(exhausted))('capKind %s carries parkToHuman only when it is "fix"', (capKind) => {
    const notes = exhausted[capKind]().notes.filter((n) => n.kind === 'round-cap-exhausted');
    expect(notes).toEqual([expect.objectContaining({ capKind })]);
    if (capKind === 'fix') expect(notes[0].parkToHuman).toBe(true);
    else expect(notes[0]).not.toHaveProperty('parkToHuman');
  });
});

describe('audited extension lifts the generic fixer cap', () => {
  it.each([
    [OPERATOR_LOGINS[0], OPERATOR_LOGINS[0], true],
    ['web-everything', OPERATOR_LOGINS[0], false], // automation credential claiming an operator actor
    ['outsider', OPERATOR_LOGINS[0], false],
    [OPERATOR_LOGINS[0], 'outsider', false],
  ])('author %s, actor %s', (author, actor, allowed) => {
    const body = buildRoundExtensionComment({ repo: 'web-everything/web-everything', pr: 3001, by: 2,
      actor, channel: 'console', reason: 'Try two more rounds', at: '2026-10-05T12:00:00Z' });
    const pr = prBounced({ comments: [finding(), { body, author: { login: author } }] });
    const plan = planReconcile({ prs: [pr], durableCounts: { 3001: 5 } });
    if (allowed) {
      expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'fix', roundExtensions: 2 })]);
      expect(plan.notes).toHaveLength(0);
    } else {
      expect(plan.dispatch).toHaveLength(0);
      expect(plan.notes).toContainEqual(expect.objectContaining({ capKind: 'fix', parkToHuman: true }));
    }
  });
});
