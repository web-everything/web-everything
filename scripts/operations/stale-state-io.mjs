/**
 * @file scripts/operations/stale-state-io.mjs
 * @description Injected read-only inventory over lane status, the claim reader and run store.
 * No acquire/list --acquirable (both can reap), sinks, fetch or persistent telemetry.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createClaimReader, REPO_ROOT } from './claim-io.mjs';
import { createFileRunStore } from './run-store.mjs';
import { idFromName } from '../backlog/id.mjs';
import { readField } from '../backlog/frontmatter.mjs';
import { cachedLaneScan } from '../lib/health-watch-lane-scan.mjs';
import { laneGitEnv } from '../lib/git-transport-branch.mjs';
import { hardenLaneGitArgs, laneGitHardeningEnv } from '../lib/lane-git-hardening.mjs';
import { probePid } from '../conveyor/reconcile-pass.mjs';

/** Bind external reads, including subprocesses and clock, for fixture-only tests. */
export function createStaleStateReader({
  root = REPO_ROOT, run = execFileSync,
  listFiles = (dir) => readdirSync(dir),
  readText = (path) => readFileSync(path, 'utf8'),
  readClaim, runStore = createFileRunStore(), probe = probePid,
  now = Date.now, host = hostname(), laneScan,
} = {}) {
  // Propagates to lane-pool's git children too: status must not refresh the index.
  const exec = (bin, argv, opts = {}) => run(bin, argv, {
    ...opts, env: { ...laneGitEnv(opts.cwd ?? root), GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
  });
  // A lane's own .git/config is untrusted: any git run inside one gets the repo's lane hardening, like freshLaneSafety.
  const laneGit = (argv, cwd) => run('git', hardenLaneGitArgs(argv), {
    cwd, env: { ...laneGitHardeningEnv(laneGitEnv(cwd)), GIT_CONFIG_NOSYSTEM: '1', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
  });
  return () => {
    const observedAt = new Date(now()).toISOString();
    const records = [];
    const gaps = [
      'Scope: this checkout backlog, its repository lane pool, and the configured operation run store.',
      'Lease pid identifies the acquire CLI, not the owner; owner liveness needs a same-host agentPid.',
      'Work safety is best-effort against local origin refs, without fetching; false is not cleanup authorization.',
      'Claims and run records may lack owner, pid, or timestamps; missing evidence remains null/unknown.',
    ];
    const observe = (pid, recordHost) => {
      if (!Number.isInteger(pid) || pid <= 0 || (recordHost && recordHost !== host)) return { checked: false, alive: null };
      try { return { checked: true, alive: probe(pid) }; }
      catch { return { checked: true, alive: null }; }
    };
    const add = (kind, id, data, timestamp, extra = {}) => {
      const recorded = observe(data.pid, data.host);
      const ownerPid = kind === 'lane-lease' ? data.agentPid : data.pid;
      const owner = ownerPid === data.pid ? recorded : observe(ownerPid, data.host);
      const stamp = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
      records.push({
        kind, id, owner: data.owner ?? null, pid: data.pid ?? null,
        pidChecked: recorded.checked, pidAlive: recorded.alive, observedAt,
        ownerPid: ownerPid ?? null, ownerPidChecked: owner.checked, ownerPidAlive: owner.alive,
        ageMs: Number.isFinite(stamp) ? Math.max(0, Date.parse(observedAt) - stamp) : null,
        ageFrom: timestamp ?? null, hasUnsafeWork: null, ...extra,
      });
    };
    try {
      const scan = () => {
        const status = JSON.parse(exec(process.execPath, [join(root, 'scripts/lane-pool.mjs'), 'status', '--json'], { cwd: root }));
        if (!Array.isArray(status.lanes)) throw new Error('status returned no lanes array');
        return status.lanes.map(lane => {
          let ahead = null;
          if (!lane.readError && lane.lease) {
            try {
              // Behind cannot detect unpushed commits. Count commits absent from local origin refs.
              const raw = String(laneGit(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'], lane.path)).trim();
              if (/^\d+$/.test(raw)) ahead = Number(raw);
            } catch { /* unknown, never zero */ }
          }
          return { lane, ahead };
        });
      };
      const lanes = laneScan ? cachedLaneScan(scan, { ...laneScan, root, now: now() }) : scan();
      const cachedRow = lanes.find(row => Number.isFinite(row?.cachedAt));
      if (cachedRow) gaps.push(`lane-lease work safety is from the lane-scan cache (${new Date(cachedRow.cachedAt).toISOString()}): reporting only, never safe; a destructive lane action needs a fresh check (health-watch-lane-scan.mjs#guardLaneAction).`);
      for (const { lane, ahead, cachedAt } of lanes) {
        const fromCache = Number.isFinite(cachedAt);
        if (lane.readError) {
          add('lane-lease', lane.path, {}, null, { lane, readError: lane.readError });
          continue;
        }
        if (!lane.lease) continue; // include raw expired leases regardless of `leased`
        const lease = lane.lease;
        const computed = lane.clean === false || (ahead !== null && ahead > 0) ? true
          : lane.clean === true && ahead === 0 ? false : null;
        // A cached row is reporting only: cached unsafe stays unsafe, cached safe/unknown is reported unknown. Acting
        // on a lane needs health-watch-lane-scan.mjs#guardLaneAction's fresh check, never this field.
        const hasUnsafeWork = fromCache ? (computed === true ? true : null) : computed;
        add('lane-lease', lane.path, {
          ...lease, owner: lease.workerSession ?? lease.ownerSession ?? lease.session ?? lease.holder,
        }, lease.acquiredAt, { hasUnsafeWork,
          safety: { source: fromCache ? 'cache' : 'fresh', observedAt: fromCache ? new Date(cachedAt).toISOString() : observedAt,
            cachedHasUnsafeWork: fromCache ? computed : null },
          lane: { ...lane, ahead }, lease });
      }
    } catch (error) { gaps.push(`lane-lease enumeration failed: ${error.message}`); }
    try {
      const files = listFiles(join(root, 'backlog')).filter((file) => file.endsWith('.md') && idFromName(file));
      const claimReader = readClaim ?? createClaimReader({ root, listFiles: () => files, readText, exec });
      for (const file of files) {
        const id = idFromName(file);
        try {
          const content = readText(join(root, 'backlog', file));
          if (!['active', 'preparing'].includes(readField(content, 'status'))) continue;
          const claim = claimReader({ ref: id });
          if (!claim?.found) throw new Error('claim no longer resolves');
          if (!['active', 'preparing'].includes(claim.status)) continue;
          const field = (name) => readField(claim.content, name) || null;
          const rawPid = field('pid');
          add('claim', id, {
            owner: field('claimedBy') ?? field('scaffoldedBy') ?? field('session'),
            pid: rawPid && /^\d+$/.test(rawPid) ? Number(rawPid) : rawPid, host: field('host'),
          }, field('dateStarted') ?? field('dateScaffolded'), { path: claim.rel, status: claim.status });
        } catch (error) {
          add('claim', id, {}, null, { path: `backlog/${file}`, error: error.message });
          gaps.push(`claim ${id} unreadable: ${error.message}`);
        }
      }
    } catch (error) { gaps.push(`claim enumeration failed: ${error.message}`); }
    try {
      for (const id of runStore.list()) {
        try {
          const record = runStore.read(id);
          if (!record) throw new Error('record disappeared during inventory');
          add('session-run', id, {
            pid: record.pid, host: record.host, owner: record.owner ?? record.sessionId ?? null,
          }, record.stepTimings?.[0]?.startedAt, {
            op: record.op, pending: record.pending, effects: record.effects,
            sessions: (record.telemetry ?? []).map((row) => row.sessionId).filter(Boolean),
          });
        } catch (error) {
          add('session-run', id, {}, null, { error: error.message });
          gaps.push(`session-run ${id} unreadable: ${error.message}`);
        }
      }
    } catch (error) { gaps.push(`session-run enumeration failed: ${error.message}`); }
    return { observedAt, records, gaps };
  };
}
