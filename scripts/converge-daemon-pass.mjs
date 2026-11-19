#!/usr/bin/env node
import { defaultPoolRoot } from './lib/lane-pool-paths.mjs';
/**
 * converge-daemon-pass.mjs — ONE scheduled pass of the converge daemon (#2572, ruling R7 of 2026-08-08).
 *
 * WHY: `review-runner.mjs` (#2830) is the converge daemon's shadow payload and it is complete — but NOTHING
 * schedules it. No workflow, no npm script, no conveyor caller; it is hand-run, so it writes nothing and, more
 * to the point, it *observes* nothing. The enforce flip's readiness predicate needs a clean shadow track record
 * that can only be earned by running unattended for a while, so "schedule it" is the last thing standing
 * between here and that record. This file is the payload half of the substrate; `converge-daemon-install.mjs`
 * is the schedule half.
 *
 * SHAPE — a periodic ONE-SHOT, deliberately not a resident daemon. The shadow pass is a plain CLI that
 * discovers, folds a ledger, prints and exits; it already holds its own TTL singleton lease, so overlapping
 * fires are a benign no-op. A resident `KeepAlive` process (the drain daemon's shape, #2501 Fork B) buys
 * nothing until the ENFORCE era, when the pass spawns a panel + editor subagent and wants to survive across
 * them. Until then a `StartInterval` job is the whole daemon, and it costs one plist.
 *
 * THE LEDGER IS THE ONE NON-OBVIOUS WIRE. `runShadowPass` folds the durable jury log, which lives in a
 * WORKING TREE at `<root>/.conveyor/jury/` and is gitignored — so a dedicated daemon clone has its own EMPTY
 * one, every PR folds fail-closed to keep-parked, and the soak proves nothing. The pass therefore points
 * `CONVEYOR_JURY_DIR` at the tree the convergence loop actually writes (the operator's primary checkout) and
 * reads it READ-ONLY. That indirection is also the migration seam: when the ledger becomes a shared store, this
 * env var is the only thing that changes, and the daemon stops caring which host runs it.
 *
 * SAFETY: the pass runs `review-runner.mjs`, which refuses `--enforce` and guarantees `mutations: 0`. This
 * wrapper adds no flags that could act, and its refresh step (`fetch` + `reset --hard` + `clean`) is why it
 * REFUSES to run against the operator's primary checkout — see `assertNotPrimary`.
 *
 * Usage:
 *   node scripts/converge-daemon-pass.mjs                 # refresh the clone, run one shadow pass, append the log
 *   node scripts/converge-daemon-pass.mjs --no-refresh    # skip the git refresh (run the code as it sits)
 *   node scripts/converge-daemon-pass.mjs --print-config   # resolve + print the config, do nothing else
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { LEASE_FILENAME, isLeaseStale, DEFAULT_LEASE_TTL_MINUTES } from './lib/lane-lease.mjs';

/** The exact command that provisions the daemon's dedicated pool. `--name=` (NOT `--pool=`) is the provisioning
 *  selector — `lane-pool.mjs` documents `--pool` as a read/release selector for an EXISTING pool and its
 *  `cloneLane` says so in its own refusal — and it is the flag #2501's drain daemon already uses for
 *  `we-drain-daemon`. `--repo` pins the origin so the command works from any cwd. */
export const PROVISION_CMD = 'node scripts/lane-pool.mjs provision --repo=<your WE checkout> '
  + '--name=we-converge-daemon --count=1';

/** The dedicated single-lane clone the daemon runs its own source from (#2501 Fork A(a), applied to this daemon).
 *  Provision it with `PROVISION_CMD` above. */
export const DEFAULT_CLONE_REL = ['workspace', '.lanes', 'we-converge-daemon', 'lane-1'];
/** The operator's primary checkout — the tree the convergence loop writes its jury ledger into, and the tree
 *  this pass must NEVER refresh (a `reset --hard` there would clobber the operator's uncommitted work). */
export const DEFAULT_PRIMARY_REL = ['workspace', 'webeverything'];
/** Operational state (the shadow log) hangs off $HOME, NOT the clone — it must survive `reset --hard`/`clean`. */
export const DEFAULT_STATE_ROOT_REL = ['.converge-daemon'];

