import { assertMachineTitle } from '../operations/machine-pr-title.mjs';
/**
 * @file scripts/lib/forge-land-provider.mjs
 * @description THE PROVIDER PORT for the land arc (#3174 Fork 2=(b)) — the `gh` operations
 *   `we:scripts/pr-land.mjs` needs (create · view · edit · label · required-checks) behind one injectable
 *   seam, following the `we:scripts/lib/review-label-provider.mjs` precedent (#x8xf5rl).
 *
 * WHY THIS EXISTS. `pr-land.mjs` reached GitHub through a single inline `ghC` exec closure (its own `runCli`),
 * called at 17 sites with hand-written argv literals. Some of those argv shapes were already pure, exported
 * builders (`buildCreateArgs`, `buildMergeArgs`, `buildAddLabelArgs`, `mergeMethodFlag` — moved here from
 * `pr-land.mjs`, and re-exported from there so every existing importer keeps working unchanged); the rest
 * (`pr list`, `pr view`, `pr edit --body`/`--remove-label`, `label create`, `pr checks`) were bare literals
 * with no seam at all. This file gives EVERY ONE of them a named, pure argv builder plus an injectable `gh`
 * adapter, so the exec itself — the part `ghC` never let a test reach — is finally testable.
 *
 * PER-ARC, NOT REPO-WIDE (#3174 Fork 2). This port is shaped for exactly what `pr-land.mjs` calls; it is not a
 * neutral `ForgeProvider`. A second forge would very likely need this to change shape, not be assumed correct
 * as-is — same caveat `review-label-provider.mjs` states about itself.
 *
 * SOLE ROUTE (#3174 Fork 1=(c)). `pr-land.mjs` is a MUTATING arc (it opens/edits/labels PRs), so this port is
 * importable only from `pr-land.mjs` — never a second route another script could take. Nothing outside
 * `pr-land.mjs` should import this file directly; a caller elsewhere that wants one of these pure builders goes
 * through `pr-land.mjs`'s own re-export, the same sole-home invariant `we:scripts/operations/open-pr-io.mjs`
 * already states for its own mutation. This is a DECLARED convention, not a lint-enforced one — same as
 * `open-pr-io.mjs`'s own comment states for itself; nothing here throws if a second script imports it anyway.
 *
 * NO `--repo` FLAG, unlike `review-label-provider.mjs`. Every `pr-land.mjs` call site ran `gh` with `cwd: REPO`
 * (never an explicit `--repo`) and relies on `gh` inferring the repo from the git remote — so `createGhLandProvider`
 * takes `cwd` at construction instead of a `repo` argument per call. Byte-identical to what `ghC` executed
 * before: adding a `--repo` flag here would NOT be byte-identical.
 *
 * `merge`/`mergeMethodFlag` stay PURE-ONLY, same as `review-label-provider.mjs`'s `currentRepo` staying outside
 * its adapter's write path: `pr-land.mjs` no longer merges (#2290 — the drain is the sole writer to `main`), so
 * there is no bare `gh pr merge` call site for an adapter method to replace. The pure builder ships because
 * `pr-land.mjs` already exported it (for the drain's own CLI-shelled reuse) before this port existed; moving it
 * here is a relocation, not new surface.
 *
 * DEFAULT `exec` IS THROTTLED (epic #3383's git-manager slice) — `we:scripts/lib/gh-throttle.mjs#runGhSync`,
 * the same byte-for-byte-transparent-on-success wrapper `review-label-provider.mjs` already adopted, gives
 * every call this provider makes the shared concurrency cap + rate-limit backoff for free. The `create()`
 * method additionally opts into HEADER SELF-CALIBRATION (`throttle.calibrateHeaders`) — this is the exact
 * `gh pr create` that failed twice in one day with no automatic retry at all (the incident that motivated
 * this pass): a secondary-rate-limit hit here now backs off using GitHub's own told `Retry-After` wait
 * instead of a blind guess. Every OTHER method here (reads: `pr view`/`pr list`/`pr checks`, and the label/body
 * edits) stays on the plain throttle — retried, but not header-calibrated — since none of them is the call
 * that has actually failed in production; see `gh-throttle.mjs`'s own module header for why calibration is
 * opt-in per call rather than the wrapper's default.
 *
 * IMPURE by construction in `createGhLandProvider`; the module itself is pure.
 */

import { runGhSync } from './gh-throttle.mjs';
import { clampLabelDescription } from './review-label-provider.mjs';

