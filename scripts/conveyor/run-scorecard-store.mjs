/**
 * @file scripts/conveyor/run-scorecard-store.mjs
 * @description THE SCORECARD STORE (`#3649` Fork 2) — one append-only row per scored dispatch. Shape copies
 *   `we:scripts/check-app-conformance.mjs`'s burndown precedent (append-only, a derived percentage alongside
 *   the raw record) WITHOUT its `denom ? … : 100` fallback, which the card's own skeptic amendment flags as
 *   backwards: that fires when NOTHING was measured, meaning "no information", not "a perfect subject" — this
 *   store never writes `100` for an unmeasured run; it writes `null` (`we:scripts/conveyor/
 *   run-quality-scorer.mjs#scoreRecords` already enforces this at the scoring layer, and this module trusts,
 *   never overrides, the score it is handed).
 *
 * KEYED GENERICALLY BY `{provider, model}`, PER THE OPERATOR'S EXPLICIT RULING (2026-09-13): the whole point
 * of a "probation" status is that it applies to ANY provider/model, not just Codex, and a scorecard must
 * never let a future model quietly inherit an older model's accumulated data. So every row carries its own
 * `provider`/`model` (never just a bare `model` string the way the card's own Fork 2 illustration first
 * sketched it — widened here on purpose) and {@link meanScore} REQUIRES both, alongside `rubricVersion`,
 * before it will average anything — a query that omits either cannot silently blend two different models'
 * history.
 *
 * FORK 3 (never re-normalised): `rubricVersion` is stamped once, at write time, and this store NEVER rewrites
 * a historical row's score when the rubric changes later. `meanScore`'s `rubricVersion` filter is REQUIRED —
 * there is no query that mixes versions.
 *
 * FORK 5 (subject-class gate, stamped never inferred): `subjectClass` travels on every row so a later reader
 * can tell why nothing was ever auto-applied for a `driver`-class row, and so {@link meanScore} never mixes a
 * driver run into a work-agent aggregate (or vice versa) — the aggregate filter defaults to `work-agent` for
 * exactly this reason, callers must opt in to see `driver` rows.
 *
 * PROBATION IS STAMPED TOO, same discipline as the subject-class gate: `probationStatus` records what
 * `we:scripts/lib/model-probation.mjs` said about this `{provider, model, role}` AT THE TIME the run was
 * scored — never re-queried live later, so a model's later promotion to `trusted` does not retroactively
 * relabel history it was actually produced under.
 *
 * SCRUB IS ENFORCED HERE TOO, defence in depth alongside the scorer's own scrub (`#automated-session-
 * introspection` clause 3 / `#3477` clause 5): `appendScorecard` REFUSES (throws) rather than writes a row
 * whose `deductions[].evidence` still fails `scrubReasons` — "denying on a hit rather than redacting" is a
 * hard requirement on the build, per the card's own Fork 2 amendment, not a nicety either layer could skip.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { scrubReasons } from '../lib/secret-scrub.mjs';
import { daemonConveyorStateRoot } from '../lib/daemon-rebuild.mjs';
import { withInfraLock } from './infra-blocked.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The checkout this module runs from. */
const MODULE_REPO_ROOT = resolve(__dirname, '..', '..');

/** Repo-relative path of the store's OLD home: a git-TRACKED file next to this script. It is no longer
 *  tracked (#4155) and nothing writes it — it is named only so {@link migrateLegacyStore} can carry the
 *  history it held into the shared store. */
export const LEGACY_IN_TREE_STORE = 'scripts/conveyor/run-scorecards.json';

/**
 * Where the store file lives — ONE shared file outside every git tree (#4155):
 * `<conveyor state root>/.conveyor/run-scorecards.json`, where the root is
 * `daemon-rebuild.mjs#daemonConveyorStateRoot` — the operator's `CONVEYOR_STATE_ROOT` pin when set (#4052),
 * else `~/.claude/daemon-self-sync-state/conveyor-state` (`WE_DAEMON_STATE_DIR` moves the parent).
 *
 * WHY NOT THE OLD IN-TREE DEFAULT: the store used to default to the tracked `scripts/conveyor/run-scorecards.json`
 * of whatever checkout ran the write. Every review round's codex advisory seat (#3907) appended a row there, so
 * the review-daemon clone went dirty, its self-sync refused to move a dirty clone, the clone fell behind
 * `origin/main`, and every review dispatch refused as stale (live 2026-09-25). A daemon-only special case
 * (#4044) still let lanes and the primary checkout dirty themselves and split the history per checkout. One
 * machine-wide file needs no env var to be safe and every checkout, lane and daemon clone reads the same rows.
 * Every reader and writer resolves the path HERE — never a hard-coded path.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveScorecardStorePath(env = process.env) {
  return join(daemonConveyorStateRoot(env), '.conveyor', 'run-scorecards.json');
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Validate one scorecard row before it is appended. Never throws on its own — returns `{ok, errors}`; the
 * caller (`appendScorecard`) decides whether to refuse the write.
 * @param {object} row
 */
