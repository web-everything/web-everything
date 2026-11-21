/**
 * @file breaks/lease-reaper-hand-briefed-owner-invisible.mjs — live break, confirmed 2026-09-28 (still unfixed on
 * `main`), fixed by we:backlog/4371-lease-reaper-session-gone-axis-reaps-hand-briefed.md (PR body carries the
 * item number; the card itself is filed on PR #2863, not yet on `main` at the time this break was written).
 *
 * LIVE INCIDENT. A delivery agent started BY HAND — an in-process Agent-tool subagent following
 * `we:skills-src/conveyor/delivery-agent-brief.md` directly, never `claude --bg` — still acquires its lane with
 * `--session=conveyor-<N>`, because that is the ONLY grammar `we:scripts/conveyor/lease-reaper.mjs#itemNumFromSession`
 * (and the dispatch observer) recognize. `sessionGoneForLease` then looks THAT exact name up in
 * `claude agents --json --all` — and an in-process subagent is never listed there under its own manufactured
 * name; only its OWNING interactive session is (a real `claude agents` row, `kind: 'interactive'`, keyed by
 * `sessionId`). Once the 10-minute listing-visibility grace window passes, the reaper read "never listed" as
 * "gone" and force-released the lease while the agent was still working — measured live across ~10 lanes in one
 * evening (lane-18, lane-5, lane-12, lane-13, lane-14, lane-16, lane-17, lane-20, lane-21, lane-22; lane-21 four
 * times as its worker kept re-acquiring), with the SAME lease's `workerSession` independently confirmed live at
 * the exact same moment by the reclaim `--salvage` gate's own `liveAgentInLane` check ("owning session is still
 * live (claude agents)") — the reaper and the reclaim gate disagreed about the SAME lease's liveness.
 *
 * FIX (#4371): in the ABSENCE branch only — never overriding a direct death signal about the lease's own
 * tracked session (a listed terminal state, or a real `pidAlive === false` read) — check the lease's declared
 * occupant, `workerSession` (never `ownerSession`, the dispatcher's own long-lived id — see
 * `ownerSessionAliveForLease`'s own doc for why that would be a DIFFERENT, worse bug), against the SAME listing
 * via `ownerSessionAliveForLease`, REUSING (not re-deriving) the reclaim gate's own `liveAgentInLane`
 * (`lib/lane-salvage.mjs`).
 *
 * SCENARIO (no daemon tick loop — this incident lives in the RESIDENT `lease-reaper.mjs --dry-run` pass, same
 * shape as this file's own sibling `lease-reaper-merge-commit-blind-spot.mjs`; `daemons: []`). ONE throwaway
 * `LANE_POOL_ROOT` pool named `web-everything`, `--no-check-prs` (this incident is entirely on the session-gone
 * axis, not the PR-terminal one), a fake `claude` answering `agents --json --all` with TWO rows: the
 * hand-briefed agent's OWNING interactive session (listed and live, under NEITHER lease's own dispatcher-grammar
 * `session` name — the whole point: an in-process subagent is never listed under its own name) plus one
 * unrelated `background` row that exists ONLY to keep the session-gone axis itself from degrading OFF (a listing
 * with zero background rows reads as "indistinguishable from a bad read" — #1921 — which would make this
 * scenario prove nothing either way; see the `setup` comment below):
 *   - **lane-1 (the incident)**: session `conveyor-9401` (a real, hand-briefed delivery agent's own acquire
 *     name), `workerSession: 'owner-session-abc123'` (stamped by `--adopt`, the SAME field the reclaim gate's
 *     own `liveAgentInLane` already reads), acquired 30 minutes ago — comfortably past the 10-minute grace
 *     window, nowhere near the 240-minute TTL. `owner-session-abc123` IS the fake listing's one live interactive
 *     row.
 *   - **lane-2 (the control)**: session `conveyor-9402`, NO `workerSession`/`ownerSession` recorded at all (a
 *     genuinely dead lease — no owning session to check) — must still reap exactly as before this fix, proving
 *     the fix changes nothing for the population it isn't for.
 *
 * RED (pre-fix): lane-1 IS in `wouldReap` (`reason: 'session-gone'`) — its live owner is invisible to the
 * pre-fix code, which only ever looked up the lease's own `session` name. Lane-2 is ALSO reaped (unaffected).
 * GREEN (post-fix): lane-1 is NOT reaped (stays `kept` — `ownerAlive` wins). Lane-2 IS STILL reaped (no
 * regression on a genuinely dead, unowned lease).
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSoak } from '../soak.mjs';
import { readGit } from '../../../lib/proc-read.mjs';

const MIN = 60_000;
const ACQUIRED_MIN_AGO = 30; // past the 10-minute listing-visibility grace window, nowhere near the 240min TTL

function writeLease(dir, lease) {
  mkdirSync(dir, { recursive: true });
  // A bare .git directory is unreadable evidence to the reclaim-safety gate.
  // Both controls need readable, clean trees so only session liveness keeps lane-1.
  const options = { cwd: dir, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: 'pipe' };
  readGit(['init', '--quiet', '--initial-branch=main'], options);
  if (readGit(['status', '--porcelain', '--untracked-files=all'], options) !== '') {
    throw new Error('lease-reaper fixture must start with a clean worktree');
  }
  writeFileSync(join(dir, '.git', '.lane-lease'), `${JSON.stringify(lease, null, 2)}\n`);
}

/** A fake `claude` answering ANY invocation (`agents --json --all` included) with a fixed listing — see `setup`
 *  below for what it carries and why. */
