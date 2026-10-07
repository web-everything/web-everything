/**
 * @file scripts/operations/open-pr.mjs
 * @description THE `open-pr` DECLARATION (under epic #3029) — open a pull request for a lane, THROUGH the home
 *   that gates it.
 *
 * IT DECLARES OVER `we:scripts/pr-land.mjs`, WHICH ALREADY OWNS ALL OF THIS. That home opens the
 * self-approved PR, refuses a ref that is not `lane/*` (the #1934 carve-out), refuses a bodyless PR (#2332),
 * resolves the park label (#2622), runs the post-land id-collision heal (#2071) — and, load-bearing here,
 * applies the #2833 LANE-VERIFICATION FINISH-GUARD through the shared `we:scripts/lib/lane-verify.mjs`.
 * NOTHING in this file re-decides any of that, and re-checking the verify marker here would be a second
 * answer to a question `verifyGateDecision` already answers — the exact defect `verify` committed against
 * `verify-lane.mjs` before it was corrected.
 *
 * SO WHAT IS THIS FOR? Routing. The failure it closes is not a bad PR, it is a BYPASSED one.
 *
 * Three PRs were opened in one session by calling the GitHub connector directly instead of the home, because
 * on a host with no `gh` credential the home appears not to work and the connector obviously does. Every
 * guard above was skipped in one step. One of those three shipped with a red suite — precisely what the
 * #2833 finish-guard exists to prevent, absent because nothing routed through the guard. An operation is how
 * a step stops being reachable by "just do it another way": the declaration names the home, and the payload a
 * caller submits is the one the operation computed rather than one composed freehand.
 *
 * THE CREDENTIAL BOUNDARY IS DECLARED, NOT PAPERED OVER. `pr-land.mjs` needs `gh`. Where `gh` cannot
 * authenticate the `submit` effect FAILS and says so — it does not silently degrade to a direct API call,
 * because a fallback that quietly skips the home would reintroduce the bypass this exists to close. What the
 * operation always produces is the `plan`: the exact argv for the home AND the exact PR payload. A caller
 * holding a credential submits THAT, unedited. The same split as `record-verdict`, where the decision is made
 * here and the credentialed executor is CI.
 */
import { prepareItemFromRef, preparePrTitle } from './prepare-pr.mjs';
import { op } from './registry.mjs';
// #3224/#3245 — the raw invocation this operation declares over, now that it can genuinely replace it.
import { DECLARED_HOMES } from './declared-homes.mjs';
import { compute, effect } from './step-kinds.mjs';
import { HOME_REASONS } from './pr-land-reasons.mjs';

export const OPEN_PR_OP = 'open-pr';

/** The one effect: hand the planned argv to the home. */
export const SUBMIT_PR_EFFECT = 'open-pr.submit';

/**
 * How the home may be asked to leave the PR. Mirrors `pr-land.mjs`'s own modes rather than inventing any:
 *   · `park`      — open WITH a review label on it and stop (`--park=`, #2622). The default here, deliberately.
 *   · `label-on-green` — open, wait for required checks, label `ready-to-merge` when green (#2199).
 *   · `no-wait`   — open unlabelled and return; the drain collects it later.
 *
 * PARK IS THE DEFAULT because this operation's caller is an agent opening a PR for its own work. An agent
 * that opens a PR and lets it march toward `ready-to-merge` unreviewed is the shape #2171/#2262 park exists
 * to stop. Choosing the un-parked mode is then a deliberate flag rather than an omission.
 */
/**
 * `land` IS THE HOME'S OWN DEFAULT, and it is a MODE here rather than an omission (#x6ry8mf).
 *
 * `we:scripts/pr-land.mjs` with no mode flag does the most consequential thing it can: open, wait for the
 * required check, label `ready-to-merge`, and TRIGGER THE SINGLE-COUPLE FAST DRAIN that lands the PR. (It
 * never merges directly — #2290 — the drain does.) `label-on-green` stops at the label, so it is NOT a
 * substitute: pointing a caller of the default path at it leaves the PR sitting open, labelled and unlanded.
 *
 * That gap is why `we:skills-src/pr/SKILL.md` could not name this operation and had to carry an exemption
 * marker. Naming the mode explicitly — rather than letting it be "the one where you pass nothing" — keeps
 * the choice deliberate at the call site, which is the same reason `park` is the default below.
 */