/**
 * Resolve the pass config from the environment. PURE (no fs, no clock) so the wiring is testable.
 * @param {Record<string,string|undefined>} [env]
 * @param {string} [home]
 * @returns {{clone:string,primary:string,stateRoot:string,juryDir:string,repo:string|null,logPath:string}}
 */
export function resolvePassConfig(env = process.env, home = homedir()) {
  const pick = (name, fallback) => {
    const v = env[name];
    return v && v.trim() ? resolve(v.trim()) : fallback;
  };
  const clone = pick('CONVERGE_DAEMON_CLONE', join(defaultPoolRoot(join(home, 'workspace', 'web-everything'), env), ...DEFAULT_CLONE_REL.slice(2)));
  const primary = pick('CONVERGE_DAEMON_PRIMARY', join(home, ...DEFAULT_PRIMARY_REL));
  const stateRoot = pick('CONVERGE_DAEMON_STATE_ROOT', join(home, ...DEFAULT_STATE_ROOT_REL));
  // The ledger the shadow fold reads. Defaults to the PRIMARY tree's `.conveyor/jury` — the tree the #2639
  // convergence loop actually writes — because the clone's own copy is always empty (gitignored).
  const juryDir = pick('CONVERGE_DAEMON_JURY_DIR', join(primary, '.conveyor', 'jury'));
  const repoRaw = env.CONVERGE_DAEMON_REPO;
  return {
    clone,
    primary,
    stateRoot,
    juryDir,
    repo: repoRaw && repoRaw.trim() ? repoRaw.trim() : null,
    logPath: join(stateRoot, 'shadow.jsonl'),
  };
}

/**
 * The git steps that bring the daemon's own clone up to `origin/main` before a pass — the same
 * fetch/reset/clean the drain daemon runs on its WE clone (#2501 Fork A(a)), so the soak tracks main rather than
 * whatever the clone was left at. PURE (returns argv, runs nothing).
 * @param {string} clone
 * @returns {Array<string[]>}
 */
export function buildRefreshSteps(clone) {
  return [
    ['git', '-C', clone, 'fetch', '--quiet', 'origin', 'main'],
    ['git', '-C', clone, 'reset', '--hard', '--quiet', 'origin/main'],
    ['git', '-C', clone, 'clean', '-fdq'],
  ];
}

/**
 * The argv for the shadow pass itself. Adds NO flag that could mutate — `--enforce` is refused by the runner and
 * is never constructed here. PURE.
 * @param {{repo:string|null}} cfg
 * @returns {string[]}
 */
export function buildRunnerArgv(cfg) {
  const argv = ['scripts/review-runner.mjs', '--json'];
  if (cfg.repo) argv.push(`--repo=${cfg.repo}`);
  return argv;
}

/**
 * Fold one pass into the record appended to the shadow log. PURE — the caller supplies the timestamp, so the
 * record shape is testable without a clock.
 * @param {{startedAt:string,cfg:object,exitCode:number,summary:object|null,error:string|null}} input
 * @returns {object}
 */
export function buildPassRecord({ startedAt, cfg, exitCode, summary, error }) {
  return {
    at: startedAt,
    clone: cfg.clone,
    juryDir: cfg.juryDir,
    exitCode,
    ranPass: !!(summary && summary.ranPass),
    // A pass that could not run (lease held, gh down) is recorded, not silently dropped — a gap this log cannot
    // see is a gap it cannot account for. NOTE: this log is NOT yet the `reviewShadowLedger` #2838's
    // `enforceFlipReady` reads, and does not feed `computeAgreementMetric` in its current shape (no `match`/
    // `outcome` per record) — that durable ledger is #2893's job, not this file's (#3008).
    reason: summary && !summary.ranPass ? summary.reason || null : null,
    discovered: summary ? summary.discovered ?? null : null,
    clearable: summary ? summary.clearable ?? null : null,
    wouldClear: summary ? summary.wouldClear ?? null : null,
    wouldKeepParked: summary ? summary.wouldKeepParked ?? null : null,
    mutations: summary ? summary.mutations ?? null : null,
    // The per-PR detail behind the pass-level aggregates above — WHICH PR(s) account for a `wouldClear` drop and
    // WHY, trimmed to the minimum an operator needs (#3008 Problem 1). Projected from `summary.records`
    // (`review-runner.mjs --json`'s per-PR array, `buildShadowRecord` in `review-runner-core.mjs`), which is
    // absent when `summary` is null (no parseable JSON) or the daemon's own `refuse()` pre-flight fired (it never
    // calls review-runner) — `[]` in both cases, never `undefined`/`null`.
    records: Array.isArray(summary && summary.records)
      ? summary.records.map((r) => ({
        subject: r.subject, pr: r.pr, repo: r.repo, wouldClear: r.wouldClear, reason: r.reason,
      }))
      : [],
    error: error || (summary && summary.error) || null,
  };
}