/** The `gh pr merge` method flag for a merge method (default merge = --no-ff history the drain wants). */
export function mergeMethodFlag(method) {
  switch (method) {
    case 'squash': return '--squash';
    case 'rebase': return '--rebase';
    case 'merge':
    default: return '--merge';
  }
}

/** Build the `gh pr create` args for a self-approved PR (NO reviewer). Emits `--title`/`--body` when supplied
 *  and NEVER drops a body: a `--body` present with no title still ships (the #2170 dismissals audit trail).
 *  `--fill` is used ONLY when NEITHER title nor body is given. Note `--fill` is unusable for the lane-ref
 *  transport anyway (it autofills by diffing the head LOCALLY, but a lane/* head is remote-only — no local
 *  branch to diff — so gh errors "ambiguous argument origin/main...lane/…"); the CLI therefore always
 *  DERIVES a title from the source commit's subject, so the `--fill`-only branch is a bare-call fallback the
 *  lane path never hits. Pure — returns the argv array for `gh`.
 *
 *  HEADLESS-SAFE (#2176): the argv must NEVER be title-only. A bare `gh pr create --title …` (no `--body`,
 *  no `--fill`) drops into an interactive body prompt and, run headless, errors "Command failed". So when a
 *  title is present but no body is given, we pass an explicit empty `--body ""` — never `--fill` (unusable
 *  for a remote-only lane/* head). Result: the create is always non-interactive. (#2332: the CLI create path
 *  now REFUSES a bodyless open upstream via `prCreateBodyGuard`, so this empty-body branch is only ever
 *  reached by the dry-run plan render, never by a real `gh pr create`.)
 *
 *  `draft` (draft-first PRs) — appends `--draft` when true. Omitted (not `--draft=false`) when falsey: `gh`
 *  reads a bare `--draft` as a presence flag, and there is no `--no-draft` gh accepts on CREATE (a PR is
 *  opened ready-for-review by default; drafting is opt-in per call, never per-flag-value). See
 *  `we:scripts/pr-land.mjs`'s own `--park` block for the one call site that sets this — the daemon (never
 *  pr-land itself) is what flips it back with `gh pr ready` once required checks go green (draft-first PRs). */
export function buildCreateArgs({ base, head, title, body, draft }) {
  const args = ['pr', 'create', '--base', base, '--head', head];
  if (title != null) args.push('--title', assertMachineTitle(title));
  // A title with no body must still carry a body — otherwise gh prompts interactively (fails headless, #2176).
  if (body != null) args.push('--body', body);
  else if (title != null) args.push('--body', '');
  if (title == null && body == null) args.push('--fill');
  if (draft === true) args.push('--draft');
  return args;
}

/** Build the `gh pr merge` args — the drain merges ONE PR (not --auto on a native queue), deleting the
 *  lane ref after. Pure. Not wired into `createGhLandProvider`'s adapter — see the file header. */
export function buildMergeArgs({ pr, method }) {
  return ['pr', 'merge', String(pr), mergeMethodFlag(method), '--delete-branch'];
}

/** Build the `gh pr edit --add-label` args that apply the producer-certified `ready-to-merge` label (#2196).
 *  Returns null when labelling is disabled (`--no-label`) or no PR number is known, so the caller can skip.
 *  Pure — returns the `gh` argv array (or null). */
export function buildAddLabelArgs({ pr, label }) {
  if (!label || pr == null) return null;
  return ['pr', 'edit', String(pr), '--add-label', label];
}

/**
 * The argv builders for the call sites that had NO pure builder before this port — each was a hand-written
 * literal at its `ghC(...)` call. PURE, and exported SEPARATELY from the adapter so a test can assert the
 * command is byte-identical to what `pr-land.mjs` executed inline before the port existed.
 */