function fakeClaudeBin(root, agentsListing) {
  const bin = join(root, 'fakebin');
  mkdirSync(bin, { recursive: true });
  const claude = join(bin, 'claude');
  writeFileSync(claude, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(agentsListing)}\nJSON\n`);
  chmodSync(claude, 0o755);
  return bin;
}

export default {
  id: 'lease-reaper-hand-briefed-owner-invisible',
  title: "the resident lease-reaper's session-gone axis only ever looks up a lease's OWN dispatcher-grammar session name — a hand-briefed (in-process Agent-tool) delivery agent's owning interactive session is never listed under that name, so its still-live lease gets force-released once the 10-minute listing-visibility grace window passes",
  card: 'we:backlog/4371 (PR #2863 files the card; not yet on main)',
  fixedBy: {
    sha: 'PENDING-FILL-AT-LAND',
    where: 'main',
    paths: ['scripts/conveyor/lease-reaper.mjs'],
  },
  fixPresent(root) {
    try {
      const src = readFileSync(join(root, 'scripts/conveyor/lease-reaper.mjs'), 'utf8');
      return /export function ownerSessionAliveForLease/.test(src) && /ownerAlive === true\) return false/.test(src);
    } catch {
      return false;
    }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:lease-reaper-hand-briefed-owner-invisible',
      rounds: 1,
      daemons: [], // the incident lives in the RESIDENT lease-reaper pass, not a review/fix-dispatch/drain tick.
      mainEvery: 0,
      fleet: false,
      scorecards: false,
      junkInCwd: false,
      log,
      setup(w) {
        const base = mkdtempSync(join(tmpdir(), 'we-soak-lease-handbriefed-'));
        const poolRoot = join(base, 'pool');
        const poolDir = join(poolRoot, 'web-everything'); // repoKeyForDir('web-everything') === 'we'
        mkdirSync(poolDir, { recursive: true });

        const acquiredAt = new Date(Date.now() - ACQUIRED_MIN_AGO * MIN).toISOString();
        // lane-1: the incident — a hand-briefed delivery agent, adopted (`--adopt`), whose OWNING interactive
        // session is genuinely live but never listed under the lease's own `session` name.
        writeLease(join(poolDir, 'lane-1'), {
          session: 'conveyor-9401',
          workerSession: 'owner-session-abc123',
          ownerSession: 'owner-session-abc123',
          acquiredAt,
          ttlMinutes: 240,
          purpose: 'conveyor-delivery',
        });
        // lane-2: the control — a genuinely dead lease with no owning session recorded at all. Must still reap.
        writeLease(join(poolDir, 'lane-2'), {
          session: 'conveyor-9402',
          acquiredAt,
          ttlMinutes: 240,
          purpose: 'conveyor-delivery',
        });

        // The fake listing carries the OWNING interactive session (matching lane-1's `workerSession` by
        // `sessionId` — never lane-1's or lane-2's own `session` name, the entire point: an in-process subagent
        // is never listed under its own name) PLUS one unrelated background row, so `sessionStatesForReap`
        // reduces to a non-empty Map and the session-gone axis stays ON (a listing with ZERO background rows
        // degrades to axis-off — #1921 — which would make this scenario prove nothing either way).
        const agentsListing = [
          { kind: 'interactive', sessionId: 'owner-session-abc123', cwd: '/Users/soak/webeverything', status: 'busy', startedAt: Date.now() - 60 * MIN },
          { kind: 'background', name: 'conveyor-1', sessionId: 'unrelated-bg-session', state: 'working', cwd: '/Users/soak/webeverything', startedAt: Date.now() - 60 * MIN },
        ];
        const binDir = fakeClaudeBin(base, agentsListing);

        return { base, poolRoot, binDir, checked: false };
      },
      perRound(w, round, ctx, api) {
        try {
          const script = join(w.simCloneRoot, 'scripts/conveyor/lease-reaper.mjs');
          const env = { ...process.env, ...w.env, LANE_POOL_ROOT: ctx.poolRoot, PATH: `${ctx.binDir}:${process.env.PATH}` };
          const r = spawnSync('node', [script, '--dry-run', '--json', '--no-check-prs'], { encoding: 'utf8', env, timeout: 20_000 });
          ctx.checked = true;
          let report = null;
          try { report = JSON.parse(r.stdout); } catch { /* fall through — reported as scenario-ran below */ }
          if (!report) {
            api.violation('scenario-ran', `lease-reaper --dry-run --json produced no parseable output (exit ${r.status}); stderr: ${String(r.stderr || '').split('\n').slice(0, 3).join(' | ')}`);
            return;
          }
          ctx.report = report;
          api.say(`r00 lease-reaper --dry-run: scanned=${report.scanned} wouldReap=${JSON.stringify(report.wouldReap)} kept=${report.kept} sessionAxis=${report.sessionAxis}`);

          if (report.sessionAxis !== 'on') {
            api.violation('scenario-ran', `the session-gone axis was OFF (sessionAxis=${report.sessionAxis}) — the fake \`claude\` was never consulted, so this scenario proves nothing`);
            return;
          }
          const reapedSessions = new Set((report.wouldReap || []).map((c) => c.session));

          if (reapedSessions.has('conveyor-9401')) {
            api.violation('hand-briefed-lease-reaped', "lane-1 (session conveyor-9401)'s owning interactive session (workerSession owner-session-abc123) is listed and live in the fake claude agents --json --all read, yet the lease was reaped as session-gone — a live hand-briefed delivery agent's lane was force-released");
          }
          if (!reapedSessions.has('conveyor-9402')) {
            api.violation('happy-path-regressed', 'lane-2 (session conveyor-9402, a genuinely dead lease with no owning session recorded) was NOT reaped — the fix regressed the case it must not touch');
          }
        } finally {
          rmSync(ctx.base, { recursive: true, force: true });
        }
      },
    });
  },
  judge(report) {
    const OWN = new Set(['hand-briefed-lease-reaped', 'happy-path-regressed', 'scenario-ran']);
    const problems = report.violations.filter((v) => OWN.has(v.invariant)).map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
    if (!report.ctx?.checked) problems.push('[scenario-ran] the resident lease-reaper dry-run pass never ran — this scenario proves nothing');
    return problems;
  },
};