export const OPEN_MODES = Object.freeze(['park', 'label-on-green', 'no-wait', 'land']);

/** The submission outcomes a caller acts on. THREE, for the reason `verify` has three. */
export const SUBMIT_OUTCOMES = Object.freeze(['opened', 'refused', 'unrun']);

/**
 * Plan the invocation. PURE.
 *
 * IT REFUSES ONLY WHAT IT CAN REFUSE WITHOUT RE-DECIDING. The ref shape and the non-empty body are checked
 * here because they are cheap and because the home's refusal for them arrives only after a push has already
 * happened — but they are the home's rules, restated as a pre-flight, and the home still applies them. The
 * verify marker is deliberately NOT among them: that decision has one home and this is not it.
 */
/** #81 — `--branch=lane/<slug>` is the caller-facing spelling of `ref`; `ref` wins when both are given. */
export function resolveRef({ ref, branch, derive = () => '' } = {}) {
  if (typeof ref === 'string' && ref.trim()) return ref.trim();
  if (typeof branch === 'string' && branch.trim()) return branch.trim();
  return derive();
}

export function planOpen({ ref, base, title, bodyFile, mode, parkLabel, sha = '', requireVerified = false, dryRun = false, skipPrePrReview = '' } = {}) {
  const prepareItem = prepareItemFromRef(ref);
  if (prepareItem) title = preparePrTitle(prepareItem);
  const problems = [];
  if (typeof ref !== 'string' || !/^lane\//.test(ref)) {
    problems.push(`\`ref\` must be a lane/* ref (the #1934 guard carve-out), got ${JSON.stringify(ref)}`);
  }
  // `title` IS OPTIONAL, and matching the home is the whole reason (#3245). `we:scripts/pr-land.mjs` computes
  // `derivedTitle = TITLE ?? <source commit subject> ?? \`land <ref>\``, so the home ALWAYS has a title —
  // omitting the flag hands the job to the commit subject rather than leaving the PR untitled. Requiring one
  // here made this operation stricter than the thing it declares over, and all six skill instructions of the
  // home omit it, so not one of them could name the operation without inventing a title that duplicates the
  // subject it would have derived anyway. That was the last gap keeping an `open-pr` entry out of the #3224
  // map.
  //
  // WHAT MUST NOT BE LOOSENED WITH IT: the home is headless-safe only because the argv is never TITLE-ONLY
  // (#2176 — a bare `--title` with no body drops into an interactive prompt and dies headless). `bodyFile`
  // stays REQUIRED above, so an omitted title can never produce that shape.
  // EMPTY MEANS OMITTED, exactly as it does for `sha` and for `verify`'s `gate`. That consistency is not
  // cosmetic: the input declares `default: ''`, so the command line hands this fn an EMPTY STRING whenever
  // `--title` is absent. A guard that refused empty-as-given would therefore have refused every call that
  // omitted the flag — which is every one of the six skill sites this change exists to unblock. My own test
  // caught it; the first cut of this rule was a refusal.
  if (title !== undefined && typeof title !== 'string') problems.push('`title` must be a string when given');
  // REQUIRED, EXCEPT ON A DRY RUN (#x6ry8mf). #2332's producer-side prevention exists because a bodyless PR
  // passes the producer and is then REFUSED at land, stalling the queue — but a `--dry-run` opens nothing, so
  // there is no PR to stall and no body to be missing. The home draws that line itself: its `prCreateBodyGuard`
  // guards the CREATE path only, and its own comment says the empty-body branch "is only ever reached by the
  // dry-run plan render, never by a real `gh pr create`". Requiring a body here for a rehearsal made the
  // operation stricter than the home for the one call that touches nothing — which is why `pr/SKILL.md`'s
  // rehearsal step could not name it.
  if (!dryRun && (typeof bodyFile !== 'string' || !bodyFile.trim())) {
    problems.push('`bodyFile` must name a file holding a non-empty body — the drain gate rejects a bodyless PR at land, which stalls the queue (not required with `dryRun`, which opens nothing)');
  }
  if (!OPEN_MODES.includes(mode)) problems.push(`\`mode\` must be one of ${OPEN_MODES.join('|')}`);
  if (mode === 'park' && !parkLabel) problems.push('`parkLabel` is required in `park` mode — that is what parking means');
  if (problems.length) throw new Error(`open-pr: cannot plan this PR — ${problems.join('; ')}`);

  const argv = ['--ref=' + ref, '--base=' + base];
  // OMITTED WHEN EMPTY, like `--title` and `--sha` — the third time this rule applies in this function, and
  // the first two did not carry it here. `--body-file=` with no path is not "no body": the home reads the
  // flag as a string and would try to READ the empty path. Only a dry run can reach an empty `bodyFile` at
  // all (the guard above requires one otherwise), and a dry run must pass no body rather than a broken one.
  if (typeof bodyFile === 'string' && bodyFile.trim()) argv.push('--body-file=' + bodyFile.trim());
  // OMITTED when absent, never passed empty: `--title=` would publish the empty string as the PR title,
  // which is not "let the home decide" — it is a titled PR with a blank title. Same rule as `--sha`.
  // TRIMMED IN BOTH PLACES. The verdict already reported `title.trim()`, so pushing the RAW value here made
  // the two disagree whenever a caller's title carried surrounding whitespace — the argv would publish
  // `"  a title  "` while the verdict claimed `"a title"`, and the verdict is what a caller reads back
  // (PR #1522 juror). One value, decided once.
  if (typeof title === 'string' && title.trim()) argv.splice(2, 0, '--title=' + title.trim());
  if (mode === 'park') argv.push('--park=' + parkLabel);
  else if (mode === 'label-on-green') argv.push('--label-on-green');
  else if (mode === 'no-wait') argv.push('--no-wait');
  // `land` PASSES NO MODE FLAG — that IS the home's default path, and inventing a `--land` the home does not
  // accept would fail at the shell rather than land anything. Written as an explicit branch instead of the
  // old `else`, so a fifth mode added later cannot silently inherit "pass nothing" and become `land` by
  // accident: that would turn a typo into the one mode that publishes.
  else if (mode !== 'land') throw new Error(`open-pr: unreachable mode ${JSON.stringify(mode)} — OPEN_MODES and this switch disagree`);

  // #3242 — the three flags every real call site passes and this operation could not express. Each is
  // OMITTED rather than passed with a falsey value, and for two different reasons that both matter:
  //
  //   · `--sha` DEFAULTS TO `HEAD` IN THE HOME (`typeof flags.sha === 'string' ? flags.sha : 'HEAD'`). An
  //     unset sha must therefore omit the flag and let the home apply that default — restating `'HEAD'` here
  //     would be a second answer to "which commit" that goes stale the day the home's default changes (#2644).
  //     This is the same shape as `verify`'s gate (#3240), which is the sibling gap this closes.
  //
  //   · THE TWO BOOLEANS ARE PRESENCE FLAGS, and passing them with a value is actively wrong. The home reads
  //     `!!flags['dry-run']`, and `!!'false'` is TRUE — so `--dry-run=false` would REQUEST a dry run while
  //     reading, to anyone scanning the argv, as though it had disabled one. A caller who set `dryRun: false`
  //     and got a rehearsal instead of a landed PR would have no way to see why. Omission is the only
  //     encoding of "off" the home understands.
  if (typeof sha === 'string' && sha.trim()) argv.push('--sha=' + sha.trim());
  if (requireVerified === true) argv.push('--require-verified');
  if (dryRun === true) argv.push('--dry-run');

  return {
    ref,
    base,
    title: typeof title === 'string' ? title.trim() : '',
    bodyFile,
    mode,
    ...(mode === 'park' ? { parkLabel } : {}),
    // Reported so a caller reading the verdict sees WHICH commit and WHICH guards this plan carries, rather
    // than having to re-parse `argv`. `sha` is empty exactly when the home's own default applies.
    sha: typeof sha === 'string' ? sha.trim() : '',
    requireVerified: requireVerified === true,
    dryRun: dryRun === true,
    // Consumed by the IO shell's pre-PR review check; never forwarded to pr-land.
    skipPrePrReview: typeof skipPrePrReview === 'string' ? skipPrePrReview.trim() : '',
    // The exact argv for the home. Exported in the verdict so a caller that must submit through another
    // channel submits what the operation decided rather than something it composed itself.
    argv,
  };
}