export const GH_ARGV = Object.freeze({
  /** #808 — find an existing open PR for this head before creating one. */
  listOpenByHead: (head) => ['pr', 'list', '--head', head, '--state', 'open', '--json', 'number'],
  /** One `pr view --json <fields>` shape covers every read `pr-land.mjs` does (body / labels /
   *  mergeable+mergeStateStatus) — the field list is the only thing that ever varied at those call sites. */
  viewPr: (pr, fields) => ['pr', 'view', String(pr), '--json', fields],
  /** `--body`, never `--body-file`: unlike the review-label arc's comment post, every body write here is a
   *  re-composed PR body already held in memory (the manifest/author-stamp backfill, the escalation-reason
   *  reconcile) — matching what `ghC` executed inline before. */
  editBody: (pr, body) => ['pr', 'edit', String(pr), '--body', body],
  removeLabel: (pr, label) => ['pr', 'edit', String(pr), '--remove-label', label],
  /** No `--force`, unlike `review-label-provider.mjs`'s `ensureLabel` — `pr-land.mjs`'s labels are its OWN
   *  small, long-lived set (`ready-to-merge`, the review-escalation labels, a caller's `--park` label), created
   *  once and re-created best-effort (wrapped in a try/catch at every call site) rather than force-updated on
   *  every land. Byte-identical to the inline calls this replaces — adding `--force` would NOT be. */
  labelCreate: (name, { color, description }) => ['label', 'create', name, '--color', color, '--description', clampLabelDescription(description)],
  requiredChecks: (pr) => ['pr', 'checks', String(pr), '--required', '--json', 'state,bucket'],
});

/**
 * The `gh` provider — byte-identical to what `pr-land.mjs`'s `runCli` executed inline before.
 *
 * `exec` is injectable so the ADAPTER itself is testable without `gh` on PATH; a test asserts the argv it
 * builds. `cwd` is bound at construction (mirroring `ghC`'s closure over `REPO`) rather than passed per call —
 * see the file header for why this port takes no `--repo` flag.
 *
 * @param {{cwd?: string, exec?: Function}} [o]
 */
export function createGhLandProvider({
  cwd,
  // The DEFAULT `exec` now routes through `runGhSync` (#3383) rather than a bare `execFileSync` — every
  // method gets the shared concurrency cap + rate-limit retry for free, with IDENTICAL success-return shape
  // (a trimmed string) to before. `callOpts` is an optional second argument a specific METHOD (below, only
  // `create()`) passes to opt that one call into extra `throttle` config (e.g. header self-calibration) —
  // every other call site here still invokes `exec(args)` with no second argument, so `callOpts` defaults to
  // `{}` and those calls are unaffected beyond gaining the throttle itself.
  exec = (args, callOpts = {}) => runGhSync(args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    throttle: { op: callOpts?.throttle?.op || null, calibrateHeaders: !!callOpts?.throttle?.calibrateHeaders },
  }).trim(),
} = {}) {
  return {
    name: 'gh',

    /** Returns the raw create output (the PR URL text) — the caller extracts the PR number from it, same as
     *  before the port existed. Same (semantic-params-in, argv-built-internally) convention as every other
     *  method here — `buildCreateArgs` stays a SEPARATE pure export too, since `pr-land.mjs` also needs its
     *  argv for the dry-run plan render, where nothing is executed.
     *
     *  THE ONE CALL THAT OPTS INTO HEADER SELF-CALIBRATION (#3383) — this is the exact `gh pr create` that
     *  failed twice in one day with no automatic retry; see this file's own header and `gh-throttle.mjs`'s
     *  module doc for why calibration is opt-in per call rather than the wrapper's default. */
    create(args) {
      return exec(buildCreateArgs(args), { throttle: { op: 'pr-create', calibrateHeaders: true } });
    },

    listOpenByHead(head) {
      return JSON.parse(exec(GH_ARGV.listOpenByHead(head)));
    },

    /** Returns the parsed `--json` object as-is — callers extract the field(s) they asked `fields` for,
     *  exactly as each call site did against its own `JSON.parse(ghC(...))` before. */
    viewPr(pr, fields) {
      return JSON.parse(exec(GH_ARGV.viewPr(pr, fields)));
    },

    editBody(pr, body) {
      return exec(GH_ARGV.editBody(pr, body));
    },

    /** Same (semantic-params-in, argv-built-internally) convention as every other method here. `label == null`
     *  or `pr == null` (`buildAddLabelArgs` returns null) means "nothing to label" — the same guard callers
     *  already applied against `ghC` before the port existed — so this is a no-op. */
    addLabel(pr, label) {
      const args = buildAddLabelArgs({ pr, label });
      return args ? exec(args) : null;
    },

    removeLabel(pr, label) {
      return exec(GH_ARGV.removeLabel(pr, label));
    },

    ensureLabel(name, opts) {
      return exec(GH_ARGV.labelCreate(name, opts));
    },

    requiredChecks(pr) {
      return JSON.parse(exec(GH_ARGV.requiredChecks(pr)));
    },
  };
}
