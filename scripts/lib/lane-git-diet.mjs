/**
 * @file lane-git-diet.mjs
 * @description Keep lane clones' `.git` small: stop the default fetch from pulling `ops/*` transport branches,
 * and keep fetched objects packed.
 *
 * WHY (git review 2026-10-21): every lane's default refspec `+refs/heads/*` also fetched `ops/review-requests`,
 * the ~10 MB verdict ledger that gets a new commit every few minutes. A small fetch is unpacked into loose
 * objects (git's default `fetch.unpackLimit` is 100), so each new ledger tip wrote a ~9 MB loose blob into
 * every lane: lane-5 held 2.37 GiB of loose objects and the 104 lanes' `.git` dirs totalled ~35 GB.
 *
 * THE FIX, per lane (local config only):
 *   - `remote.origin.fetch` keeps `+refs/heads/*:refs/remotes/origin/*` and gains the negative refspec
 *     `^refs/heads/ops/*` (git >= 2.29). A plain `git fetch origin` no longer touches `ops/*`.
 *   - `fetch.unpackLimit=1` + `transfer.unpackLimit=1`: a fetch always lands as one pack, never loose blobs.
 *
 * READERS ARE UNAFFECTED. Every in-repo reader of an `ops/*` ref fetches it explicitly with a full refspec
 * (`+refs/heads/ops/x:refs/remotes/origin/ops/x`, see `trackingRefspec` in `./git-transport-branch.mjs`).
 * A configured negative refspec does not filter an explicit command-line refspec, so those fetches still
 * update `origin/ops/x` (proven in `__tests__/lane-git-diet.test.mjs` against real repos). The inventory of
 * readers lives in {@link OPS_REF_READERS} and a test keeps it complete.
 *
 * Pure planning lives here; `we:scripts/lane-pool.mjs` applies it before every lane fetch and after clone.
 */
export const LANE_DEFAULT_FETCH = '+refs/heads/*:refs/remotes/origin/*';
export const LANE_OPS_NEGATIVE_FETCH = '^refs/heads/ops/*';
/** Local config keys a diet lane must carry, with their values. */
export const LANE_DIET_KV = Object.freeze({ 'fetch.unpackLimit': '1', 'transfer.unpackLimit': '1' });

/**
 * Every source file that reads an `ops/*` ref inside a checkout, and how it gets the ref. Each one fetches the
 * ref explicitly by name, so the negative refspec cannot starve it. A test scans `scripts/` and fails when a
 * new reader of `origin/ops/*` appears that is not listed here.
 */
export const OPS_REF_READERS = Object.freeze([
  { file: 'scripts/lib/git-transport-branch.mjs', refs: 'ops/review-requests, ops/pr-views, ops/quarantine, ops/red-main-freeze (any transport)', how: 'trackingRefspec(branch) before ls-tree/show/worktree add' },
  { file: 'scripts/lib/pr-view-transport.mjs', refs: 'ops/pr-views', how: 'fetchTransportArgv(): +refs/heads/ops/pr-views:refs/remotes/origin/ops/pr-views' },
  { file: 'scripts/operations/stage-pr-view-io.mjs', refs: 'ops/pr-views', how: '+refs/heads/${ref}:refs/remotes/origin/${ref} before rev-parse' },
  { file: 'scripts/operations/record-verdict-io.mjs', refs: 'ops/review-requests (+ board genesis source)', how: 'trackingRefspec(sourceBranch) / stageOnTransportBranch' },
  { file: 'scripts/operations/handoff-home.mjs', refs: 'ops/handoff', how: 'trackingRefspec(HANDOFF_BRANCH); runs in its own ~/.claude checkout, not a lane' },
  { file: 'scripts/ci/quarantine-skip.mjs', refs: 'ops/quarantine', how: '+refs/heads/${base}:refs/remotes/origin/${base} (CI job)' },
  // Delegators: they never name a tracking ref themselves; every read goes through readFromTransportBranch.
  { file: 'scripts/lib/verdict-ledger-io.mjs', refs: 'ops/review-requests', how: 'readFromTransportBranch' },
  { file: 'scripts/lib/review-precedents-io.mjs', refs: 'ops/review-requests', how: 'readFromTransportBranch' },
  { file: 'scripts/lib/red-main-quarantine-io.mjs', refs: 'ops/quarantine', how: 'readFromTransportBranch' },
  { file: 'scripts/lib/red-main-freeze-shared.mjs', refs: 'ops/red-main-freeze', how: 'readFromTransportBranch' },
  { file: 'scripts/merge-gate-check.mjs', refs: 'ops/red-main-freeze', how: 'readFromTransportBranch (via red-main-freeze-shared)' },
]);

/**
 * The `git config` argv lists that bring a lane's local config to the diet shape. Pure and idempotent: an
 * already-diet lane yields `[]`.
 * @param {{fetchValues?: string[], kv?: Record<string, string|undefined>}} current
 *   `fetchValues` = `git config --get-all remote.origin.fetch`; `kv` = current local values of {@link LANE_DIET_KV}.
 * @returns {string[][]} argv arrays for `git` (each starts with `config`)
 */
export function laneDietConfigOps({ fetchValues = [], kv = {} } = {}) {
  const ops = [];
  const values = fetchValues.map((v) => String(v).trim()).filter(Boolean);
  // A clone with NO fetch refspec is not a shape we own; restore the standard one first so the negative
  // refspec never stands alone (a negative-only config fetches nothing and git rejects it).
  if (!values.includes(LANE_DEFAULT_FETCH) && !values.some((v) => !v.startsWith('^'))) {
    ops.push(['config', '--local', '--add', 'remote.origin.fetch', LANE_DEFAULT_FETCH]);
  }
  if (!values.includes(LANE_OPS_NEGATIVE_FETCH)) {
    ops.push(['config', '--local', '--add', 'remote.origin.fetch', LANE_OPS_NEGATIVE_FETCH]);
  }
  for (const [key, want] of Object.entries(LANE_DIET_KV)) {
    if (kv[key] !== want) ops.push(['config', '--local', '--replace-all', key, want]);
  }
  return ops;
}

/**
 * Read a lane's current config and apply {@link laneDietConfigOps}. `run(args)` runs git in the lane and
 * returns stdout. Missing keys are absent from the listing; any read failure propagates, so a failed
 * config read can never cause duplicate refspecs.
 * `localConfig` may reuse an immediately preceding, unchanged local config listing (NUL-separated key/value
 * records, as from `git config --local --null --list`). Otherwise all keys are read in one spawn.
 * @returns {string[][]} the ops applied
 */
export function applyLaneDietConfig(run, localConfig) {
  if (localConfig === undefined) localConfig = String(run(['config', '--local', '--null', '--list']) ?? '');
  const values = new Map();
  for (const entry of localConfig.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\n');
    const key = separator < 0 ? entry : entry.slice(0, separator);
    const value = separator < 0 ? '' : entry.slice(separator + 1);
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(value);
  }
  const fetchValues = values.get('remote.origin.fetch') || [];
  const kv = {};
  for (const key of Object.keys(LANE_DIET_KV)) {
    const v = (values.get(key.toLowerCase()) || []).join('\n').trim();
    if (v) kv[key] = v; // several values read as "not exactly the diet value" → replaced below
  }
  const ops = laneDietConfigOps({ fetchValues, kv });
  for (const op of ops) run(op);
  return ops;
}
