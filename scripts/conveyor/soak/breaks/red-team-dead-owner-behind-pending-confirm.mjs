/** #6744: a dead running red-team owner must recover behind a quiet pending human confirm. */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'red-team-dead-owner-behind-pending-confirm', title: 'a dead red-team owner redispatches behind a quiet pending human confirm',
  card: '#6744', fixedBy: { sha: '09bf0e46f2', where: 'lane/redteam-dead-owner-unfinished-review-m2',
    paths: ['scripts/lib/drain-red-team-evidence.mjs', 'scripts/lib/review-red-team-on-skip.mjs'] },
  fixPresent: root => ['scripts/lib/drain-red-team-evidence.mjs', 'scripts/lib/review-red-team-on-skip.mjs']
    .every(path => readFileSync(join(root, path), 'utf8').includes('unfinishedReviewException')),
  async run({ sourceRoot = ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-pending-confirm-red-team-'));
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const e = await load('scripts/lib/drain-red-team-evidence.mjs'), r = await load('scripts/lib/review-red-team-on-skip.mjs');
      const runs = await load('scripts/operations/run-store.mjs');
      const { pidNamespace } = await load('scripts/lib/pid-alive.mjs');
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const repo = CONSTELLATION_REPOS.we.slug, pr = 6744, head = 'a'.repeat(40);
      const now = Date.parse('2026-11-13T12:00:00Z'), deadlineMs = 7_200_000, old = new Date(now - 3 * deadlineMs);
      const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_RED_TEAM_STALE_RUN_MS: String(deadlineMs) };
      // The drain reader's default runs dir comes from process.env, never the fixture env: pin it to the fixture's runs.
      const key = { repo, pr, head, env, now, runsDir: env.WE_SHARED_RUNS_DIR }, id = 'review-pr-pending-confirm';
      const run = { ...runs.newRunRecord({ id, op: 'review-pr', input: { repo, pr } }),
        findings: { read: { netBasis: { rev: head }, diffText: '+code', netChangedFiles: ['scripts/example.mjs'] } },
        verdict: { verdict: 'needs-human', humanRequired: true, lensVerdicts: { correctness: 'accept' }, findings: [] },
        pending: { kind: 'confirm', step: 'confirm', stepIndex: 1 }, effects: [],
        stepTimings: [{ step: 'read', stepIndex: 0, startedAt: old.toISOString() }] };
      runs.writeRun(run, env.WE_SHARED_RUNS_DIR);
      const runPath = join(env.WE_SHARED_RUNS_DIR, `${id}.json`);
      utimesSync(runPath, old, old);
      const before = readFileSync(runPath, 'utf8');
      mkdirSync(e.redTeamStatusDir(env), { recursive: true });
      const statusPath = join(e.redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
      // The owner ran on a renamed (foreign) host in this pid namespace and its pid no longer exists. The daemon's
      // own production probe (real kill(0) → ESRCH) must prove that death; nothing below stubs it.
      writeFileSync(statusPath, JSON.stringify({ repo, pr, head, status: 'running', result: null,
        pid: 99999999, host: 'soak-foreign-host', pidNamespace: pidNamespace(), pidStart: old.toISOString(), loopPayload: {} }));
      utimesSync(statusPath, old, old);
      const readWitness = () => e.readRecoveryWitness({ ...key, readScorecards: () => [] });
      const witness = readWitness(), setting = { enabled: true, retryCooldownMin: 30 };
      const rawPr = { number: pr, headRefOid: head, comments: [], reviews: [], labels: [] };
      const calls = [], forbidden = [], lines = [];
      const refuse = name => (...args) => { forbidden.push(name); return name === 'escalate' ? undefined : { ok: false, args }; };
      // Drive the daemon's red-team runner itself: plan, abandon the dead owner, then dispatch. Every external IO is
      // injected (this runs outside vitest under red-green.mjs, where the defaults would reach GitHub).
      const out = r.runRedTeamOnSkip({ repo, env, setting, plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
        rawPrs: [rawPr], capacity: { lanes: 1 }, now: () => now, lastDispatch: new Map(), log: line => lines.push(line),
        readWitness, readEvidence: () => e.readDrainRedTeamEvidence({ ...key, readScorecards: () => [] }),
        readStatus: () => e.readRedTeamStatus(key), readReviewRuns: () => [], readReviews: () => [], readCompleteReviews: () => [],
        readCarry: () => null, headNeverReviewed: () => false, proveMove: () => null, readHeadFiles: () => [],
        readComments: () => [], provider: { readPrState: () => rawPr, setLabels: refuse('setLabels'), ensureLabel: () => {} },
        escalate: refuse('escalate'), settlePending: refuse('settlePending'), settle: refuse('settle'),
        syncLabels: refuse('syncLabels'), publishCheck: refuse('publishCheck'),
        abandon: k => r.abandonStaleRedTeamRun({ ...k, env }, { readWitness, now: () => now, deadlineMs, setting }),
        dispatch: args => {
          let abandonedFirst = false;
          try { abandonedFirst = JSON.parse(readFileSync(statusPath, 'utf8')).staleAbandoned != null; } catch { /* stays false */ }
          calls.push({ ...args, abandonedFirst });
          return { jobPid: 4242 };
        } });
      const [call] = calls, [row] = out.rows;
      const drain = e.readDrainRedTeamEvidence({ ...key, readScorecards: () => [] });
      const checks = {
        witness: witness.unfinishedReviewException === true && witness.newest?.pending?.kind === 'confirm',
        dispatchedOnce: calls.length === 1 && call.pr === pr && call.repo === repo && call.redTeamOnly === true
          && call.redTeamMode === 'fresh',
        abandonedBeforeDispatch: call?.abandonedFirst === true && existsSync(`${statusPath}.stale-redispatch-1`),
        started: out.dispatched.length === 1 && out.dispatched[0].prNumber === pr && out.dispatched[0].mode === 'fresh'
          && out.notStarted.length === 0,
        row: row?.action === 'dispatch' && row.staleRecovery === true && row.why === 'dead owner recovery' && !row.escalate,
        logged: lines.some(line => line.includes('red team dispatched (fresh)')),
        noSettlement: forbidden.length === 0,
        reviewUntouched: readFileSync(runPath, 'utf8') === before && drain.ok === false && drain.reason === 'review-unfinished',
      };
      const failed = Object.keys(checks).filter(name => !checks[name]);
      return { violations: failed.length ? [`dead owner behind pending confirm did not redispatch through the daemon runner `
        + `without settling the review (failed: ${failed.join(', ')}; row: ${row?.action}/${row?.why}; side effects: ${forbidden.join(',') || 'none'})`] : [] };
    } catch (error) { return { violations: [error.message] }; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
