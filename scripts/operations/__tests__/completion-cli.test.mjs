/**
 * @file completion-cli.test.mjs — the completion CLI's report/show core (#3436).
 *
 * THE LOAD-BEARING TEST IN HERE is "a crashed agent still leaves a completion record" — `we:backlog/3436-*.md`
 * done-when #3 requires exactly this: the record must not depend on the dispatched agent reaching its own
 * happy-path exit. It is proven here by calling ONLY the `started` report (as the brief's very first action
 * would) and then simulating the rest of the dispatch throwing, with NO `done` report ever made — the record
 * must still be on disk and readable.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { planDoneOwnership, planDoneReport, runReport, runShow, sessionSlugForCompletion } from '../completion-cli.mjs';
import { tryReadCompletion } from '../completion-store.mjs';

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'completion-cli.mjs');

let dir;
let previousDir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'we-op-completion-cli-'));
  previousDir = process.env.OPERATION_COMPLETIONS_DIR;
  process.env.OPERATION_COMPLETIONS_DIR = dir;
});
afterEach(() => {
  if (previousDir === undefined) delete process.env.OPERATION_COMPLETIONS_DIR;
  else process.env.OPERATION_COMPLETIONS_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('sessionSlugForCompletion', () => {
  it('mints the same review-<pr> / fix-<pr> / ci-heal-<pr> grammar the dispatchers already use', () => {
    expect(sessionSlugForCompletion({ kind: 'review', pr: 701 })).toBe('review-701');
    expect(sessionSlugForCompletion({ kind: 'fix', pr: '9' })).toBe('fix-9');
    // #4075/xg7m2wq — live incident PR #2724, 2026-09-26: a ci-heal session had no way to mint its own
    // completion-record slug via kind+pr, only ever via an explicit --session=.
    expect(sessionSlugForCompletion({ kind: 'ci-heal', pr: 2724 })).toBe('ci-heal-2724');
  });

  it('refuses an unknown kind or a missing pr', () => {
    expect(() => sessionSlugForCompletion({ kind: 'build', pr: 1 })).toThrow(/--kind must be review, fix, or ci-heal/);
    expect(() => sessionSlugForCompletion({ kind: 'review', pr: null })).toThrow(/--pr is required/);
  });
});

describe('report --status=started', () => {
  it('mints a fresh started record, readable back through show', () => {
    const { changed, record } = runReport({ kind: 'review', pr: '701', status: 'started' });
    expect(changed).toBe(true);
    expect(record.status).toBe('started');
    expect(runShow({ kind: 'review', pr: '701' })).toEqual({ found: true, ...record });
  });

  it('is idempotent — a retried `started` report never clobbers the first one', () => {
    const first = runReport({ session: 'fix-5', kind: 'fix', status: 'started' }).record;
    const second = runReport({ session: 'fix-5', kind: 'fix', status: 'started' });
    expect(second.changed).toBe(false);
    expect(second.record).toEqual(first);
  });

  // Review finding (#3436): a session slug (`fix-<pr>`) is reused across dispatch GENERATIONS on the same
  // PR — a fixer re-dispatched after a LATER bounce, on the same slug. `started` must start a FRESH record
  // once the prior generation is `done`, or a crash in the new generation reads back as the OLD generation's
  // stale outcome instead of "in flight" / "never finished this round".
  it('starts a FRESH record for a new dispatch generation, once the prior one is done', () => {
    runReport({ session: 'fix-5', kind: 'fix', status: 'started' });
    runReport({ session: 'fix-5', status: 'done', outcome: 'escalated-conflict' });
    const gen2 = runReport({ session: 'fix-5', kind: 'fix', status: 'started' });
    expect(gen2.changed).toBe(true);
    expect(gen2.record.status).toBe('started');
    expect(gen2.record.outcome).toBeNull(); // the prior generation's outcome must NOT leak into the new one
  });

  it('refuses started with no kind and no existing record to infer it from', () => {
    expect(() => runReport({ session: 'fix-5', status: 'started' })).toThrow(/requires --kind/);
  });
});

describe('report --status=done', () => {
  it('merges onto the existing started record, preserving startedAt', () => {
    const started = runReport({ session: 'review-9', kind: 'review', pr: '9', status: 'started' }).record;
    const done = runReport({ session: 'review-9', status: 'done', outcome: 'auto-cleared', verdict: 'accept' }).record;
    expect(done.status).toBe('done');
    expect(done.outcome).toBe('auto-cleared');
    expect(done.verdict).toBe('accept');
    expect(done.startedAt).toBe(started.startedAt);
  });

  it('mints a record directly when no `started` report ever happened', () => {
    const done = runReport({ session: 'fix-42', kind: 'fix', status: 'done', outcome: 'gate-red' }).record;
    expect(done.status).toBe('done');
    expect(done.outcome).toBe('gate-red');
    expect(tryReadCompletion('fix-42').outcome).toBe('gate-red');
  });
});

describe('show', () => {
  it('reports found:false for a session with no record, not a throw', () => {
    expect(runShow({ session: 'review-none' })).toEqual({ found: false, session: 'review-none' });
  });
});

describe('a crashed dispatched agent still leaves a completion record (done-when #3)', () => {
  it('the started report survives a crash that never reaches the done report', () => {
    // Exactly what the brief's arc does: report `started` as the very first action...
    runReport({ session: 'review-1234', kind: 'review', pr: '1234', status: 'started' });

    // ...then the rest of the dispatch (acquiring a lane, running the review loop) throws, exactly as a
    // genuine crash or a refused effect would — no `done` report is EVER made.
    const simulateDispatch = () => {
      throw new Error('simulated crash: lane acquire refused');
    };
    expect(simulateDispatch).toThrow(/simulated crash/);

    // The record must still be there — a reader gets "started, not yet done", never nothing at all.
    const record = tryReadCompletion('review-1234');
    expect(record).not.toBeNull();
    expect(record.status).toBe('started');
    expect(record.outcome).toBeNull();
    expect(runShow({ kind: 'review', pr: '1234' })).toEqual({ found: true, ...record });
  });

  it('planDoneReport tolerates a missing existing record (the report-itself-crashed-before-started case)', () => {
    const record = planDoneReport({ existing: null, session: 'fix-7', kind: 'fix', pr: '7', item: null, patch: { outcome: 'blocked-on-infra' }, now: () => '2026-09-03T02:00:00.000Z' });
    expect(record.status).toBe('done');
    expect(record.outcome).toBe('blocked-on-infra');
    expect(record.startedAt).toBe('2026-09-03T02:00:00.000Z');
  });
});

// #4306 (epic #3383/#4075, BLOCKER fix-2821) — "a completion record only ever speaks for the session that
// wrote it": the ownership table `--session-id` drives on `report`.
describe('report --session-id (#4306 ownership table)', () => {
  it('started: a same-owner re-report onto its own started record is a no-op, exactly like the un-identified case', () => {
    const first = runReport({ session: 'fix-11', kind: 'fix', status: 'started', 'session-id': 'A' });
    expect(first.changed).toBe(true);
    expect(first.record.sessionId).toBe('A');
    const second = runReport({ session: 'fix-11', kind: 'fix', status: 'started', 'session-id': 'A' });
    expect(second).toEqual({ changed: false, record: first.record });
  });

  it('started: a DIFFERENT sessionId onto an existing started record is a NEW generation — fresh record, never merged onto the old', () => {
    runReport({ session: 'fix-11', kind: 'fix', status: 'started', 'session-id': 'A' });
    const gen2 = runReport({ session: 'fix-11', kind: 'fix', status: 'started', 'session-id': 'B' });
    expect(gen2.changed).toBe(true);
    expect(gen2.record.sessionId).toBe('B');
    expect(gen2.record.status).toBe('started');
  });

  it('started: an identified existing record + an UN-identified started report is also a new generation (one side null, the other not)', () => {
    runReport({ session: 'fix-11', kind: 'fix', status: 'started', 'session-id': 'A' });
    const anon = runReport({ session: 'fix-11', kind: 'fix', status: 'started' });
    expect(anon.changed).toBe(true);
    expect(anon.record.sessionId).toBeNull();
  });

  it('done: same sessionId (or both null) updates in place — today\'s behaviour, unaffected by this card', () => {
    runReport({ session: 'fix-11', kind: 'fix', status: 'started', 'session-id': 'A' });
    const done = runReport({ session: 'fix-11', status: 'done', outcome: 'accepted', 'session-id': 'A' });
    expect(done.changed).toBe(true);
    expect(done.record.status).toBe('done');
    expect(done.record.sessionId).toBe('A');
  });

  it('done: a legacy (no-sessionId) record adopts a non-null incoming id', () => {
    runReport({ session: 'fix-11', kind: 'fix', status: 'started' }); // no --session-id: legacy
    const done = runReport({ session: 'fix-11', status: 'done', outcome: 'accepted', 'session-id': 'B' });
    expect(done.changed).toBe(true);
    expect(done.record.sessionId).toBe('B');
  });

  it('done: an identified record refuses a done report from a DIFFERENT id — exit-0 refusal, not a throw, the record is left untouched', () => {
    runReport({ session: 'fix-11', kind: 'fix', status: 'started', 'session-id': 'A' });
    const result = runReport({ session: 'fix-11', status: 'done', outcome: 'unreported-exit', 'session-id': 'B' });
    expect(result).toEqual({ changed: false, refused: true, why: expect.stringMatching(/owned by session A/) });
    const onDisk = tryReadCompletion('fix-11');
    expect(onDisk.status).toBe('started'); // untouched — never overwritten by the refused report
    expect(onDisk.sessionId).toBe('A');
  });

  it('done: an identified record refuses an ANONYMOUS (no-id) done report too — this is exactly the live-incident backstop shape', () => {
    runReport({ session: 'fix-11', kind: 'fix', status: 'started', 'session-id': 'B' }); // the LIVE new fixer
    const result = runReport({ session: 'fix-11', status: 'done', outcome: 'unreported-exit' }); // an old-generation backstop, no id
    expect(result.refused).toBe(true);
    expect(tryReadCompletion('fix-11').status).toBe('started'); // B's own record survives
  });

  it('planDoneOwnership: the pure core matches the table exactly', () => {
    expect(planDoneOwnership({ existing: null, incomingSessionId: 'A' })).toEqual({ refuse: false, sessionId: 'A' });
    expect(planDoneOwnership({ existing: { sessionId: null }, incomingSessionId: null })).toEqual({ refuse: false, sessionId: null });
    expect(planDoneOwnership({ existing: { sessionId: null }, incomingSessionId: 'A' })).toEqual({ refuse: false, sessionId: 'A' });
    expect(planDoneOwnership({ existing: { sessionId: 'A' }, incomingSessionId: 'A' })).toEqual({ refuse: false, sessionId: 'A' });
    expect(planDoneOwnership({ existing: { sessionId: 'A' }, incomingSessionId: 'B' }).refuse).toBe(true);
    expect(planDoneOwnership({ existing: { sessionId: 'A' }, incomingSessionId: null }).refuse).toBe(true);
  });
});

// #4306 (independent panel review, standards-conformance/red-team) — the CLAUDE_CODE_SESSION_ID auto-fill
// lives ENTIRELY inside the `IS_CLI` guard (see completion-cli.mjs's own header comment for why), which only
// ever runs when this file is invoked as a real subprocess — every other test in this file calls `runReport`
// in-process and so never exercises that branch. This is the one test that actually spawns the CLI.
describe('the real CLI subprocess auto-fills --session-id from CLAUDE_CODE_SESSION_ID (#4306)', () => {
  it('a `report --status=started` run as a real subprocess with CLAUDE_CODE_SESSION_ID set stamps the record with it', () => {
    execFileSync(process.execPath, [CLI_PATH, 'report', '--session=fix-777', '--kind=fix', '--pr=777', '--status=started'], {
      env: { ...process.env, OPERATION_COMPLETIONS_DIR: dir, CLAUDE_CODE_SESSION_ID: 'sess-real-cli-subprocess' },
      encoding: 'utf8',
    });
    const record = tryReadCompletion('fix-777', dir);
    expect(record.sessionId).toBe('sess-real-cli-subprocess');
  });

  it('an explicit --session-id on the command line wins over the environment variable', () => {
    execFileSync(process.execPath, [CLI_PATH, 'report', '--session=fix-778', '--kind=fix', '--pr=778', '--status=started', '--session-id=explicit-id'], {
      env: { ...process.env, OPERATION_COMPLETIONS_DIR: dir, CLAUDE_CODE_SESSION_ID: 'sess-should-be-ignored' },
      encoding: 'utf8',
    });
    const record = tryReadCompletion('fix-778', dir);
    expect(record.sessionId).toBe('explicit-id');
  });

  it('with no CLAUDE_CODE_SESSION_ID in the subprocess env, the record stays legacy (sessionId: null)', () => {
    const env = { ...process.env, OPERATION_COMPLETIONS_DIR: dir };
    delete env.CLAUDE_CODE_SESSION_ID;
    execFileSync(process.execPath, [CLI_PATH, 'report', '--session=fix-779', '--kind=fix', '--pr=779', '--status=started'], { env, encoding: 'utf8' });
    const record = tryReadCompletion('fix-779', dir);
    expect(record.sessionId).toBeNull();
  });
});

it('resolves completion repo keys and slugs', () => {
  expect(sessionSlugForCompletion({ kind: 'review', pr: 49, repo: 'frontierui' })).toBe('review-fui-49');
  expect(sessionSlugForCompletion({ kind: 'fix', pr: 49, repo: 'plateauapp/plateau-app' })).toBe('fix-pa-49');
  expect(() => sessionSlugForCompletion({ kind: 'fix', pr: 49, repo: 'other/repo' })).toThrow(/unknown repo/);
});

it('reports and shows repo-specific records independently', () => {
  const sibling = runReport({ kind: 'review', pr: '49', repo: 'frontier-ui/frontierui', status: 'started' });
  expect(sibling.record.session).toBe('review-fui-49');
  expect(runShow({ kind: 'review', pr: '49', repo: 'frontierui' }).found).toBe(true);
  expect(runShow({ kind: 'review', pr: '49' }).found).toBe(false);
});
