/**
 * @file scripts/conveyor/__tests__/stand-down.test.mjs
 * @description Pins the durable STAND-DOWN marker (WE #3296) — the record that tells "a fixer proved the fix
 *   wrong and stood down" apart from "a fixer died".
 *
 *   This is cause 3 of #3296, the sharpest of its six. The fix-agent brief's two escalation exits are CORRECT
 *   behaviour — an agent that cannot safely make a judgment must not guess — and before this file they wrote
 *   NOTHING durable: the PR kept `review:changes`, no comment was posted, and the one-line return went to a
 *   calling session that then exited. On the PR itself the two cases were byte-identical, so any reconciler
 *   reading that PR re-dispatches the refusal forever.
 *
 *   THE MARKER IS THE WHOLE MECHANISM, so it is pinned three ways: the marker line itself (changing it orphans
 *   every existing record), the round trip (what `buildStandDownComment` writes is what `countStandDownComments`
 *   reads), and — the half that would otherwise rot — that the BRIEF'S TWO EXITS ACTUALLY CALL IT. A script
 *   nothing invokes is the #3095 defect arriving by a different door, and prose is exactly where that rot is
 *   invisible.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  STAND_DOWN_MARKER, STAND_DOWN_REASONS, countStandDownComments, buildStandDownComment,
  standDownComments, standDownReason, WATCHER_STAND_DOWN_ACTOR, countTerminalStandDowns,
  SUPERSEDE_STAND_DOWN_MARKER, isStandDownSuperseded, isSelfAuthored, AUTOMATION_LOGINS,
} from '../stand-down.mjs';
import { REARM_COMMENT_MARKER } from '../rearm-review.mjs';
import { CI_HEAL_COMMENT_MARKER } from '../ci-heal-mark.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIEF = resolve(HERE, '../../../skills-src/conveyor/fix-agent-brief.md');

// #3383 — every counter now also requires a TRUSTED author (`we:scripts/lib/marker-authorship.mjs`). This is the
// real automation login, confirmed live (`web-everything/web-everything#2578`/`#2602`/`#2607`); fixtures below that
// exercise "a legitimate marker counts" attach it explicitly rather than relying on an implicit default.
const AUTOMATION = { login: 'web-everything' };

describe('the marker — single-sourced, and distinct from its two siblings (#3296)', () => {
  it('build and count share ONE marker, so posting and counting can never drift', () => {
    expect(buildStandDownComment().split('\n')[0]).toBe(STAND_DOWN_MARKER);
    expect(countStandDownComments([{ body: buildStandDownComment(), author: AUTOMATION }])).toBe(1);
  });

  it('does NOT cross-count with the re-arm (#2643) or CI-heal (#2666) markers', () => {
    // Three durable counts read the same comment thread. If any two shared a prefix, a burned PR would read as
    // stood down, or a stood-down PR would read as re-armed — and each is a different wrong dispatch.
    const thread = [
      { body: REARM_COMMENT_MARKER, author: AUTOMATION },
      { body: CI_HEAL_COMMENT_MARKER, author: AUTOMATION },
      { body: buildStandDownComment(), author: AUTOMATION },
    ];
    expect(countStandDownComments(thread)).toBe(1);
    expect(STAND_DOWN_MARKER).not.toBe(REARM_COMMENT_MARKER);
    expect(STAND_DOWN_MARKER.startsWith(REARM_COMMENT_MARKER)).toBe(false);
    expect(STAND_DOWN_MARKER.startsWith(CI_HEAL_COMMENT_MARKER)).toBe(false);
  });

  it('counts only a LEADING marker line — a human quoting it in a reply never inflates the count', () => {
    expect(countStandDownComments([{ body: `> ${STAND_DOWN_MARKER}\n\nI'll take it.`, author: AUTOMATION }])).toBe(0);
    expect(countStandDownComments([{ body: `  ${STAND_DOWN_MARKER}\n…`, author: AUTOMATION }])).toBe(1); // leading whitespace is fine
  });

  it('tolerates the shapes `gh` and its callers actually produce', () => {
    expect(countStandDownComments(null)).toBe(0);
    expect(countStandDownComments(undefined)).toBe(0);
    expect(countStandDownComments([])).toBe(0);
    expect(countStandDownComments('not an array')).toBe(0);
    // #3383 — a bare string carries no author at all, so it is a TOLERATED SHAPE (never throws), never a count:
    // real `gh` output is never a bare string, and an untrusted/unknown author must fail closed.
    expect(countStandDownComments([STAND_DOWN_MARKER])).toBe(0);
    expect(countStandDownComments([{ body: null }, {}])).toBe(0);
  });
});

describe('the comment body — a marker, not a burial (#3296)', () => {
  it('names each of the brief\'s real escalation exits', () => {
    for (const [reason, clause] of Object.entries(STAND_DOWN_REASONS)) {
      expect(buildStandDownComment({ reason })).toContain(clause);
    }
  });

  it('an unknown reason still produces a valid, countable record rather than throwing', () => {
    const body = buildStandDownComment({ reason: 'something-new' });
    expect(body.split('\n')[0]).toBe(STAND_DOWN_MARKER);
    expect(countStandDownComments([{ body, author: AUTOMATION }])).toBe(1);
  });

  it('says the loop has stopped AND that a person is the intended exit', () => {
    // `stood-down` is terminal for the RECONCILER, not for a human. If the comment did not say so, the marker
    // would become a way to bury a PR — a worse defect than the one it fixes.
    const body = buildStandDownComment({ reason: 'needs-judgment' });
    expect(body).toMatch(/human is the intended next step/i);
    expect(body).toMatch(/will NOT try this PR again/i);
    expect(body).toMatch(/delete this comment/i);
  });

  it('records that NOTHING was changed on the PR — no label swap, no re-arm, no push', () => {
    const body = buildStandDownComment({ reason: 'gate-red' });
    expect(body).toMatch(/no label was changed/i);
    expect(body).toMatch(/not re-armed/i);
  });
});

describe('the fix-agent brief actually CALLS it — the half that would otherwise rot (#3296)', () => {
  const brief = readFileSync(BRIEF, 'utf8');
  const lines = brief.split('\n');
  /** The line numbers of every `stand-down.mjs` invocation in the brief. */
  const callLines = lines
    .map((l, i) => (l.includes('stand-down.mjs') ? i + 1 : 0))
    .filter(Boolean);

  it('invokes `scripts/conveyor/stand-down.mjs` at least three times — once per escalation exit', () => {
    // #xu2krte closed the named gap: the AUTOMATIC conflict exit (brief §3) used to call ONLY
    // `completion-cli.mjs`, never this script — so an auto-dispatched conflict escalation was silently
    // re-dispatched at the same unresolved conflict next tick, bounded only by the 5-attempt rearm cap rather
    // than this terminal stand-down exit. Three now: ambiguous-finding, conflict, gate-red.
    expect(callLines.length).toBeGreaterThanOrEqual(3);
  });

  it('the AUTOMATIC conflict exit calls it before returning (brief §3, #xu2krte)', () => {
    const exitAt = lines.findIndex((l) => l.includes('fix escalated (conflict with main)')) + 1;
    expect(exitAt).toBeGreaterThan(0);
    expect(callLines.some((n) => Math.abs(n - exitAt) <= 12)).toBe(true);
    // And it passes the SAME reason the manual `/finish` path already does — no new vocabulary invented.
    const nearby = lines.slice(Math.max(0, exitAt - 12), exitAt).join('\n');
    expect(nearby).toMatch(/stand-down\.mjs[^\n]*--reason=conflict/);
  });

  it('the AMBIGUOUS-FINDING exit calls it before returning (brief §2)', () => {
    // The exit that says "do NOT guess — leave the PR review:changes (do not re-arm) and RETURN
    // `fix escalated (finding needs human judgment)`". Correct, and silent until now.
    const exitAt = lines.findIndex((l) => l.includes('fix escalated (finding needs human judgment)')) + 1;
    expect(exitAt).toBeGreaterThan(0);
    expect(callLines.some((n) => Math.abs(n - exitAt) <= 12)).toBe(true);
  });

  it('the RED-GATE exit calls it before returning (brief §4)', () => {
    // "A red gate is a hard stop: leave the PR review:changes (do NOT re-arm) and RETURN `fix gate-red`."
    const exitAt = lines.findIndex((l) => l.includes('fix gate-red')) + 1;
    expect(exitAt).toBeGreaterThan(0);
    expect(callLines.some((n) => Math.abs(n - exitAt) <= 12)).toBe(true);
  });

  it('every `--reason=` the brief passes is a reason this script knows', () => {
    // A brief that passes a reason the script does not carry silently degrades to the generic clause; the
    // durable record then says less than the agent knew.
    const reasons = [...brief.matchAll(/stand-down\.mjs[^\n]*--reason=([a-z-]+)/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    for (const r of reasons) expect(Object.keys(STAND_DOWN_REASONS)).toContain(r);
  });

  // PR #2518 / #3945 (2026-09-23) — a fix agent whose Edit/Write (or any tool call) was denied by a
  // permission/tool-use guard while applying an otherwise-CLEAR fix wrongly stood down under `needs-judgment`,
  // stalling a mechanically-clear repair on a human. The correct exit is `blocked-on-infra`
  // (`completion-cli.mjs`), which the reconciler retries — never a NEW stand-down reason, which would make it
  // terminal. Pin both halves of that: the vocabulary never grows a permission/infra-shaped reason, and the
  // brief's own denial-exit paragraph never calls this script.
  it('never carries a permission/infra-shaped reason — that case is blocked-on-infra, not a stand-down', () => {
    for (const key of Object.keys(STAND_DOWN_REASONS)) {
      expect(key).not.toMatch(/permission|infra/i);
    }
  });

  it('the brief\'s tool/permission-denial exit reports blocked-on-infra and does not call this script', () => {
    const denialAt = lines.findIndex((l) => l.includes('If applying an otherwise-CLEAR fix is denied'));
    expect(denialAt).toBeGreaterThanOrEqual(0);
    const exitAt = lines.findIndex((l, i) => i > denialAt && l.includes('blocked-on-infra ('));
    expect(exitAt).toBeGreaterThan(denialAt);
    const paragraph = lines.slice(denialAt, exitAt + 1).join('\n');
    expect(paragraph).toMatch(/--outcome=blocked-on-infra/);
    // The paragraph is allowed to MENTION stand-down.mjs in prose (contrasting this exit with it) — it must
    // never actually INVOKE it, the shape every real escalation call takes (`node ".../stand-down.mjs" <pr>`).
    expect(paragraph).not.toMatch(/stand-down\.mjs"\s+\{\{PR_NUM\}\}/);
  });

  it('still tells the agent NOT to re-arm at an escalation — the marker is not a hand-back', () => {
    expect(brief).toMatch(/do \*\*not\*\* re-arm/i);   // markdown emphasis and all — the instruction is unchanged
  });
});

// `standDownComments`/`standDownReason` — the reader half, added for the operator queue's STOOD DOWN section
// (we:backlog/x6cjgz5). `countStandDownComments` is now built on `standDownComments`, so this also re-covers its
// existing contract from the inside.
describe('standDownComments and standDownReason — reading a stand-down comment back', () => {
  it('returns the matching comments, normalized to {body, createdAt}, leading-marker only', () => {
    const body = buildStandDownComment({ reason: 'gate-red' });
    expect(standDownComments([
      { body: 'unrelated', author: AUTOMATION },
      { body, createdAt: '2026-09-20T00:00:00Z', author: AUTOMATION },
      { body: `> ${STAND_DOWN_MARKER}\nquoted, not leading`, author: AUTOMATION },
    ])).toEqual([{ body, createdAt: '2026-09-20T00:00:00Z' }]);
  });

  it('tolerates bare strings as a SHAPE (never throws) — but a bare string has no author, so it never counts (#3383)', () => {
    expect(standDownComments([STAND_DOWN_MARKER])).toEqual([]);
  });

  it('tolerates non-array / empty input the same way countStandDownComments does', () => {
    for (const input of [null, undefined, [], 'not an array']) expect(standDownComments(input)).toEqual([]);
  });

  it('extracts the stated reason clause for each named reason', () => {
    for (const [reason, clause] of Object.entries(STAND_DOWN_REASONS)) {
      expect(standDownReason(buildStandDownComment({ reason }))).toBe(clause);
    }
  });

  it('returns null for a body with no "stopped rather than guessing" sentence', () => {
    expect(standDownReason('some other comment')).toBeNull();
    expect(standDownReason('')).toBeNull();
    expect(standDownReason(undefined)).toBeNull();
  });
});

// ── #xu2krte Fork 2 (review-human statute amendment) — countTerminalStandDowns narrows countStandDownComments ──
describe('countTerminalStandDowns — excludes ONLY a SUPERSEDED, SELF-AUTHORED watcher marker', () => {
  // `viewerDidAuthor` is GitHub's own per-comment flag (`gh pr view --json comments`): true only when the
  // authenticated identity running the conveyor wrote the comment. Not forgeable from a comment body.
  const watcherStandDown = { body: buildStandDownComment({ actor: WATCHER_STAND_DOWN_ACTOR, reason: 'conflict' }), viewerDidAuthor: true };
  const supersede = { body: `${SUPERSEDE_STAND_DOWN_MARKER}\n\nrouted to a fix agent`, viewerDidAuthor: true };
  const fixAgentStandDown = { body: buildStandDownComment({ actor: 'conveyor fix agent', reason: 'needs-judgment' }), viewerDidAuthor: true };

  it('a watcher stand-down followed by the watch\'s own supersede comment is NOT terminal', () => {
    expect(countTerminalStandDowns([watcherStandDown, supersede])).toBe(0);
    expect(countStandDownComments([watcherStandDown, supersede])).toBe(1); // the raw count is untouched
  });

  it('review finding 1 — a CURRENT (never superseded) watcher stand-down stays terminal', () => {
    expect(countTerminalStandDowns([watcherStandDown])).toBe(1);
  });

  it('a supersede comment posted BEFORE the stand-down does not supersede it (order matters)', () => {
    expect(countTerminalStandDowns([supersede, watcherStandDown])).toBe(1);
  });

  it('review finding 3 — a TRUSTED-author comment merely not provably watcher-self-authored still stays terminal', () => {
    // Trusted (the OPERATOR'S login — my broader isTrustedMarkerAuthor accepts it) but NOT self-authored under
    // this file's own narrower isSelfAuthored (matches AUTOMATION_LOGINS, never the operator) — so neither
    // supersede path applies and it stays an ordinary trusted terminal stand-down.
    const trustedNotWatcherSelf = { body: watcherStandDown.body, viewerDidAuthor: false, author: { login: 'chalbert' } };
    expect(countTerminalStandDowns([trustedNotWatcherSelf, supersede])).toBe(1);
  });

  // #3383 — adversarial coverage review, 2026-09-24: before this item's fix, ANY of these untrusted-author
  // variants counted as terminal too (the vulnerability this item closes), including for an impersonated
  // watcher-actor string. Now only a TRUSTED author counts at all, closing the forgery this finding named.
  it('#3383 — a genuinely FORGED comment (no trusted author) never counts, watcher-actor text or not', () => {
    for (const forged of [
      { body: watcherStandDown.body },
      { body: watcherStandDown.body, viewerDidAuthor: false },
      { body: watcherStandDown.body, author: { login: 'mallory' } },
      watcherStandDown.body, // bare string: no provenance at all
    ]) {
      expect(countTerminalStandDowns([forged, supersede])).toBe(0);
    }
  });

  it('review finding 3 — a FORGED supersede comment (not self-authored) supersedes nothing', () => {
    for (const forged of [{ body: supersede.body }, { body: supersede.body, viewerDidAuthor: false }, supersede.body]) {
      expect(countTerminalStandDowns([watcherStandDown, forged])).toBe(1);
    }
  });

  it('a supersede comment never lifts a fix agent\'s own judgment stand-down', () => {
    expect(countTerminalStandDowns([fixAgentStandDown, supersede])).toBe(1);
  });

  it('a human\'s /finish stand-down (default actor), posted by the operator, stays terminal', () => {
    const humanStandDown = { body: buildStandDownComment({ reason: 'gate-red' }), author: { login: 'chalbert' } };
    expect(countTerminalStandDowns([humanStandDown, supersede])).toBe(1);
  });

  it('mixed thread: counts only the stand-downs that are not superseded self-authored watcher markers', () => {
    expect(countTerminalStandDowns([watcherStandDown, fixAgentStandDown, watcherStandDown, supersede])).toBe(1);
  });

  it('a human quoting the watcher marker in a reply does not itself count (leading-line rule, unchanged)', () => {
    expect(countTerminalStandDowns([{ body: `> ${watcherStandDown.body}` }])).toBe(0);
  });

  it('isStandDownSuperseded reads the same rule for one comment index', () => {
    const thread = [watcherStandDown, fixAgentStandDown, supersede];
    expect(isStandDownSuperseded(thread, 0)).toBe(true);
    expect(isStandDownSuperseded(thread, 1)).toBe(false);
    expect(isStandDownSuperseded([watcherStandDown], 0)).toBe(false);
  });

  it('non-array / empty input reads as zero, same as countStandDownComments', () => {
    for (const input of [null, undefined, []]) expect(countTerminalStandDowns(input)).toBe(0);
  });
});

// xaer296 follow-up (epic #3383) — CONFIRMED LIVE, `web-everything/web-everything#2549`, 2026-09-24: `viewerDidAuthor`
// read `false` on EVERY marker comment this repo's own automation posted, from BOTH a personal-token read AND
// the resident daemon's own real production read (loading a candidate fix into the daemon clone and running
// `runReconcilePass` for real) — `reconcile-pass.mjs`'s discovery read never actually authenticates as the
// identity that posted those comments. `author.login` is the READ-stable signal that actually works; see
// `AUTOMATION_LOGINS`'s own docblock for the full incident.
describe('isSelfAuthored — author.login is the READ-stable signal, viewerDidAuthor is an additional accepted path (xaer296)', () => {
  it('a real comment shape (author.login, no viewerDidAuthor at all) is recognized — the actual production shape', () => {
    expect(isSelfAuthored({ author: { login: AUTOMATION_LOGINS[0] } })).toBe(true);
  });

  it('is case-insensitive on the login', () => {
    expect(isSelfAuthored({ author: { login: AUTOMATION_LOGINS[0].toUpperCase() } })).toBe(true);
  });

  it('a DIFFERENT author (a human, e.g. the repo operator) is not self-authored, even with no viewerDidAuthor field', () => {
    expect(isSelfAuthored({ author: { login: 'chalbert' } })).toBe(false);
  });

  it('viewerDidAuthor: true is STILL accepted (widened, not replaced) — a reader that genuinely is the posting identity', () => {
    expect(isSelfAuthored({ viewerDidAuthor: true, author: { login: 'someone-else' } })).toBe(true);
  });

  it('viewerDidAuthor: false with no matching login is not self-authored (both signals must fail together)', () => {
    expect(isSelfAuthored({ viewerDidAuthor: false, author: { login: 'chalbert' } })).toBe(false);
  });

  it('a bare string or missing author is never self-authored', () => {
    expect(isSelfAuthored('some body')).toBe(false);
    expect(isSelfAuthored({ body: 'x' })).toBe(false);
    expect(isSelfAuthored(null)).toBe(false);
  });

  // The exact real shape observed on `#2549`'s own thread (`gh pr view --json comments`): `viewerDidAuthor`
  // absent from the object entirely in some `gh` versions' output, `author.login` always present.
  it('the exact real #2549 shape resolves self-authored (regression pin for the live incident)', () => {
    const realShape = { author: { login: 'web-everything' }, body: '🛑 conveyor fix — stood down, human judgment needed' };
    expect(isSelfAuthored(realShape)).toBe(true);
  });
});

// #3383 — adversarial coverage review, 2026-09-24: WE's PRs are public, so any GitHub account can post a
// comment whose leading line is STAND_DOWN_MARKER, and before the fix in this item that alone made
// `countStandDownComments` (and therefore `planReconcile`'s dispatch refusal) treat the PR as permanently
// stood down — terminal, no decay, no clock — exactly as if a real fixer had escalated. `mallory` is a random
// commenter, never the automation and never the operator.
describe('countStandDownComments — a forged marker from a random commenter must not count (#3383)', () => {
  it('a stand-down marker posted by "mallory" (not automation, not the operator) is ignored', () => {
    const forged = { body: buildStandDownComment({ reason: 'gate-red' }), author: { login: 'mallory' } };
    expect(countStandDownComments([forged])).toBe(0);
  });

  it('the SAME marker posted by the automation login still counts', () => {
    const real = { body: buildStandDownComment({ reason: 'gate-red' }), author: { login: 'web-everything' } };
    expect(countStandDownComments([real])).toBe(1);
  });

  it('the SAME marker posted by the repo operator still counts', () => {
    const real = { body: buildStandDownComment({ reason: 'gate-red' }), author: { login: 'chalbert' } };
    expect(countStandDownComments([real])).toBe(1);
  });
});


it('every fixer stand-down call in the brief passes --who={{SESSION_SLUG}}', () => {
  const calls = readFileSync(BRIEF, 'utf8').replace(/\\\n\s*/g, ' ').split('\n')
    .filter((line) => line.startsWith('node "{{WE_ROOT}}/scripts/conveyor/stand-down.mjs"'));
  expect(calls).toHaveLength(5);
  for (const call of calls) expect(call).toContain('--who={{SESSION_SLUG}}');
});

it('every fenced stand-down exit block in the brief also releases the fix claim with fix-end (PR #3945 review)', () => {
  const blocks = [...readFileSync(BRIEF, 'utf8').matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1])
    .filter((block) => block.includes('conveyor/stand-down.mjs'));
  expect(blocks.length).toBeGreaterThanOrEqual(5);
  for (const block of blocks) expect(block, block).toContain('conveyor/fix-procedure.mjs" fix-end');
});