/**
 * The park an agent's own PR gets by default.
 *
 * `review:pending` AND NOT `review:human`, deliberately. `review:human` is the human-ONLY gate; an agent
 * applying it to its own routine work escalates every PR into the one queue that cannot be cleared by the AI
 * review pass, which is the dilution #2563 caps the scored rubric to avoid (it never reaches `review:human`).
 * `review:pending` says what is actually true here: an independent review is owed.
 *
 * It is derived from the home's own list rather than typed, so it cannot name a label the home refuses.
 */
export function defaultParkLabel(parkLabels) {
  const pending = parkLabels.find((l) => /pending$/.test(l));
  if (!pending) {
    throw new TypeError(
      `open-pr: none of the home's park labels (${parkLabels.join(', ')}) is a \`pending\` one, so there is no `
      + 'safe default park. Refusing rather than defaulting to the human-only gate.',
    );
  }
  return pending;
}

export function openPrOperation({ parkLabels, deriveRef = () => '' } = {}) {
  if (!Array.isArray(parkLabels) || parkLabels.length === 0) {
    throw new TypeError(
      'open-pr: needs `pr-land.mjs`\'s own PARK_LABELS — the set of labels a PR may be parked with has one '
      + 'home, and a second list here would let this operation ask for a park the home refuses.',
    );
  }

  return op(OPEN_PR_OP, {
    declaresOver: DECLARED_HOMES['open-pr'],
    input: {
      // A lane ref, never a local branch — the home's rule, and the pre-flight above states it early.
      // #81 — optional now: `--branch=` is the same thing, and with neither the ref derives from the lane lease's
      // purpose. pr-land itself pushes `<sha>:refs/heads/<ref>`, so no local branch is ever created.
      ref: { type: 'string', required: false, default: '' },
      branch: { type: 'string', required: false, default: '' },
      base: { type: 'string', required: false, default: 'main' },
      // Optional — see `planOpen`. Empty means "the home derives it from the commit subject".
      title: { type: 'string', required: false, default: '' },
      // A PATH, not the body: a PR body is multi-line prose and an argv-borne one gets mangled, which is why
      // the home prefers `--body-file` too (#2170).
      // OPTIONAL IN THE SCHEMA, ENFORCED IN `planOpen` — and the split is deliberate rather than sloppy. The
      // requirement is CONDITIONAL (#x6ry8mf: a `dryRun` opens nothing, so it needs no body), and the input
      // schema has no way to say "required unless another field is set". Leaving it `required: true` here
      // would refuse a legal dry run at the command line, BEFORE the step that knows the condition ever runs.
      bodyFile: { type: 'string', required: false, default: '' },
      mode: { type: 'string', required: false, default: 'park', enum: [...OPEN_MODES] },
      parkLabel: { type: 'string', required: false, default: defaultParkLabel(parkLabels), enum: [...parkLabels] },
      // #3242 — the three the home takes and this operation could not pass. Every one of the six skill
      // instructions of `we:scripts/pr-land.mjs` uses at least one, so without them, rewiring any of those
      // sites to the operation would silently drop a flag: the PR #1508 regression shape.
      //
      // `sha` PINS THE COMMIT being published to the lane ref. Empty means "the home's default" (`HEAD`), not
      // "no commit" — the default lives in the home and is not restated here (#2644).
      sha: { type: 'string', required: false, default: '' },
      // The #2833 finish-guard: refuse to land a HEAD with no green verification marker. Defaulting it to
      // `true` would be a policy change smuggled in as a schema edit — the home's callers decide.
      requireVerified: { type: 'boolean', required: false, default: false },
      // Rehearsal: the home prints the exact gh sequence and executes nothing.
      dryRun: { type: 'boolean', required: false, default: false },
      skipPrePrReview: { type: 'string', required: false, default: '' },
    },
    verdictFrom: 'plan',

    plan: compute({
      // EVERY FIELD THE FN READS MUST BE DECLARED HERE. The engine projects only the declared reads, so a
      // field missing from this list arrives as `undefined` no matter what the caller passed — the wiring bug
      // PR #1516's round-1 juror found in `verify`, where the io layer was tested and this layer was not.
      reads: [
        'input.ref', 'input.branch', 'input.base', 'input.title', 'input.bodyFile', 'input.mode', 'input.parkLabel',
        'input.sha', 'input.requireVerified', 'input.dryRun', 'input.skipPrePrReview',
      ],
      fn: (view) => planOpen({
        ref: resolveRef({ ref: view.input.ref, branch: view.input.branch, derive: deriveRef }),
        base: view.input.base,
        title: view.input.title,
        bodyFile: view.input.bodyFile,
        mode: view.input.mode,
        parkLabel: view.input.parkLabel,
        sha: view.input.sha,
        requireVerified: view.input.requireVerified,
        dryRun: view.input.dryRun,
        skipPrePrReview: view.input.skipPrePrReview,
      }),
    }),

    submit: effect({
      reads: ['verdict'],
      // NOT idempotent, and that is the honest declaration: opening a PR twice for one ref is not a replay
      // that converges — the home may already have created one, and the second call's outcome depends on
      // state this operation does not own. The engine therefore refuses to blind-retry it, which is right.
      effects: (view) => [{
        type: SUBMIT_PR_EFFECT,
        idempotent: false,
        payload: { argv: view.verdict.argv, ref: view.verdict.ref, mode: view.verdict.mode, skipPrePrReview: view.verdict.skipPrePrReview },
      }],
    }),
  });
}

