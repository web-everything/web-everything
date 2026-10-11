/**
 * @file parked-pr-conflict-dispatch-integration.test.mjs — `#xu2krte` END-TO-END: a REAL merge conflict, driven
 * through the REAL classification/routing/dispatch functions, against a REAL (fake, cost-nothing) `claude` CLI.
 *
 * WHY THIS FILE EXISTS, stated as the gap it closes. Every other test touched by `#xu2krte` (
 * `parked-pr-conflict-watch.test.mjs`, `reconcile-core.test.mjs`, `reconcile-fix-dispatch.test.mjs`,
 * `dispatch-lane.test.mjs`) exercises ONE file at a time against hand-written fixture objects and injected
 * fakes for every seam. That proves each piece is internally correct; it does not prove the pieces actually
 * FIT TOGETHER, or that "two branches conflict" as asserted in a fixture object is the same thing as two
 * branches that ACTUALLY conflict under real `git`. This file closes both gaps: a real `withRealRepo` fixture
 * produces a genuine, git-confirmed merge conflict, and the REAL (not reimplemented) `isParkedConflictTarget`
 * → `planConflictLabelChange` → `isStatuteTierConflict` → `buildConflictFindingBody` → `planReconcile` →
 * `planFixesFromReconcile` → `dispatchFix` chain runs over it end to end, with `dispatchFix`'s real
 * `spawnAgent`/`listAgentsAll`/`stop` seams bound to the REAL `defaultSpawnAgent`/`defaultListAgents`/
 * `stopSession` production functions (imported for real, per `dispatch-spawn-live.test.mjs`'s own precedent)
 * — pointed at `fake-claude.mjs`'s cost-nothing shim rather than a real model.
 *
 * WHAT THIS DOES NOT COVER, stated honestly rather than left as a silent gap. The fork-then-fallback half of
 * Fork 1 (a resume attempt lands on a session the CLI decides to copy instead of continuing) is already
 * covered two other ways: exhaustively, with exact fixtures, in `reconcile-fix-dispatch.test.mjs`; and for
 * REAL, against the actual `claude` CLI (2.1.263, 2026-09-06), in the live build-time probe this item's own
 * ratified anchor documents (`docs/agent/platform-decisions.md#parked-pr-conflict-dispatched-not-scripted`).
 * `fake-claude.mjs`'s own `--resume` model only reproduces the FLAG-based fork trigger (any flag besides
 * `--resume` forks) because its sessions do not persist the way a real background process does — there is
 * nothing honest to simulate for the "target session still running" trigger — and this file's own dispatch
 * calls never add a flag to a resume attempt (by design; see `buildAgentArgv`'s own docblock), so the fork
 * branch is not reachable through this specific harness. This file instead proves the two branches it CAN
 * prove for real: a genuine resume, and a genuine fresh dispatch when no resume candidate exists.
 *
 * WIRED INTO CI the same way every file in this tier is: `vitest.config.ts`'s `test.exclude` (real git +
 * real subprocess cost does not belong in the ~2000-file unit pool) and `vitest.integration.config.ts`'s
 * `test.include` (so `npm run test:integration:vitest`, CI's own gate, still runs it before merge).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { withRealRepo, git } from '../../operations/__tests__/helpers/real-repo.mjs';
import { withFakeClaude } from '../../operations/__tests__/helpers/fake-claude.mjs';
import { defaultSpawnAgent, defaultListAgents, DISPATCHED_AGENT_SYSTEM_PROMPT_FILE } from '../../operations/dispatch-lane-io.mjs';
import { stopSession } from '../../operations/dispatch-abort.mjs';
import { buildAuthorActorMarker } from '../../lib/review-independence.mjs';

import {
  isParkedConflictTarget, planConflictLabelChange, isStatuteTierConflict, buildConflictFindingBody,
  CONFLICT_LABEL,
} from '../parked-pr-conflict-watch.mjs';
import { RECONCILE_FINDING_BANNER, buildReconcileFindingBody } from '../reconcile-finding.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { planFixesFromReconcile, dispatchFix, tryResumeFix } from '../reconcile-fix-dispatch.mjs';

const FIX_BRIEF_STUB = [
  '# fix brief for {{PR_NUM}} (item {{ITEM_NUM}})',
  'acquire: node scripts/lane-pool.mjs acquire --lane={{LANE}} --session={{SESSION_SLUG}} --scope={{SCOPE}} --base={{LANE_REF}}',
].join('\n');

/** Build the ONE conflicting file both branches touch, with genuinely overlapping edits — same line range,
 *  different content, so a three-way merge cannot resolve it automatically. */