describe('stand-down CLI releases only after a successful comment (#4897)', () => {
  it.each([
    ['needs-judgment', 'chalbert/web-everything', 'fix-3311', false, true],
    ['concurrent-author', 'we', 'fix-3311', false, true],
    ['needs-judgment', 'we', null, false, false],
    ['needs-judgment', 'unknown/repo', 'fix-3311', false, false],
    ['needs-judgment', null, 'fix-3311', false, false],
    ['needs-judgment', 'we', 'fix-3311', true, false],
  ])('%s repo=%s who=%s postFails=%s', async (reason, repo, who, postFails, released) => {
    const fs = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { spawnSync } = await import('node:child_process');
    const root = fs.mkdtempSync(resolve(tmpdir(), 'stand-down-4897-'));
    const script = `
      import child from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import assert from 'node:assert/strict';
      const claims = await import(${JSON.stringify(resolve(HERE, '../fix-dispatch-claim.mjs'))});
      claims.acquireFixDispatchClaim({ repo: 'we', pr: 3311, owner: 'daemon:1' });
      child.execFileSync = (_cmd, args) => {
        if (args[0] === 'pr' && args[1] === 'comment') {
          assert.ok(claims.readFixDispatchClaim({ repo: 'we', pr: 3311 }));
          if (${postFails}) throw new Error('post failed');
        } else assert.equal(claims.readFixDispatchClaim({ repo: 'we', pr: 3311 }) === null, ${released});
        return '';
      };
      syncBuiltinESMExports();
      process.argv = ${JSON.stringify([process.execPath, resolve(HERE, '../stand-down.mjs'), '3311', `--reason=${reason}`,
        ...(repo ? [`--repo=${repo}`] : []), ...(who ? [`--who=${who}`] : [])])};
      // The dispatch graph has already imported the pure exports: select a fresh CLI module instance.
      await import(${JSON.stringify(resolve(HERE, '../stand-down.mjs') + '?cli-proof')});
    `;
    try {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8', env: { ...process.env, WE_COORDINATION_ROOT: root }, timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(postFails ? 1 : 0);
      if (!postFails) {
        expect(JSON.parse(result.stdout).dispatchClaimReleased).toEqual(released ? [{ kind: 'fix', owner: 'daemon:1' }] : []);
        if (!released) expect(result.stderr).toContain('⚠');
      } else expect(result.stderr).toContain('post failed');
      const { readFixDispatchClaim } = await import('../fix-dispatch-claim.mjs');
      expect(readFixDispatchClaim({ repo: 'we', pr: 3311, lockRoot: resolve(root, 'fix-dispatch-claims') }) === null).toBe(released);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// #3881: legacy local verify flakes must not request human judgment.
import { loadFlakeHolds, loadFlakeHoldState, parseAltBranch, buildLoadFlakeHoldComment, buildLoadFlakeResolvedComment } from '../stand-down.mjs';
import { loadFlakeLegacyBody, loadTimeoutLegacyBody } from './load-flake-fixture.mjs';
const loadComment = (body, createdAt = '2026-10-04T18:51:50Z') => ({ body, createdAt, author: AUTOMATION });
describe('load-flake holds', () => {
  it('parses the real alt SHA and reclassifies only trusted pre-cutoff load flakes', () => {
    const c = loadComment(loadFlakeLegacyBody);
    expect(parseAltBranch(c.body)).toEqual({ branch: 'lane/fix-polluted-branch-scope-read-fix-3881-alt', sha: '9202eee8a' });
    expect(countTerminalStandDowns([c])).toBe(0);
    expect(loadFlakeHolds([c])[0]).toMatchObject({ head: null, legacy: true });
    expect(countTerminalStandDowns([{ ...c, createdAt: '2026-10-05T00:00:00Z' }])).toBe(1);
    expect(countTerminalStandDowns([loadComment(c.body.replace('load flakiness', 'test failure').replace('load timeouts', 'test failures'))])).toBe(1);
    expect(loadFlakeHolds([{ ...c, author: { login: 'stranger' } }])).toEqual([]);
  });
  it('reclassifies only where the reverify pass works: a legacy comment on another repo stays terminal (PR #3945 review)', () => {
    const on = (slug) => ({ ...loadComment(loadFlakeLegacyBody), url: `https://github.com/${slug}/pull/12#issuecomment-1` });
    for (const slug of ['frontier-ui/frontierui', 'plateauapp/plateau-app']) {
      expect(countTerminalStandDowns([on(slug)])).toBe(1);
      expect(loadFlakeHolds([on(slug)])).toEqual([]);
      expect(loadFlakeHoldsFull([on(slug)])).toEqual([]);
    }
    expect(countTerminalStandDowns([on('web-everything/web-everything')])).toBe(0);
    expect(loadFlakeHolds([on('web-everything/web-everything')])).toHaveLength(1);
  });
  it('reclassifies #3932\'s "load timeouts" wording too (17:06 ET stand-down)', () => {
    const c = loadComment(loadTimeoutLegacyBody, '2026-10-04T21:06:04Z');
    expect(countTerminalStandDowns([c])).toBe(0);
    expect(loadFlakeHolds([c])[0]).toMatchObject({ legacy: true, alt: { branch: 'lane/heavy-enforce-guard-fix-3932-alt', sha: 'ea104d91e' } });
  });
  it('holds until pushed or moved; red-again stays live; exhausted is terminal', () => {
    const c = loadComment(buildLoadFlakeHoldComment({ head: 'abc0001', alt: 'lane/fix-alt', altSha: '9202eee8a' }));
    expect(loadFlakeHoldState({ comments: [c], headRefOid: 'abc0001' }).live).toBe(true);
    expect(loadFlakeHoldState({ comments: [c], headRefOid: 'def0002' }).live).toBe(false);
    for (const result of ['pushed', 'red-again', 'exhausted']) {
      const comments = [c, loadComment(buildLoadFlakeResolvedComment({ altSha: '9202eee8a', result }), '2026-10-04T20:00:00Z')];
      expect(loadFlakeHoldState({ comments, headRefOid: 'abc0001' }).live).toBe(result === 'red-again');
      expect(countTerminalStandDowns(comments)).toBe(result === 'exhausted' ? 1 : 0);
    }
    expect(buildLoadFlakeHoldComment({ head: 'old' })).toContain('stand-down reason=gate-red');
  });
});

// PR #3945 review: a legacy gate-red load-flake stand-down that the thread has since superseded must stay inactive.
import { buildOperatorAnswer } from '../stand-down-answer-core.mjs';
import { loadFlakeHolds as loadFlakeHoldsFull, loadFlakeHoldState as loadFlakeHoldStateFull } from '../load-flake-hold.mjs';
import { ADVISORY_FIX_COMMENT_MARKER } from '../advisory-fix-mark.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
describe('superseded legacy load-flake holds', () => {
  const legacy = { ...loadComment(loadFlakeLegacyBody), id: 'IC_legacy_hold' };
  const answer = {
    id: 'IC_answer', author: AUTOMATION, createdAt: '2026-10-04T22:00:00Z',
    body: buildOperatorAnswer({ standDownId: 'IC_legacy_hold', reason: 'ship the alt branch by hand', actor: 'chalbert', channel: 'test' }),
  };
  const note = { body: `${ADVISORY_NOTE_MARKER}\n\nadvisory note`, author: AUTOMATION, createdAt: '2026-10-04T18:00:00Z' };
  const fixMark = { body: `${ADVISORY_FIX_COMMENT_MARKER}\n\nfixed`, author: AUTOMATION, createdAt: '2026-10-04T18:30:00Z' };
  it('an operator answer naming the legacy hold ends it', () => {
    expect(loadFlakeHoldsFull([legacy])).toHaveLength(1);
    expect(loadFlakeHoldsFull([legacy, answer])).toEqual([]);
    expect(loadFlakeHoldStateFull({ comments: [legacy], headRefOid: 'advanced-past-alt' }).live).toBe(true);
    expect(loadFlakeHoldStateFull({ comments: [legacy, answer], headRefOid: 'advanced-past-alt' }).live).toBe(false);
  });
  it('an answer naming a different comment does not end it', () => {
    const other = { ...answer, body: buildOperatorAnswer({ standDownId: 'IC_other', reason: 'x', actor: 'chalbert', channel: 'test' }) };
    expect(loadFlakeHoldsFull([legacy, other])).toHaveLength(1);
  });
  it('an advisory finding already addressed before the hold ends it', () => {
    expect(loadFlakeHoldsFull([note, fixMark, legacy])).toEqual([]);
    expect(loadFlakeHoldsFull([note, legacy])).toHaveLength(1);
  });
  it('stand-down.mjs stays import-light: the operator queue stages it alone', () => {
    const src = readFileSync(resolve(HERE, '..', 'stand-down.mjs'), 'utf8');
    expect(src).not.toMatch(/from '\.\/(advisory-fix-mark|stand-down-answer-core)\.mjs'/);
  });
});

// PR #3945 advisory (round 3): the recorded head may be abbreviated; GitHub reports the full 40-char OID.
import { loadFlakeHoldRequest, LOAD_FLAKE_REVERIFY_REPOS } from '../stand-down.mjs';
describe('load-flake hold head comparison and supported repos', () => {
  const full = 'abc0001'.padEnd(40, '0');
  const at = (head) => [loadComment(buildLoadFlakeHoldComment({ head, alt: 'lane/x-alt', altSha: 'bbb2222' }))];
  it('an abbreviated recorded head matches the full PR head oid', () => {
    expect(loadFlakeHoldState({ comments: at('abc0001'), headRefOid: full }).live).toBe(true);
    expect(loadFlakeHoldState({ comments: at(full), headRefOid: 'abc0001' }).live).toBe(true);
    expect(loadFlakeHoldState({ comments: at(full), headRefOid: full }).live).toBe(true);
  });
  it('a genuinely different head still ends the hold', () => {
    expect(loadFlakeHoldState({ comments: at('abc0001'), headRefOid: 'def0002'.padEnd(40, '0') }).live).toBe(false);
  });
  it('only repositories with a registered reverify worker may record a load-flake hold', () => {
    expect(LOAD_FLAKE_REVERIFY_REPOS).toEqual(['we']);
    expect(loadFlakeHoldRequest({ reason: 'load-flake', alt: 'lane/x-alt', altSha: 'bbb2222', repoKey: 'we' })).toBe(true);
    for (const repoKey of ['frontierui', 'plateau-app', null, undefined]) {
      expect(loadFlakeHoldRequest({ reason: 'load-flake', alt: 'lane/x-alt', altSha: 'bbb2222', repoKey })).toBe(false);
    }
    expect(loadFlakeHoldRequest({ reason: 'load-flake', alt: undefined, altSha: 'bbb2222', repoKey: 'we' })).toBe(false);
    expect(loadFlakeHoldRequest({ reason: 'gate-red', alt: 'lane/x-alt', altSha: 'bbb2222', repoKey: 'we' })).toBe(false);
  });
});