/**
 * The home's own `reason` vocabulary, split by WHAT THE CALLER SHOULD DO (`opened` / `refused` / `unrun`).
 * The table lives in the leaf `./pr-land-reasons.mjs` (see its header for the buckets' meaning) so a module
 * needing only the table does not import this operation's registry; it is re-exported here unchanged.
 */
export { HOME_REASONS };

/**
 * Map the home's report onto the three outcomes. PURE.
 *
 * `refused` and `unrun` are kept apart for the same reason `verify` keeps `fail` and `unrun` apart: a home
 * that refused has ANSWERED — the ref was wrong, the body was empty, the verify marker was not green — and a
 * home that could not run has not. Only the first tells the caller what to fix.
 *
 * AN UNRECOGNISED REASON IS `unrun`, deliberately. The home may grow a reason this table has not learned,
 * and "we do not know whether a guard fired" is not the same as "a guard fired". Reporting `refused` on a
 * reason we cannot interpret would claim an answer nobody gave — the failure mode this whole family of
 * operations exists to refuse. The raw reason rides along so the caller can read what actually happened.
 */
export function classifySubmit({ status, signal, stdout = '', stderr = '', error } = {}) {
  const tail = `${stdout}${stderr}`.trim().split('\n').slice(-3).join(' / ').slice(0, 300);
  if (error) return { outcome: 'unrun', reason: `could not run pr-land: ${error.message}` };
  if (signal) return { outcome: 'unrun', reason: `pr-land killed by ${signal} — it may or may not have opened a PR, so this is NOT a refusal` };

  let parsed = null;
  try { parsed = JSON.parse(String(stdout).trim().split('\n').filter(Boolean).at(-1) ?? ''); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') {
    return { outcome: 'unrun', reason: `exit ${status ?? '?'} with no parseable report from pr-land — this is NOT a refusal and NOT an open. Last output: ${tail || '<empty>'}` };
  }
  // THE `reason` IS CONSULTED FIRST, AND THE ORDER IS THE WHOLE CORRECTNESS OF THIS FUNCTION.
  //
  // A `pr` field does NOT mean success. In `label-on-green` mode the home opens the PR and THEN waits on
  // required checks, so its post-open refusals carry BOTH a `pr` number (the PR exists by then) and a
  // refusal `reason`: `check-red`, `behind`, `conflict`, `check-timeout`, and the post-open `empty-body`
  // recheck — five real `emit()` sites in `we:scripts/pr-land.mjs`. Testing `parsed.pr` first reported a RED
  // REQUIRED CHECK as `opened`, which is the precise failure class this operation exists to prevent,
  // recurring inside it and in the CI-gating mode. Found by the correctness juror on PR #1500, which
  // reconstructed this function and fed it the home's actual payload.
  if (parsed.reason) {
    // The home's OWN word for what happened decides, not the exit code and not the presence of a `pr`:
    // pr-land exits 3 for a guard refusal AND for an environment failure, so neither signal separates them.
    // #79 — `check-timeout` AFTER the PR opened is not "not opened": the PR is real, only the green-wait label
    // step is pending, and the drain's ci-lifecycle reconcile finishes it (#2421). Report that truthfully.
    if (parsed.reason === 'check-timeout' && parsed.pr) {
      return {
        outcome: 'opened', reason: 'check-timeout', labelStep: 'deferred',
        detail: `PR #${parsed.pr} open; label step deferred to the drain's ci-lifecycle reconcile`,
        pr: parsed.pr, url: parsed.url ?? null,
      };
    }
    const known = HOME_REASONS[parsed.reason];
    const outcome = known === 'opened' ? 'opened' : (known ?? 'unrun');
    return {
      outcome,
      reason: parsed.reason,
      detail: parsed.detail ?? tail,
      // Carried even on a refusal: a post-open refusal names a PR that EXISTS, and the caller needs its
      // number to go look at what was opened-then-refused.
      pr: parsed.pr ?? null,
      url: parsed.url ?? null,
      verifyStatus: parsed.verifyStatus ?? null,
      ...(known ? {} : { unclassified: true }),
    };
  }
  // Only with no `reason` at all does a `pr`/`url` imply an open.
  if (parsed.pr || parsed.url) return { outcome: 'opened', pr: parsed.pr ?? null, url: parsed.url ?? null, parked: parsed.parked ?? null };
  return { outcome: 'unrun', reason: `pr-land exited ${status ?? '?'} without opening a PR or naming a refusal: ${tail || '<empty>'}` };
}

