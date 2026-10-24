/**
 * @file pr-sweep-unhealthy-owner-and-symlink-entry.mjs
 * @description PR #5323 red-team replay: unhealthy owners/refusals mask stalls, cross-repo logs misbind, symlink launches skip entry points.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
import { collectOwnerSignals, runPrSweep } from '../../pr-sweep.mjs';
import { publishStalledDigest } from '../../pr-stall-digest.mjs';
import { replay } from '../../../operations/needs-you-feed.mjs';

const CONVEYOR = fileURLToPath(new URL('../../', import.meta.url));
export default {
  id: 'pr-sweep-unhealthy-owner-and-symlink-entry',
  title: 'unhealthy sessions and refusals must not mask stalls, qualified logs must bind their repo, and symlink entry points must run',
  card: 'PR #5323 post-accept red-team findings',
  fixedBy: { sha: 'PR #5323 repair', where: 'lane/pr-sweep-health-job', paths: [
    'scripts/conveyor/pr-sweep-core.mjs', 'scripts/conveyor/pr-sweep-job.mjs', 'scripts/conveyor/pr-sweep.mjs', 'scripts/conveyor/health-watch.mjs',
  ] },
  fixPresent(root) {
    return ['pr-sweep-core.mjs', 'pr-sweep-job.mjs', 'pr-sweep.mjs', 'health-watch.mjs'].every((name) => {
      const source = readFileSync(join(root, 'scripts/conveyor', name), 'utf8');
      return name === 'pr-sweep-core.mjs' ? source.includes('sessionActivity(a, now') && source.includes('a.pidAlive === true') && source.includes("d.kind !== 'refusal'")
        : source.includes('realpathSync(argv1)') && (name !== 'pr-sweep.mjs' || source.includes('String(text).matchAll'));
    });
  },
  async run({ log } = {}) {
    const violations = []; const owners = []; const entries = []; const refusals = []; const bindings = []; const progress = [];
    const now = Date.parse('2026-10-14T16:00:00Z');
    const repo = CONSTELLATION_REPOS.we.slug; const key = `${repo}#12`;
    // Model an explicitly unlabelled PR; missing labels are unreadable to the stall detector.
    const pr = { repo, number: 12, title: 'idle PR', updatedAt: new Date(now - 120 * 60000).toISOString(), headRefOid: 'abc', labels: [] };
    const value = { idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90, dispatchDiagnosis: false, repos: [repo] };
    const plateau = { ...pr, repo: CONSTELLATION_REPOS['plateau-app'].slug };
    const collector = (args, { line = '', health = {}, name = 'fix-dispatch-daemon.log' } = {}) => collectOwnerSignals({ ...args,
      readAgents: () => [], cloneRoots: () => ['/workspace/fix-clone'], listLogs: () => [name],
      readTail: () => line, readHealth: () => health });
    for (const source of ['health', 'log', 'review-not-started', 'review-pending', 'review-failed', 'scope-rank', 'note', 'note-comment', 'unknown']) {
      let previous = {}; let alertCount = 0; const samples = [];
      for (const minutes of [0, 30, 60, 90, 120, 240, 1440]) {
        const tick = now + minutes * 60000;
        const line = {
          log: `reconcile-fix-dispatch-daemon: refused no-lane ${repo} PR #12 — no acquirable lane`,
          'review-not-started': `review-daemon: ${repo}#12 not dispatched — no acquirable lane`,
          'review-pending': `review-daemon: ${repo}#12 review:pending, no review dispatched — no acquirable lane`,
          'review-failed': `review-daemon: ${repo}#12 failed (non-fatal): no lane`,
          'scope-rank': `reconcile-fix-dispatch-daemon: scope-rank ${repo} PR #12 — rank 1, blocks 0, age 2h`,
          note: `reconcile-fix-dispatch-daemon: note awaiting-permission ${repo} PR #12 — no work started`,
          'note-comment': `reconcile-fix-dispatch-daemon: note-comment awaiting-permission ${repo} PR #12 — already posted, skipping`,
          unknown: `reconcile-fix-dispatch-daemon: observed ${repo} PR #12`,
        }[source];
        const report = await runPrSweep({ now: tick, dryRun: true, config: {}, settings: { value, sources: {} },
          readPrevious: () => previous, readPrs: () => [pr], readQueue: () => ({ ready: [], rulingNeeded: [] }),
          readSignals: (args) => collector(args, source === 'health'
            ? { health: { daemons: { 'fix-dispatch-daemon': { prRefusals: { 'we#12': { at: tick, reason: 'refused no-lane: no acquirable lane' } } } } } }
            : { line: `${new Date(tick).toISOString()} ${line}${source === 'scope-rank' ? `\n${new Date(tick).toISOString()} reconcile-fix-dispatch-daemon: refused no-lane ${repo} PR #12 — no acquirable lane` : ''}`, name: source.startsWith('review-') ? 'review-daemon.log' : 'fix-dispatch-daemon.log' }) });
        previous = report.nextState; alertCount += report.alerts.length;
        samples.push({ minutes, state: report.idle[0].state, alerts: report.alerts.length, errors: report.errors });
      }
      refusals.push({ source, alertCount, samples });
      if (alertCount !== 1 || samples.some((s) => s.state !== 'none' || s.errors.length)) {
        violations.push({ invariant: 'dispatch-refusal-masks-stall', detail: JSON.stringify(refusals.at(-1)) });
      }
    }
    for (const ref of [`${plateau.repo}#12`, `${plateau.repo} PR #12`, `https://github.com/${plateau.repo}/pull/12`]) {
      const errors = [];
      const signals = await collector({ prs: [pr, plateau], dir: tmpdir(), env: {}, errors }, {
        line: `${new Date(now - 1000).toISOString()} reconcile-fix-dispatch-daemon: refused no-lane ${ref} — no acquirable lane`,
      });
      bindings.push({ ref, we: signals[key].daemons.length, plateau: signals[`${plateau.repo}#12`].daemons.length, errors });
      if (bindings.at(-1).we !== 0 || bindings.at(-1).plateau !== 1 || errors.length) {
        violations.push({ invariant: 'qualified-ref-cross-binds', detail: JSON.stringify(bindings.at(-1)) });
      }
    }
    for (const [ageMinutes, state] of [[1, 'active'], [100, 'stuck']]) {
      const at = new Date(now - ageMinutes * 60000).toISOString();
      const report = await runPrSweep({ now, dryRun: true, config: {}, settings: { value, sources: {} },
        readPrevious: () => ({}), readPrs: () => [pr], readQueue: () => ({ ready: [], rulingNeeded: [] }),
        readSignals: (args) => collector(args, { name: 'review-daemon.log',
          line: `${at} review-daemon: ${repo}#12 dispatched as session\n${new Date(now).toISOString()} review-daemon: ${repo}#12 not dispatched — no acquirable lane` }) });
      const owner = report.idle[0]; progress.push({ ageMinutes, state: owner.state, at: owner.ownerLastSeenAt });
      if (owner.state !== state || owner.ownerLastSeenAt !== at || report.errors.length) {
        violations.push({ invariant: 'diagnostic-hides-real-progress', detail: JSON.stringify(progress.at(-1)) });
      }
    }
    // Operator send-back: finished fixers stay listed idle/offline/blocked with a live (recycled) pid.
    for (const health of [{ hung: true }, { pidAlive: false }, { hung: true, pidAlive: false },
      { status: 'idle', pidAlive: true }, { status: 'offline', pidAlive: true }, { state: 'blocked', status: 'idle', pidAlive: true },
      { state: undefined, status: 'waiting', pidAlive: true }, { status: 'busy' }]) {
      let previous = {}; const samples = []; let alertCount = 0;
      for (const minutes of [0, 30, 60, 90, 120, 240]) {
        const tick = now + minutes * 60000;
        const report = await runPrSweep({ now: tick, dryRun: true, config: {},
          settings: { value, sources: {} }, readPrevious: () => previous, readPrs: () => [pr],
          readQueue: () => ({ ready: [], rulingNeeded: [] }),
          readSignals: () => ({ [key]: { sessions: [{ name: 'fix-12', state: 'working', lastActivityAt: tick - 60000, ...health }] } }) });
        previous = report.nextState; alertCount += report.alerts.length;
        samples.push({ minutes, state: report.idle[0].state, episodes: Object.keys(previous.episodes).length, alerts: report.alerts.length });
      }
      owners.push({ health, samples, alertCount });
      if (alertCount !== 1 || samples.some((s) => s.state !== 'none' || s.episodes !== 1)) {
        violations.push({ invariant: 'unhealthy-owner-masks-stall', detail: JSON.stringify(owners.at(-1)) });
      }
    }
    const root = mkdtempSync(join(tmpdir(), 'soak-pr-sweep-entry-'));
    try {
      // PR #5856: health refusals use numeric clocks. Hidden sweep output must not suppress a detector event.
      const prefs = join(root, 'preferences.json'); writeFileSync(prefs, '{}');
      const head = 'abcdef0123'.repeat(4), label = 'red-team:pending';
      const stalledPr = { ...pr, headRefOid: head, labels: [label] };
      const clock = `${key}@${head}|${label}`;
      const detectorEnv = { WE_PLATFORM_PREFERENCES_FILE: prefs, WE_PR_STALL_DETECTOR_ENABLED: 'true',
        WE_PR_STALL_DETECTOR_SAME_LABEL_MINUTES: '60', WE_PR_STALL_DETECTOR_REPEATED_REASON_COUNT: '5' };
      for (const [mode, digest] of [['off', false], ['off', true], ['shadow', false], ['on', false], ['shadow', true], ['on', true]]) {
        const stateDir = join(root, `${mode}-${digest}`, 'digest'), feedPath = join(root, `${mode}-${digest}`, 'events.jsonl');
        let previous = { stallDetector: { [clock]: now - 90 * 60000 } }, notifications = 0;
        for (const offset of [0, 60000]) {
          const tick = now + offset;
          const report = await runPrSweep({ now: tick, env: detectorEnv, config: {}, settings: { value, sources: {} },
            readPrevious: () => previous, readPrs: () => [stalledPr], readQueue: () => ({ ready: [], rulingNeeded: [] }),
            readSignals: args => collector(args, { health: { daemons: { 'fix-dispatch-daemon': {
              prRefusals: { 'we#12': { at: tick, reason: 'already-reviewed-head: referral hold auto-resolved' } },
            } } } }),
            flush: () => ({}), append: () => {}, persist: () => {}, notify: () => { notifications++; return { ok: true }; },
            stallSweep: async () => ({ mode, digest, state: {}, dir: stateDir, items: [
              { lane: 'operator', repo, pr: 12, head: head.toUpperCase(), state: 'needs-decision:note' },
            ] }),
            stallDigest: (pass, options) => {
              if ((mode === 'off' || !digest) && (pass.items.length !== 1 || pass.items[0].action !== 'stalled-detector')) {
                violations.push({ invariant: 'hidden-sweep-suppresses-detector', detail: `${mode}/${digest}` });
              }
              return publishStalledDigest(pass, { ...options, feedPath });
            } });
          previous = report.nextState;
          if (report.errors.length || report.stallDetector?.stalled !== 1 || previous.stallDetector[clock] !== now - 90 * 60000) {
            violations.push({ invariant: 'numeric-refusal-drops-stalled-pr', detail: JSON.stringify({ mode, digest, errors: report.errors }) });
          }
        }
        const events = replay({ path: feedPath });
        if (events.length !== 1 || events[0]?.kind !== 'stalled' || notifications !== 1) {
          violations.push({ invariant: 'same-head-publication-count', detail: JSON.stringify({ mode, digest, events, notifications }) });
        }
      }
      // PR #5856 round 2: retained PR-level refusals cannot age a newly pushed head;
      // progress must filter every reason group before choosing the current repetition.
      const oldLines = Array.from({ length: 10 }, (_, i) =>
        `[${new Date(now - (55 - i) * 60000).toISOString()}] review-daemon: ${repo}#12 not dispatched — old refusal`).join('\n');
      for (const variant of ['moved-head', 'post-progress', 'agents-offline']) {
        const currentHead = variant === 'moved-head' ? 'b'.repeat(40) : head;
        const currentClock = `${key}@${currentHead}|${label}`;
        const recentLines = Array.from({ length: 6 }, (_, i) =>
          `[${new Date(now - (18 - i) * 60000).toISOString()}] review-daemon: ${repo}#12 not dispatched — current refusal`).join('\n');
        const line = variant === 'post-progress' ? `${oldLines}\n[${new Date(now - 20 * 60000).toISOString()}] review-daemon: ${repo}#12 dispatched as session\n${recentLines}` : oldLines;
        const saved = variant === 'post-progress' ? now - 59 * 60000 : now - 90 * 60000;
        const report = await runPrSweep({ now, dryRun: true, env: detectorEnv, config: {}, settings: { value, sources: {} },
          readPrevious: () => ({ stallDetector: { [clock]: saved } }),
          readPrs: () => [{ ...stalledPr, headRefOid: currentHead }], readQueue: () => ({ ready: [], rulingNeeded: [] }),
          readSignals: args => collectOwnerSignals({ ...args, readAgents: () => {
            if (variant === 'agents-offline') throw new Error('agent listing unavailable'); return [];
          }, readHealth: () => ({}), cloneRoots: () => ['fixture-clone'], listLogs: () => ['review-daemon.log'], readTail: () => line }) });
        const item = report.stallDetector?.items?.[0];
        if (variant === 'moved-head' ? report.stallDetector?.stalled !== 0 || report.nextState.stallDetector[currentClock] !== now
          : variant === 'post-progress' ? item?.repeatCount !== 6 || !item?.repeatingReason.includes('current refusal')
            : report.stallDetector?.stalled !== 1) {
          violations.push({ invariant: `detector-${variant}`, detail: JSON.stringify(report.stallDetector) });
        }
      }
      const alias = join(root, 'conveyor-link'); symlinkSync(CONVEYOR, alias, 'dir');
      const env = { ...process.env, NODE_NO_WARNINGS: '1' };
      for (const key of ['DAEMON_JOB_ID', 'DAEMON_JOB_ATTEMPT', 'OPERATION_RUNS_DIR']) delete env[key];
      const invoke = (path) => spawnSync(process.execPath, [path, 'invalid-command'], { env, encoding: 'utf8', timeout: 15000 });
      for (const [script, expected] of [['pr-sweep-job.mjs', 1], ['pr-sweep.mjs', 2], ['health-watch.mjs', 1]]) {
        const path = join(alias, script); const direct = invoke(realpathSync(path)); const linked = invoke(path);
        entries.push({ script, direct: direct.status, linked: linked.status });
        if (direct.error || linked.error || direct.status !== expected || linked.status !== expected || direct.stdout !== linked.stdout || direct.stderr !== linked.stderr) {
          violations.push({ invariant: 'symlink-entry-skipped', detail: JSON.stringify(entries.at(-1)) });
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
    const report = { violations, owners, entries, refusals, bindings, progress }; log?.(JSON.stringify(report)); return report;
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