/** Resolve a path through symlinks where the path exists, else fall back to lexical resolution. A pure `resolve`
 *  comparison is defeated by a symlink (`~/we -> ~/workspace/webeverything` reads as a different path), and the
 *  guard below is the only thing standing between a `reset --hard` and someone's real working tree. */
function defaultRealpath(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/**
 * Refuse to run against the operator's primary checkout. The refresh step `reset --hard`s the clone, so pointing
 * the daemon at primary would clobber real uncommitted work — the same forced invariant that closed Fork A(b)
 * in #2501. Fail CLOSED and say what to do instead. Compares through SYMLINKS, not just lexically.
 * @param {{clone:string,primary:string}} cfg
 * @param {(p:string)=>string} [realpathOf] - injectable for tests
 * @returns {string|null} an error message, or null when the config is safe
 */
export function assertNotPrimary(cfg, realpathOf = defaultRealpath) {
  if (realpathOf(cfg.clone) !== realpathOf(cfg.primary)) return null;
  return `converge-daemon: refusing to run from the PRIMARY checkout (${cfg.primary}) — a pass runs `
    + 'git reset --hard, which would clobber uncommitted work. Provision the dedicated clone with '
    + `\`${PROVISION_CMD}\`, or set CONVERGE_DAEMON_CLONE.`;
}

/**
 * Refuse to run against a clone that SOMEONE ELSE IS USING. `assertNotPrimary` only knows about ONE tree; the
 * refresh's `git reset --hard` + `git clean -fdq` destroys uncommitted work in ANY tree it is pointed at, and a
 * pooled lane clone under `~/workspace/.lanes/` is exactly as destroyable as primary. A misconfigured
 * `CONVERGE_DAEMON_CLONE` (or a pool the operator later hands out) would silently eat a live session's work every
 * 15 minutes. So: fail CLOSED on a live lane lease, on uncommitted changes, and on unpushed commits — the same
 * three signals `lane-pool.mjs` itself refuses to `reset --hard` over (#2267 data-loss guard, #2275 lease).
 *
 * ACCEPTED COST: a stray untracked file in the daemon's own clone now WEDGES it (the refusal runs before the
 * `clean` that used to sweep such a file away) instead of being silently deleted. That is the right side to fail
 * on for a destructive op, and it is not silent — the refusal is appended to the soak log with `reason:'refused'`,
 * which is exactly the "a gap the readiness predicate cannot see is a gap it cannot account for" rule. PURE.
 * @param {string} clone
 * @param {{dirty:boolean,ahead:boolean,lease:object|null}} state - from `probeCloneState`
 * @param {number} [nowMs]
 * @param {number} [ttlMs]
 * @returns {string|null} an error message, or null when the clone is safe to refresh
 */
export function assertCloneNotInUse(clone, state, nowMs = Date.now(), ttlMs = DEFAULT_LEASE_TTL_MINUTES * 60_000) {
  const { dirty = false, ahead = false, lease = null } = state || {};
  const tail = ` A pass runs \`git reset --hard\` + \`git clean -fdq\` there, which destroys that work. Point`
    + ` CONVERGE_DAEMON_CLONE at the daemon's own dedicated clone (\`${PROVISION_CMD}\`).`;
  if (lease && !isLeaseStale(lease, nowMs, ttlMs)) {
    return `converge-daemon: refusing to run from ${clone} — it holds a LIVE lane lease `
      + `(session ${lease.session || '?'}, purpose ${lease.purpose || '?'}).${tail}`;
  }
  if (dirty) return `converge-daemon: refusing to run from ${clone} — the working tree has uncommitted or untracked changes.${tail}`;
  if (ahead) return `converge-daemon: refusing to run from ${clone} — it has commits not pushed to its upstream.${tail}`;
  return null;
}

/**
 * Read the three in-use signals off a real clone. Impure (git + fs); the DECISION lives in `assertCloneNotInUse`.
 * Every probe fails SAFE-LOOKING on error (a clone git cannot read is not evidence of someone's work) except the
 * lease, which is a plain file read.
 * @param {string} clone
 * @returns {{dirty:boolean,ahead:boolean,lease:object|null}}
 */
export function probeCloneState(clone) {
  const git = (...a) => spawnSync('git', ['-C', clone, ...a], { encoding: 'utf8' });
  const st = git('status', '--porcelain');
  const dirty = st.status === 0 && !!(st.stdout || '').trim();
  const rl = git('rev-list', '--count', '@{upstream}..HEAD');
  const ahead = rl.status === 0 && Number((rl.stdout || '').trim()) > 0;
  let lease = null;
  try {
    const parsed = JSON.parse(readFileSync(join(clone, '.git', LEASE_FILENAME), 'utf8'));
    lease = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { lease = null; } // absent or corrupt marker ⇒ no live lease (matches lane-pool's fail-open read)
  return { dirty, ahead, lease };
}

// ── the CLI (gated on direct invocation) ──────────────────────────────────────────────────────────────────────
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) process.exitCode = main(process.argv.slice(2));

function main(argv) {
  const cfg = resolvePassConfig();
  const noRefresh = argv.includes('--no-refresh');

  if (argv.includes('--print-config')) {
    process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
    return 0;
  }

  // Every refusal below is RECORDED, not just printed. No `enforceFlipReady` predicate reads this log yet (see
  // `buildPassRecord`'s comment), but a daemon that has been refusing to start for a week must not look like a
  // daemon that never fired once one does.
  const refuse = (msg) => {
    process.stderr.write(`${msg}\n`);
    appendRecord(cfg, buildPassRecord({
      startedAt: new Date().toISOString(), cfg, exitCode: 2,
      summary: { ranPass: false, reason: 'refused' }, error: msg,
    }));
    return 2;
  };

  const unsafe = assertNotPrimary(cfg);
  if (unsafe) return refuse(unsafe);

  if (!existsSync(cfg.clone)) {
    return refuse(`converge-daemon: clone not found at ${cfg.clone} — provision it with \`${PROVISION_CMD}\`.`);
  }

  // The clone is a real tree. Refuse before the refresh if anyone else is using it (#2267/#2275 signals).
  const inUse = assertCloneNotInUse(cfg.clone, probeCloneState(cfg.clone));
  if (inUse) return refuse(inUse);

  const startedAt = new Date().toISOString();
  let error = null;

  if (!noRefresh) {
    for (const [cmd, ...args] of buildRefreshSteps(cfg.clone)) {
      const r = spawnSync(cmd, args, { encoding: 'utf8' });
      if (r.status !== 0) {
        // A failed refresh is NOT fatal — the pass still runs the code as it sits, and the record says so. A
        // transient network blip must not punch a hole in the soak record.
        error = `refresh step failed: ${cmd} ${args.join(' ')} — ${(r.stderr || '').trim() || `exit ${r.status}`}`;
        break;
      }
    }
  }

  const run = spawnSync(process.execPath, buildRunnerArgv(cfg), {
    cwd: cfg.clone,
    encoding: 'utf8',
    env: { ...process.env, CONVEYOR_JURY_DIR: cfg.juryDir },
  });

  let summary = null;
  try { summary = JSON.parse(run.stdout || 'null'); } catch { summary = null; }
  if (!summary && !error) error = `review-runner produced no JSON (exit ${run.status}): ${(run.stderr || '').trim().slice(0, 400)}`;

  const record = buildPassRecord({ startedAt, cfg, exitCode: run.status ?? -1, summary, error });
  appendRecord(cfg, record);

  process.stdout.write(`${JSON.stringify(record)}\n`);
  return record.error ? 1 : 0;
}

/** Append one record to the soak log, best-effort — a log we cannot write must not abort the pass. */
function appendRecord(cfg, record) {
  try {
    mkdirSync(cfg.stateRoot, { recursive: true });
    appendFileSync(cfg.logPath, `${JSON.stringify(record)}\n`);
  } catch (e) {
    process.stderr.write(`converge-daemon: could not append the shadow log at ${cfg.logPath} — ${String((e && e.message) || e)}\n`);
  }
}