/**
 * Read this OPERATION's own `submit` outcome (this file's {@link classifySubmit} shape — `.pr`/`.url`/
 * `.outcome`/`.reason`) out of the FULL run-outcome envelope that `run.mjs open-pr --json` actually prints on
 * stdout, i.e. `cli-adapter.mjs#outcomePayload`'s `{runId, op, stopped, applied, inFlight, pending, verdict,
 * findings, telemetry, spend}`.
 *
 * THE BUG THIS CLOSES (#3627 bug 13, live on PR #2109, and STILL live after a first fix attempt that only
 * renamed `.number` to `.pr` without checking where `.pr` actually lives): a caller that does
 * `JSON.parse(stdout).pr` gets `undefined` on every real call, because the envelope carries no top-level
 * `pr`/`url` at all — this operation's `verdictFrom` is `'plan'` (so `run.verdict` is the PRE-submit plan, not
 * the submission result), and the submit step's own result — the ONLY place `pr`/`url` genuinely live — is
 * nested at `findings.submit.effects[0].result` (`engine.mjs#effectFinding`). Confirmed empirically: a real
 * `--dryRun` invocation's JSON has no top-level `pr` key, and its actual `pr` (`null`, for a dry run) sits at
 * exactly that nested path.
 *
 * When the run never reached `submit` at all (the `plan` step refused — e.g. a bad ref — so `findings` is
 * `{}`), synthesizes the same `unrun` shape `classifySubmit` would report for "no parseable report": there is
 * no PR to name, so `pr`/`url` are `null`, and `reason` carries the envelope's own top-level `error`.
 *
 * PURE — reads the parsed payload, calls nothing, spawns nothing.
 */