export function validateScorecard(row) {
  const errors = [];
  if (!row || typeof row !== 'object') return { ok: false, errors: ['row is not an object'] };
  if (!isNonEmptyString(row.rubricVersion)) errors.push('`rubricVersion` is required — Fork 3: every row is stamped');
  if (!isNonEmptyString(row.provider)) errors.push('`provider` is required — identity is ALWAYS provider+model, never a bare model string');
  if (!isNonEmptyString(row.model)) errors.push('`model` is required');
  if (row.subjectClass !== 'work-agent' && row.subjectClass !== 'driver') errors.push('`subjectClass` must be "work-agent" or "driver" — Fork 5');
  if (!isNonEmptyString(row.dispatchKind)) errors.push('`dispatchKind` is required (e.g. "fix", "advisory-review")');
  if (typeof row.criteriaEvaluated !== 'number' || row.criteriaEvaluated < 0) errors.push('`criteriaEvaluated` must be a non-negative number');
  if (row.criteriaEvaluated === 0 && row.score !== null) errors.push('`score` MUST be null when `criteriaEvaluated` is 0 — never 100 on an empty read (Fork 2 amendment)');
  if (row.score !== null && (typeof row.score !== 'number' || row.score < 0 || row.score > 100)) errors.push('`score` must be null or a number in [0, 100]');
  // Optional for historical rows; null means unmeasured, zero means measured and absent.
  for (const field of ['newLoc', 'modifiedLoc', 'newFiles', 'modifiedFiles']) {
    if (row[field] != null && (!Number.isSafeInteger(row[field]) || row[field] < 0)) {
      errors.push(`${field} must be null or a non-negative safe integer`);
    }
  }
  if (!Array.isArray(row.deductions)) errors.push('`deductions` must be an array (possibly empty)');
  else {
    for (const d of row.deductions) {
      if (isNonEmptyString(d?.evidence) && scrubReasons(d.evidence).length > 0) {
        errors.push(`deduction ${JSON.stringify(d.criterion)}'s evidence failed the append-time scrub — denying, per Fork 2's amendment, never redacting`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** `{version, records, migrations}` from store JSON text; `null` when it is not that shape (never guessed). */
function parseStoreText(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.records)) return null;
    return {
      version: parsed.version ?? 1,
      records: parsed.records,
      migrations: Array.isArray(parsed.migrations) ? parsed.migrations : [],
    };
  } catch {
    return null;
  }
}

/** Prefix of every stamp the migration writes into the shared store's `migrations`. */
export const LEGACY_MIGRATION_ID = 'legacy-in-tree-store-4155';

/**
 * The stamp for ONE legacy source, so a store migrated from checkout A still imports checkout B's history
 * (review of PR #2684). The git-history source is keyed by checkout: its content is frozen once the untracking
 * commit is in HEAD, and keying it by path lets a later process skip the git spawn entirely — including when
 * that checkout turned out to hold no history (a shallow or unrelated clone). The on-disk copy is keyed by a
 * hash of its content, because an older process may still append to that (now ignored) file.
 */
export const legacyGitStamp = (repoRoot) => `${LEGACY_MIGRATION_ID}:git:${repoRoot}`;
export const legacyFileStamp = (text) => `${LEGACY_MIGRATION_ID}:file:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;

const defaultGit = (repoRoot) => (args) => execFileSync('git', ['-C', repoRoot, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
});

/**
 * Every source of the OLD tracked store this checkout can still see, skipping any whose stamp is in `done`:
 * the in-tree file if one is still on disk (a checkout whose copy was never pulled away), plus its last
 * COMMITTED content from git history — so a checkout that already pulled the untracking commit (which deletes
 * the file) still migrates. `stamps` lists every source actually examined — the git source counts once
 * `rev-list` answered, even with no history, so the search is never repeated. Never throws.
 * @param {{repoRoot?:string, exists?:Function, read?:Function, git?:(args:string[])=>string, done?:string[]}} [o]
 * @returns {{texts:string[], stamps:string[]}}
 */
export function readLegacySources({
  repoRoot = MODULE_REPO_ROOT, exists = existsSync, read = (p) => readFileSync(p, 'utf8'), git = defaultGit(repoRoot), done = [],
} = {}) {
  const texts = [];
  const stamps = [];
  const onDisk = join(repoRoot, LEGACY_IN_TREE_STORE);
  try {
    if (exists(onDisk)) {
      const text = read(onDisk);
      const stamp = legacyFileStamp(text);
      if (!done.includes(stamp)) { texts.push(text); stamps.push(stamp); }
    }
  } catch { /* unreadable — skip */ }
  if (!done.includes(legacyGitStamp(repoRoot))) {
    let sha = null;
    try { sha = String(git(['rev-list', '-1', 'HEAD', '--', LEGACY_IN_TREE_STORE])).trim(); } catch { /* no git — retry next process */ }
    // Stamp only a settled answer: no history at all, or the history actually read. A failed `show` retries later.
    if (sha === '') stamps.push(legacyGitStamp(repoRoot));
    if (sha) {
      // The last commit touching the path is either an append (the file is in it) or the untracking commit (the
      // file is in its parent — first parent for a merge landed onto main, second for the other side).
      for (const rev of [sha, `${sha}^1`, `${sha}^2`]) {
        try {
          texts.push(String(git(['show', `${rev}:${LEGACY_IN_TREE_STORE}`])));
          stamps.push(legacyGitStamp(repoRoot));
          break;
        } catch { /* next */ }
      }
    }
  }
  return { texts, stamps };
}

/** Every legacy JSON text this checkout can still see (see {@link readLegacySources}). */
export function readLegacyStoreTexts(o = {}) {
  return readLegacySources(o).texts;
}

/**
 * PURE: union the legacy history into the shared store and add `stamps`. A row already in the target (by exact
 * JSON identity) is never duplicated, nothing in the target is ever dropped or overwritten, and legacy rows it
 * lacks go FIRST (they are older). `null` when there is nothing to record — no legacy text parsed and no stamp.
 * @param {{version:number, records:object[], migrations?:string[]}|null} target - the current shared store, or null when absent
 * @param {string[]} legacyTexts
 * @param {string[]} [stamps]
 */
export function mergeLegacyStores(target, legacyTexts, stamps = []) {
  const legacy = legacyTexts.map(parseStoreText).filter(Boolean);
  if (legacy.length === 0 && stamps.length === 0) return null;
  const base = target ?? { version: legacy[0]?.version ?? 1, records: [], migrations: [] };
  const seen = new Set(base.records.map((r) => JSON.stringify(r)));
  const carried = [];
  for (const store of legacy) {
    for (const r of store.records) {
      const key = JSON.stringify(r);
      if (!seen.has(key)) { seen.add(key); carried.push(r); }
    }
  }
  return {
    store: {
      version: base.version ?? 1,
      records: [...carried, ...base.records],
      migrations: [...new Set([...(base.migrations ?? []), ...stamps])],
    },
    added: carried.length,
  };
}

/**
 * Serialize a read-modify-write of the store across processes (`<path>.lock`, the exclusive-create lock
 * `infra-blocked.mjs` already uses). Atomic rename alone prevents a partial file, not a lost update: two writers
 * that each read, change and write drop whichever row landed first (review of PR #2684). The section it guards
 * must stay fast — no git, no network. Like every user of that lock, it is best-effort: a holder that cannot
 * get it within 5s (or hits an unexpected fs error) writes unlocked rather than fail a scoring pass, so a lost
 * update stays possible only under that extreme contention. Probation builds pass `requireLock: true`
 * to migration and append: lock acquisition failure then refuses the write instead.
 */
function withStoreLock(path, fn, requireLock = false) {
  return withInfraLock(path, fn, { requireLock });
}

let migrationChecked = false;

/**
 * ONE-TIME migration (#4155): carry the old tracked in-tree history into the shared store — a union, never a
 * clobber — and stamp each source it examined so that source is never read again. Runs lazily on the first
 * real read of the default store in a process. Never throws.
 *
 * The slow part (git) runs BEFORE the lock, and only for sources the store does not stamp yet. The store is
 * then re-read UNDER the lock and merged, so a row another process appended meanwhile is kept.
 * @param {{path?:string, repoRoot?:string, exists?:Function, read?:Function, write?:Function, git?:Function, lock?:Function}} [o]
 * @returns {{migrated:boolean, added?:number, reason?:string, path:string}}
 */
export function migrateLegacyStore({
  path = resolveScorecardStorePath(), repoRoot = MODULE_REPO_ROOT,
  exists = existsSync, read = (p) => readFileSync(p, 'utf8'), write = atomicWrite, git, lock = withStoreLock,
} = {}) {
  const readTarget = () => {
    if (!exists(path)) return { target: null };
    const target = parseStoreText(read(path));
    // Never overwrite a shared store we cannot read — that would destroy the rows already there.
    return target ? { target } : { unparsable: true };
  };
  try {
    const before = readTarget();
    if (before.unparsable) return { migrated: false, reason: 'shared-store-unparsable', path };
    const { texts, stamps } = readLegacySources({
      repoRoot, exists, read, ...(git ? { git } : {}), done: before.target?.migrations ?? [],
    });
    if (texts.length === 0 && stamps.length === 0) {
      return { migrated: false, reason: before.target ? 'already-migrated' : 'no-legacy-history', path };
    }
    return lock(path, () => {
      const now = readTarget();
      if (now.unparsable) return { migrated: false, reason: 'shared-store-unparsable', path };
      const merged = mergeLegacyStores(now.target, texts, stamps);
      write(path, serializeStore(merged.store));
      return { migrated: true, added: merged.added, path };
    });
  } catch (e) {
    return { migrated: false, reason: `error: ${String(e?.message || e).split('\n')[0]}`, path };
  }
}

/** Run the lazy migration once per process — only for the real default store, never for injected IO. */
function ensureMigrated(io) {
  if (migrationChecked || ['path', 'read', 'exists', 'write'].some((k) => io[k] !== undefined)) return;
  migrationChecked = true;
  migrateLegacyStore({ lock: (path, fn) => withStoreLock(path, fn, io.requireLock === true) });
}

function atomicWrite(p, s) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, s);
  renameSync(tmp, p);
}

function serializeStore(store) {
  const out = { version: store.version ?? 1, records: store.records ?? [] };
  if (Array.isArray(store.migrations) && store.migrations.length) out.migrations = store.migrations;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Read the store off disk. Never throws — an unreadable/malformed file degrades to an empty store, so a
 * caller always gets a usable (if empty) history rather than a crash mid-scoring-pass.
 *
 * On the first real read of the DEFAULT store in a process (no `path`, no injected `read`), the one-time
 * {@link migrateLegacyStore} runs first, so no reader ever sees the history the old tracked file held go
 * missing. An explicit `path` or injected IO reads exactly what it is given.
 */
export function readStore({ path, read, exists } = {}) {
  ensureMigrated({ path, read, exists });
  const target = path ?? resolveScorecardStorePath();
  const doRead = read ?? ((p) => readFileSync(p, 'utf8'));
  try {
    if (!(exists ?? existsSync)(target)) return { version: 1, records: [] };
    return parseStoreText(doRead(target)) ?? { version: 1, records: [] };
  } catch {
    return { version: 1, records: [] };
  }
}

/** Write the store back to disk, pretty-printed and atomically (creating the directory on first write). */
export function writeStore(store, { path = resolveScorecardStorePath(), write = atomicWrite } = {}) {
  write(path, serializeStore(store));
}

/**
 * Append ONE scorecard row. REFUSES (throws) on an invalid row — a scorecard is a durable historical fact,
 * so a caller must fix the row rather than have it silently coerced or dropped.
 * @param {object} row - everything `validateScorecard` requires, plus whatever else Fork 2's shape names
 *   (`item`, `handle`, `effort`, `outcome`, `probationStatus`, `scoredAt`, …) — including `changedFiles` (#4034
 *   follow-up, card 4034b), the PR's changed files net versus its base, and `prepared` (#4304: whether the
 *   dispatched item's backlog card carries a stamped Definition-of-Ready `preparedDate` — checked at SCORE
 *   time by `run-rating.mjs#toScorecardRow`, not compared against the dispatch/claim time itself; see that
 *   function's own doc). This function stores whatever a writer passes through unmodified (the spread below);
 *   every writer decides its OWN shape, this store enforces only the bones every row must share, per
 *   {@link validateScorecard}.
 * @param {object} [io] - `readStore`/`writeStore`'s own injectable IO, threaded through for tests.
 * @returns {object} the stored row (with `scoredAt` filled in if the caller omitted it).
 */
export function appendScorecard(row, io = {}) {
  return appendRowToStore(row, io);
}

/**
 * Append a probation trial once per {handle, pr}, re-reading under the append lock.
 * Lock failure refuses the write. Injected io.write is an unlocked test seam.
 * Returns null if a concurrent sweep already wrote the trial.
 */
export function appendScorecardUnlessJudged(row, io = {}) {
  if (row?.dispatchKind !== 'probation-trial') throw new TypeError('run-scorecard-store: expected a probation-trial');
  return appendRowToStore(row, { ...io, requireLock: true }, records => records.some(r =>
    r?.dispatchKind === 'probation-trial' && (r.handle ?? null) === (row.handle ?? null) && (r.pr ?? null) === (row.pr ?? null)));
}

function appendRowToStore(row, io, alreadyJudged = () => false) {
  const stamped = { v: 1, outcome: null, scoredAt: new Date().toISOString(), ...row };
  const verdict = validateScorecard(stamped);
  if (!verdict.ok) {
    throw new Error(`run-scorecard-store: refusing to append an invalid scorecard:\n  - ${verdict.errors.join('\n  - ')}`);
  }
  // Migrate first (it takes the lock itself), then read-modify-write under the lock so a concurrent append or
  // migration is never overwritten. Injected in-memory IO has no file to lock.
  ensureMigrated(io);
  const appendRow = () => {
    const store = readStore(io);
    if (alreadyJudged(store.records)) return null;
    store.records.push(stamped);
    writeStore(store, io);
    return stamped;
  };
  if (io.write !== undefined) return appendRow();
  return withStoreLock(io.path ?? resolveScorecardStorePath(), appendRow, io.requireLock === true);
}

/**
 * FORK 2's aggregator — a 0-100 scalar published ONLY as an aggregate over a declared comparability class,
 * NEVER as a per-run headline. `rubricVersion`, `provider` and `model` are ALL REQUIRED (generalised past
 * the card's own `model × effort × dispatch-kind` sketch, which under-specified `model` as a bare string —
 * see the file header): there is no query that averages across rubric versions, and there is no query that
 * blends two different `{provider, model}` identities into one number either, so a future model's data can
 * never silently dilute or inherit an older model's trend. `effort`/`dispatchKind` narrow further when given.
 * Rows with `score: null` (nothing measured) are EXCLUDED from the average, not treated as 0 or 100.
 *
 * @param {{rubricVersion:string, provider:string, model:string, effort?:string, dispatchKind?:string, subjectClass?:string}} filter
 * @param {object} [io]
 * @returns {{mean: number|null, n: number}} `mean` is `null` when no matching row has a non-null score.
 */
export function meanScore(filter, io = {}) {
  const { rubricVersion, provider, model, effort, dispatchKind, subjectClass = 'work-agent' } = filter ?? {};
  if (!isNonEmptyString(rubricVersion)) throw new TypeError('run-scorecard-store: meanScore requires `rubricVersion` — no cross-version average may be expressed (Fork 3)');
  if (!isNonEmptyString(provider)) throw new TypeError('run-scorecard-store: meanScore requires `provider` — no cross-provider average may be expressed');
  if (!isNonEmptyString(model)) throw new TypeError('run-scorecard-store: meanScore requires `model` — no cross-model average may be expressed (a future model upgrade must never dilute this one\'s trend)');

  const { records } = readStore(io);
  const matches = records.filter((r) => (
    r.rubricVersion === rubricVersion
    && r.provider === provider
    && r.model === model
    && r.subjectClass === subjectClass
    && (effort === undefined || r.effort === effort)
    && (dispatchKind === undefined || r.dispatchKind === dispatchKind)
    && typeof r.score === 'number'
  ));
  if (!matches.length) return { mean: null, n: 0 };
  return { mean: matches.reduce((sum, r) => sum + r.score, 0) / matches.length, n: matches.length };
}
