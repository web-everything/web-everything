/**
 * @file skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon-notes.test.mjs
 * @description #4191 (epic #4075/#3383) — proof of the FIFTH half this daemon now owns: surfacing
 *   `reconcile-core.mjs#planReconcile`'s own `notes` (`ci-heal-exhausted`/`awaiting-permission`), which
 *   previously reached nowhere downstream (not `ci-heal-pr-dispatch.mjs`, not this daemon). Mirrors this file's
 *   own sibling suites (`runHungCiRecoveryAllRepos`, `runMainRedRebaseAllRepos`) — per-repo isolation via
 *   injected `tick`, then a `runTickAllRepos` merge proof, then a source-contract proof.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  defaultNoteCommentDryRun, runReconcileNotesAllRepos, runTickAllRepos,
  formatNoteLine, formatNoteCommentLine, FIX_DISPATCH_DAEMON_REPOS,
} from '../reconcile-fix-dispatch-daemon.mjs';

const noopFixTick = () => ({ dispatched: [], refusals: [] });
const noopCiHealTick = async () => ({ dispatched: [], refusals: [] });
const noopHungCiTick = () => ({ dispatch: [], refusals: [], applied: [] });
const noopMainRedRebaseTick = () => ({ dispatch: [], refusals: [], applied: [] });
const noopMissingRunTick = () => ({ dispatch: [], refusals: [], applied: [] }); // xi4od2p (#4075/#3383) — sixth half

describe('defaultNoteCommentDryRun — posts by default', () => {
  it('posts with no env override', () => {
    expect(defaultNoteCommentDryRun({})).toBe(false);
  });
  it('explicit enable also posts', () => {
    expect(defaultNoteCommentDryRun({ WE_CONVEYOR_POST_NOTE_COMMENTS: '1' })).toBe(false);
  });
  it('only an explicit zero disables posting', () => {
    expect(defaultNoteCommentDryRun({ WE_CONVEYOR_POST_NOTE_COMMENTS: 'true' })).toBe(false);
    expect(defaultNoteCommentDryRun({ WE_CONVEYOR_POST_NOTE_COMMENTS: '0' })).toBe(true);
  });
});

describe('runReconcileNotesAllRepos — one defaultReadNotesForRepo call per watched repo (#4191)', () => {
  it('calls tick once per repo and repo-tags every note', () => {
    const tick = vi.fn(({ repo }) => ({
      notes: repo === 'repo-a' ? [{ kind: 'ci-heal-exhausted', prNumber: 10, attempts: 3, cap: 3, text: 'exhausted' }] : [],
      prsByNumber: new Map(),
    }));
    const out = runReconcileNotesAllRepos({ repos: ['repo-a', 'repo-b'], tick, dryRun: true });
    expect(tick).toHaveBeenCalledTimes(2);
    expect(out.notes).toEqual([
      { kind: 'ci-heal-exhausted', prNumber: 10, attempts: 3, cap: 3, text: 'exhausted', repo: 'repo-a' },
    ]);
  });

  it('dry-run: plans (never posts) a comment for a note with no prior trusted comment, and returns its body', () => {
    const tick = () => ({
      notes: [{ kind: 'ci-heal-exhausted', prNumber: 10, attempts: 3, cap: 3, text: 'exhausted' }],
      prsByNumber: new Map([[10, { number: 10, comments: [] }]]),
    });
    const postComment = vi.fn(() => ({ ok: true }));
    const out = runReconcileNotesAllRepos({ repos: ['repo-a'], tick, postComment, dryRun: true });
    expect(postComment).not.toHaveBeenCalled();
    expect(out.comments).toEqual([{
      repo: 'repo-a', prNumber: 10, kind: 'ci-heal-exhausted', key: expect.any(String), body: expect.stringContaining('needs your decision'),
      alreadyPosted: false, posted: false, dryRun: true,
    }]);
  });

  it('skips (never re-posts) an episode a trusted principal already commented — dedup, no body returned', () => {
    const key = 'ci-heal-exhausted:10:3/3';
    const tick = () => ({
      notes: [{ kind: 'ci-heal-exhausted', prNumber: 10, attempts: 3, cap: 3, text: 'exhausted' }],
      prsByNumber: new Map([[10, {
        number: 10,
        comments: [{ body: `🔔 conveyor — needs your decision\n\n<!-- conveyor-note-key: ${key} -->`, author: { login: 'web-everything' } }],
      }]]),
    });
    const postComment = vi.fn();
    const out = runReconcileNotesAllRepos({ repos: ['repo-a'], tick, postComment, dryRun: false });
    expect(postComment).not.toHaveBeenCalled();
    expect(out.comments).toEqual([{
      repo: 'repo-a', prNumber: 10, kind: 'ci-heal-exhausted', key, alreadyPosted: true, posted: false, dryRun: false,
    }]);
  });

  it('default: actually posts a round-cap-exhausted note and records success', () => {
    const tick = () => ({
      notes: [{ kind: 'round-cap-exhausted', prNumber: 20, attempts: 5, cap: 5, capKind: 'fix', text: 'exhausted' }],
      prsByNumber: new Map([[20, { number: 20, comments: [] }]]),
    });
    const postComment = vi.fn(() => ({ ok: true }));
    const out = runReconcileNotesAllRepos({ repos: ['repo-a'], tick, postComment });
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(postComment.mock.calls[0][0]).toMatchObject({ repo: 'repo-a', pr: 20 });
    expect(out.comments[0]).toMatchObject({ posted: true, dryRun: false, alreadyPosted: false });
  });

  it('records a FAILED post with its error, never throws', () => {
    const tick = () => ({
      notes: [{ kind: 'awaiting-permission', prNumber: 20, sessionId: 'sess-1', text: 'blocked' }],
      prsByNumber: new Map([[20, { number: 20, comments: [] }]]),
    });
    const postComment = vi.fn(() => ({ ok: false, error: 'gh: rate limited' }));
    const out = runReconcileNotesAllRepos({ repos: ['repo-a'], tick, postComment, dryRun: false });
    expect(out.comments[0]).toMatchObject({ posted: false, error: 'gh: rate limited' });
  });

  it('one repo\'s read failure never blocks another repo\'s — reported as tick-failed', () => {
    const tick = ({ repo }) => {
      if (repo === 'repo-bad') throw new Error('gh outage');
      return { notes: [], prsByNumber: new Map() };
    };
    const out = runReconcileNotesAllRepos({ repos: ['repo-bad', 'repo-good'], tick, dryRun: true });
    expect(out.refusals).toEqual([{ repo: 'repo-bad', prNumber: null, kind: 'tick-failed', why: 'gh outage' }]);
  });

  it('defaults repos to FIX_DISPATCH_DAEMON_REPOS — every watched repo', () => {
    const tick = vi.fn(() => ({ notes: [], prsByNumber: new Map() }));
    runReconcileNotesAllRepos({ tick, dryRun: true });
    expect(tick).toHaveBeenCalledTimes(FIX_DISPATCH_DAEMON_REPOS.length);
  });
});

describe('runTickAllRepos — now runs FIVE halves, notes included (#4191)', () => {
  it('merges notes/noteComments into the tick result, always dry-run in this test (explicit notesDryRun)', async () => {
    const notesTick = () => ({
      notes: [{ kind: 'ci-heal-exhausted', prNumber: 10, attempts: 3, cap: 3, text: 'exhausted' }],
      prsByNumber: new Map([[10, { number: 10, comments: [] }]]),
    });
    const out = await runTickAllRepos({
      repos: ['repo-a'], fixTick: noopFixTick, ciHealTick: noopCiHealTick, hungCiTick: noopHungCiTick,
      mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick, notesDryRun: true,
    });
    expect(out.notes).toEqual([{ kind: 'ci-heal-exhausted', prNumber: 10, attempts: 3, cap: 3, text: 'exhausted', repo: 'repo-a' }]);
    expect(out.noteComments).toEqual([expect.objectContaining({ repo: 'repo-a', prNumber: 10, dryRun: true })]);
  });

  it('a notes-side failure for one repo does not skip that SAME repo\'s other halves', async () => {
    const notesTick = ({ repo }) => { if (repo === 'repo-a') throw new Error('notes broke'); return { notes: [], prsByNumber: new Map() }; };
    const out = await runTickAllRepos({
      repos: ['repo-a'], fixTick: noopFixTick, ciHealTick: noopCiHealTick, hungCiTick: noopHungCiTick,
      mainRedRebaseTick: noopMainRedRebaseTick, missingRunTick: noopMissingRunTick, notesTick, notesDryRun: true,
    });
    expect(out.refusals).toEqual(expect.arrayContaining([{ repo: 'repo-a', prNumber: null, kind: 'tick-failed', why: 'notes broke' }]));
  });
});

describe('formatNoteLine — one printable line per surfaced note (#4191)', () => {
  it('includes the kind, repo, PR, and reason', () => {
    const line = formatNoteLine({ kind: 'ci-heal-exhausted', repo: 'web-everything/web-everything', prNumber: 2636, text: 'ci-heal attempts exhausted (3/3)' });
    expect(line).toContain('note ci-heal-exhausted');
    expect(line).toContain('PR #2636');
    expect(line).toContain('ci-heal attempts exhausted (3/3)');
  });
});

describe('formatNoteCommentLine — one printable line per note-comment decision (#4191)', () => {
  it('already-posted', () => {
    expect(formatNoteCommentLine({ kind: 'ci-heal-exhausted', repo: 'we', prNumber: 1, key: 'k', alreadyPosted: true })).toContain('already posted');
  });
  it('dry-run prints the FULL comment body — the "show the comment text it WOULD post" requirement', () => {
    const line = formatNoteCommentLine({
      kind: 'ci-heal-exhausted', repo: 'we', prNumber: 1, key: 'k', dryRun: true, body: 'needs your decision: fix attempts exhausted\n\nLast failure: build',
    });
    expect(line).toContain('DRY-RUN, would post');
    expect(line).toContain('needs your decision: fix attempts exhausted');
    expect(line).toContain('Last failure: build');
  });
  it('posted', () => {
    expect(formatNoteCommentLine({ kind: 'x', repo: 'we', prNumber: 1, key: 'k', posted: true })).toContain('— posted');
  });
  it('failed, with its error', () => {
    const line = formatNoteCommentLine({ kind: 'x', repo: 'we', prNumber: 1, key: 'k', posted: false, error: 'gh: rate limited' });
    expect(line).toContain('FAILED to post');
    expect(line).toContain('gh: rate limited');
  });
});

// SOURCE-CONTRACT proof, mirroring the hung-ci-recovery / main-red-rebase suites above.
describe('runTickAllRepos — source contract: really calls runReconcileNotesAllRepos, logs notes + note-comments (#4191)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'reconcile-fix-dispatch-daemon.mjs'), 'utf8');

  it('runTickAllRepos itself calls runReconcileNotesAllRepos', () => {
    const start = src.indexOf('export async function runTickAllRepos(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/runReconcileNotesAllRepos\(/);
  });

  it('onTick logs one line per note via formatNoteLine, and one per note-comment decision via formatNoteCommentLine', () => {
    expect(src).toMatch(/for \(const n of notes\) log\.error\(formatNoteLine\(n\)\);/);
    expect(src).toMatch(/for \(const c of noteComments\) log\.error\(formatNoteCommentLine\(c\)\);/);
  });
});