export function extractSubmitResult(payload) {
  const result = payload?.findings?.submit?.effects?.[0]?.result;
  if (result && typeof result === 'object') return result;
  return {
    outcome: 'unrun',
    reason: payload?.error
      ?? `open-pr: run ${JSON.stringify(payload?.stopped ?? 'unknown')} never reached its submit step — no PR was opened`,
    pr: null,
    url: null,
  };
}

/** Human submit summary; the effect completing does not mean the home opened a PR. */
export function describeSubmit(result) {
  if (result.outcome === 'opened' && result.labelStep === 'deferred') {
    return { line: `submit: opened #${result.pr}${result.url ? ` ${result.url}` : ''} — ${result.detail}`, failed: false };
  }
  if (result.outcome === 'opened') {
    return { line: `submit: opened #${result.pr} ${result.url}`, failed: false };
  }
  if (result.outcome === 'refused') {
    return { line: `submit: REFUSED (${result.reason})${result.pr != null ? ` — PR #${result.pr}` : ''}`
      + (result.detail ? ` — ${result.detail}` : ''), failed: true };
  }
  if (result.outcome === 'unrun' && result.reason === 'dry-run') {
    return { line: 'submit: dry run — nothing opened', failed: false };
  }
  return { line: `submit: NOT RUN — ${result.reason}`, failed: true };
}