const CONFLICT_FILE = 'scripts/example-conflicting-module.mjs';
const BASE_CONTENT = ['export function greet() {', '  return "hello";', '}', ''].join('\n');
const MAIN_CONTENT = ['export function greet() {', '  return "hello from main";', '}', ''].join('\n');
const FEATURE_CONTENT = ['export function greet() {', '  return "hello from feature";', '}', ''].join('\n');

describe('#xu2krte end-to-end — a REAL merge conflict, dispatched through the REAL pipeline', () => {
  it('git itself confirms the fixture is a genuine, unresolvable conflict (not an asserted fixture)', async () => {
    await withRealRepo(async ({ root, git: g, commit, head }) => {
      commit({ [CONFLICT_FILE]: BASE_CONTENT }, 'fixture: base');
      g(['branch', 'feature']);
      commit({ [CONFLICT_FILE]: MAIN_CONTENT }, 'fixture: main diverges');
      g(['checkout', '--quiet', 'feature']);
      commit({ [CONFLICT_FILE]: FEATURE_CONTENT }, 'fixture: feature diverges on the SAME lines');
      g(['checkout', '--quiet', 'main']);

      let threw = false;
      try {
        g(['merge', '--no-edit', 'feature']);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true); // a REAL conflict — git itself refused the merge.

      const status = g(['status', '--porcelain']);
      expect(status).toMatch(/^UU /m); // both sides modified, unmerged.
      const merged = readFileSync(join(root, CONFLICT_FILE), 'utf8');
      expect(merged).toContain('<<<<<<<');
      expect(merged).toContain('>>>>>>>');
      g(['merge', '--abort']);
    });
  });

  it('the REAL classification/routing chain treats it as a dispatchable, non-statute-tier conflict', async () => {
    await withRealRepo(async () => {
      const pr = {
        number: 8801, headRefName: 'lane/9099-conflict-fixture',
        mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY',
        labels: [{ name: 'review:pending' }],
        files: [{ path: CONFLICT_FILE }],
      };

      expect(isParkedConflictTarget(pr)).toBe(true);
      expect(planConflictLabelChange({ isConflicting: true, currentLabels: pr.labels }))
        .toEqual({ add: CONFLICT_LABEL, remove: [], newlyDetected: true });
      // Fork 2 — an ordinary source file is NOT statute-tier, so this dispatches (Fork 4), it does not stand down.
      expect(isStatuteTierConflict(pr.files)).toBe(false);

      const findingBody = buildConflictFindingBody({ num: pr.number, headRefName: pr.headRefName });
      expect(findingBody).toContain(`PR #${pr.number}`);
      const bounceBody = buildReconcileFindingBody(findingBody);
      expect(bounceBody.startsWith(RECONCILE_FINDING_BANNER)).toBe(true);
    });
  });

  it('Fork 2 — the SAME conflict, but touching a statute-tier file, is NOT dispatchable', () => {
    const files = [{ path: 'docs/agent/platform-decisions.md' }];
    expect(isStatuteTierConflict(files)).toBe(true);
  });

  it('once bounced (Fork 4), the REAL reconcile-core plans a `fix` dispatch carrying the conflict label', () => {
    const authorMarker = buildAuthorActorMarker('11111111-2222-3333-4444-555555555555');
    const prBody = `Original PR description.\n\n${authorMarker}\n`;
    const bounced = {
      number: 8801, headRefName: 'lane/9099-conflict-fixture', headRefOid: 'deadbeef'.repeat(5),
      labels: [{ name: 'review:changes' }, { name: CONFLICT_LABEL }],
      mergeStateStatus: 'DIRTY', statusCheckRollup: [],
      comments: [{ body: buildReconcileFindingBody(buildConflictFindingBody({ num: 8801, headRefName: 'lane/9099-conflict-fixture' })) }],
      body: prBody,
    };

    const plan = planReconcile({ prs: [bounced], agents: [], durableCounts: {}, now: 0 });
    expect(plan.refusals).toEqual([]);
    expect(plan.dispatch).toHaveLength(1);
    expect(plan.dispatch[0].kind).toBe('fix');
    expect(plan.dispatch[0].labels).toContain(CONFLICT_LABEL);
    expect(plan.dispatch[0].body).toBe(prBody);

    const item = { num: '9099', slug: 'conflict-fixture', specPath: 'backlog/9099-x.md', scope: ['we:scripts/example-conflicting-module.mjs'] };
    const { planned, refusals } = planFixesFromReconcile(plan.dispatch, (key) => (key === '9099' ? item : null), () => []);
    expect(refusals).toEqual([]);
    expect(planned).toEqual([{
      overlapScope: [], itemNum: '9099', pr: 8801, laneRef: 'lane/9099-conflict-fixture', scope: item.scope, scopeSource: 'item',
      isConflict: true, body: prBody, headRefOid: 'deadbeef'.repeat(5),
      // The planned entry now carries the round count and cap the planner decided on (the resume path reads them).
      attempts: 0, cap: 3,
    }]);
  });

  it('END TO END — a conflict-caused entry with a LIVE, listed original-builder session genuinely RESUMES it, with NO lane ever involved (real spawnAgent/listAgentsAll/stop, fake-cost-nothing CLI)', async () => {
    // `root` must be a REAL, existing directory whose last path segment is not `lane-<N>` (tryResumeFix's own
    // `assertNotALaneCheckout` guard) — `withRealRepo`'s fixture root satisfies both, and doubles as "the
    // checkout the fix agent would actually be dispatched into".
    await withRealRepo(async ({ root, head }) => {
      const fake = withFakeClaude();
      try {
        const env = { ...process.env, ...fake.env };
        // Seed the "original builder" session by actually starting one through the real spawn path — this is
        // the SAME defaultSpawnAgent production code the dispatcher itself calls, not a hand-built fixture row.
        // `cwd: root` is load-bearing beyond the spawn itself: it is also what the SECURITY hardening below
        // resolves a real `git -C <cwd> rev-parse HEAD` against.
        //
        // #3331 — THE SEED'S ID IS READ BACK, NOT CHOSEN. This used to pass `--session-id <a uuid we picked>`
        // and then assert that exact uuid was listed. `claude --bg` discards `--session-id` (the shim now
        // models that), so a chosen id names no session — and production never chose one either: the id
        // `findResumeCandidate` matches on comes off the PR body's `authored-by-actor` stamp, which the AGENT
        // writes from its own real session id. Reading it out of the listing is what that actually looks like.
        defaultSpawnAgent(['--bg', '-n', 'fix-8801', 'original build work'], { env, cwd: root });
        const listedBefore = defaultListAgents({ env, all: true });
        const seeded = listedBefore.find((a) => a.name === 'fix-8801');
        expect(seeded).toBeTruthy();
        const originalSessionId = seeded.sessionId;

        const authorMarker = buildAuthorActorMarker(originalSessionId);
        // #xazl9u3 — deliberately NO `lane` field: `tryResumeFix` runs BEFORE any lane is ever popped from the
        // free-lane pool, so a planned entry at this stage never carries one.
        const planned = {
          itemNum: '9099', pr: 8801, laneRef: 'lane/9099-conflict-fixture',
          scope: ['we:scripts/example-conflicting-module.mjs'],
          isConflict: true, body: `Original PR description.\n\n${authorMarker}\n`,
          // The REAL fixture repo's own current HEAD — proving the security-hardening ownership check
          // (`resolveLaneHead` against `planned.headRefOid`) with NO stub: `tryResumeFix`'s default `resolveHead`
          // runs a genuine `git -C <cwd> rev-parse HEAD` against `root` and must find this exact value.
          headRefOid: head(),
        };

        // `tryResumeFix` itself calls `listAgentsAll()` again AFTER the resume spawn (to confirm the outcome),
        // so `fake.lastArgv()` by the time it RETURNS would read that follow-up `agents` call, not the spawn.
        // Captured here instead, at the moment it happens.
        let resumeArgvSeen = null;
        const attempt = tryResumeFix(planned, {
          root,
          spawnAgent: (argv, opts) => { resumeArgvSeen = argv; return defaultSpawnAgent(argv, { ...opts, env }); },
          listAgentsAll: () => defaultListAgents({ env, all: true }),
          // resolveHead is NOT injected here — the REAL default (`resolveLaneHead`, a genuine `git -C <cwd>
          // rev-parse HEAD`) runs against the real fixture repo, proving the ownership check for real.
          // Never expected to fire on this (successful-resume) path — wired to the REAL stopSession anyway so
          // a regression that DID reach it would exercise real code, not silently no-op.
          stop: ({ handle }) => stopSession({ handle, exec: (cmd, a, o) => execFileSync(cmd, a, { ...o, env }) }),
        });

        expect(attempt.resumed).toBe(true);
        expect(attempt.result.sessionId).toBe(originalSessionId);
        expect(attempt.result.lane).toBeNull(); // #xazl9u3 — a genuine resume never carries a lane at all.

        // The ORIGINAL session is still there — a genuine resume, not stop-then-refork.
        const listedAfter = defaultListAgents({ env, all: true });
        expect(listedAfter.filter((a) => a.sessionId === originalSessionId)).toHaveLength(1);
        // The resume's own argv, as the fake CLI actually received it: bare, no -n/systemPromptFile/extraArgs.
        expect(resumeArgvSeen).toEqual(['--bg', '--resume', originalSessionId, expect.stringContaining(`PR #${planned.pr}`)]);
      } finally {
        fake.cleanup();
      }
    });
  });

  it('END TO END — a conflict-caused entry with NO resume candidate (no author stamp) reports `resumed: false` from `tryResumeFix`, and the caller\'s REAL fresh `dispatchFix` then completes it', async () => {
    await withRealRepo(async ({ root }) => {
      const fake = withFakeClaude();
      try {
        const env = { ...process.env, ...fake.env };
        const planned = {
          itemNum: '9099', pr: 8802, laneRef: 'lane/9099-conflict-fixture-b',
          scope: ['we:scripts/example-conflicting-module.mjs'],
          isConflict: true, body: 'A PR body with no authored-by-actor stamp at all.',
        };

        // First, the SAME lane-free check `runReconcileFixDispatch` runs before ever popping a lane: with no
        // resume candidate at all, it must report `resumed: false` having made no spawn call whatsoever.
        let resumeSpawnCalls = 0;
        const attempt = tryResumeFix(planned, {
          root,
          spawnAgent: () => { resumeSpawnCalls += 1; return ''; },
          listAgentsAll: () => defaultListAgents({ env, all: true }),
        });
        expect(attempt).toEqual({ resumed: false, resumeAttempt: null });
        expect(resumeSpawnCalls).toBe(0);

        // Only NOW — exactly like the real `runReconcileFixDispatch` loop — is a lane assigned and the real
        // fresh dispatch attempted.
        const result = dispatchFix({ ...planned, lane: 13 }, {
          root,
          readBrief: () => FIX_BRIEF_STUB,
          mintSessionId: () => 'ffffffff-0000-0000-0000-000000000000',
          spawnAgent: (argv, opts) => defaultSpawnAgent(argv, { ...opts, env }),
        });

        expect(result.resumed).toBe(false);
        expect(result.sessionId).toBe('ffffffff-0000-0000-0000-000000000000');
        // #3331 — no `--session-id` in the argv, and the ADDRESSABLE id is what the CLI printed back.
        // #3606's missed path (f41f3b32d) — fix dispatch now carries the same standing-identity system
        // prompt review-dispatch already had, so the argv gains `--append-system-prompt-file` too.
        // xgqz204 — every dispatch also carries the worker marker via `--settings`, plus the
        // bg-isolation override every dispatch path now applies (isolateDispatchSession).
        expect(fake.lastArgv()).toEqual([
          '--bg', '-n', 'fix-8802',
          '--settings', JSON.stringify({ env: { WE_CONVEYOR_WORKER: '1' }, worktree: { bgIsolation: 'none' } }),
          '--append-system-prompt-file', DISPATCHED_AGENT_SYSTEM_PROMPT_FILE,
          // WE routing policy — every fresh launch also carries an explicit per-operation --effort (fix → high).
          '--effort', 'high',
          // Operator rule 2026-09-29 — every fresh launch carries an explicit --model (fix → sonnet).
          '--model', 'sonnet',
          expect.stringContaining('fix brief for 8802'),
        ]);
        expect(result.agentId).toBeTruthy();
        const listed = defaultListAgents({ env, all: true });
        // The minted uuid names NOTHING — that is the defect this pins — while `agentId` names the real row.
        expect(listed.some((a) => a.sessionId === 'ffffffff-0000-0000-0000-000000000000')).toBe(false);
        expect(listed.some((a) => a.id === result.agentId && a.name === 'fix-8802')).toBe(true);
      } finally {
        fake.cleanup();
      }
    });
  });
});
