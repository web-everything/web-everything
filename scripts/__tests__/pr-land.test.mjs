/**
 * @file scripts/__tests__/pr-land.test.mjs
 * @description Unit proof of the pure helpers in `scripts/pr-land.mjs` — the self-approved-PR landing
 *   substrate for #2138 Fork 5 (#2153): the `gh pr create`/`gh pr merge` arg construction and the
 *   check-classification that decides merge-vs-wait-vs-abort. The live gh/git driver is the I/O boundary.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pushFailedDetail, mergeMethodFlag, buildCreateArgs, prCreateBodyGuard, buildMergeArgs, buildRenumberHealArgs, buildRegenArgs, buildAddLabelArgs, classifyChecks, planPrLand, pollVerdict, isPostLandTreeDirty, postLandSkips, postLandReport, scopeHealChangedPaths, resolveProducerReviewLabel, resolveRosterReconcile, resolveParkLabel, withAuthorStamp, composePrBody, PARK_LABELS, decideHoldReadyStrip, resolveDraft, unlabelledHandOffLabel } from '../pr-land.mjs';
import { REVIEW_LABELS, REVIEW_LABEL_META, READY_TO_MERGE_LABEL, scoreEscalation } from '../lib/review-escalation.mjs';
import { buildAuthorActorMarker, parseAuthorActorId } from '../lib/review-independence.mjs';
import { PANEL_LENSES } from '../lib/review-core.mjs';

// ── #2844 · the AUTHOR STAMP pr-land writes at PR-open ─────────────────────────────────────────────────────────
// PR #1100 review: this half had ZERO coverage. `withAuthorStamp` was module-private and read a module-scope
// marker, so mutating it to stop stamping passed all 65 pr-land tests — while silently disarming the whole
// self-clear mechanism, which needs BOTH halves (this stamp, and review-set-label's comparison against it) to
// mean anything. The producer's half is proved here, round-trip through the REAL reader, plus the wiring that
// puts it on the body `gh pr create` actually receives.
describe('#2844 — pr-land stamps the PR author into the body at open', () => {
  const MARKER = buildAuthorActorMarker('sess-author-1');

  it('THE STAMP IS WRITTEN, and the real reader gets the author id back (round-trip, not substring)', () => {
    const stamped = withAuthorStamp('Resolve #1: something real.', MARKER);
    expect(stamped).not.toBe('Resolve #1: something real.');
    expect(parseAuthorActorId(stamped)).toBe('sess-author-1');
    // The human body survives intact — the stamp is appended, never a replacement.
    expect(stamped).toContain('Resolve #1: something real.');
  });

  it('is IDEMPOTENT — a re-run never appends a second stamp, and never re-attributes an existing one', () => {
    const once = withAuthorStamp('body', MARKER);
    expect(withAuthorStamp(once, MARKER)).toBe(once);
    // A DIFFERENT session re-running the producer must not overwrite the original attribution.
    const other = withAuthorStamp(once, buildAuthorActorMarker('sess-later'));
    expect(other).toBe(once);
    expect(parseAuthorActorId(other)).toBe('sess-author-1');
  });

  it('no session id → NO marker, and an empty body is left untouched (never a marker-only #2324 body)', () => {
    expect(withAuthorStamp('body', '')).toBe('body');
    for (const empty of ['', '   ', null, undefined]) expect(withAuthorStamp(empty, MARKER)).toBe(empty);
  });

  it('THE WIRING: composePrBody — the body gh actually receives carries BOTH the manifest and the stamp', () => {
    // The mutation this catches is "the composition stops calling withAuthorStamp" — the create body is what the
    // reviewer's independence check later reads, so a stamp that exists but is never attached buys nothing.
    const manifest = { schema: 1, repos: [] };
    const composed = composePrBody('Resolve #1: real.', manifest, MARKER);
    expect(parseAuthorActorId(composed)).toBe('sess-author-1');
    expect(composed).toContain('Resolve #1: real.');
    // …and with no manifest the stamp is still attached (the ordinary single-repo lane).
    expect(parseAuthorActorId(composePrBody('Resolve #1: real.', null, MARKER))).toBe('sess-author-1');
  });

  it('SOURCE CONTRACT: the create body and the re-run backfill BOTH go through composePrBody', () => {
    // Belt-and-braces on the one thing a pure test cannot see: that the module-scope CREATE_BODY, and the
    // best-effort edit that backfills an already-open PR, are built by the composer rather than around it.
    const src = readFileSync(resolve(process.cwd(), 'scripts/pr-land.mjs'), 'utf8');
    expect(src).toMatch(/const CREATE_BODY = composePrBody\(BODY\)/);
    expect(src).toMatch(/const updated = composePrBody\(liveBody\)/);
  });
});

describe('resolveProducerReviewLabel — #2307 deterministic review-escalation label AT PR-OPEN', () => {
  it('a DECLARATIVE-LEASH diff (the roster — the encoded policy itself) → review:human, applied', () => {
    const v = resolveProducerReviewLabel({ changedFiles: ['scripts/lib/gate-config.mjs'], diffLines: 10 });
    expect(v.label).toBe(REVIEW_LABELS.human);
    expect(v.apply).toBe(true);
    expect(v.humanRequired).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/gate-self/);
  });
  it('#2771/#2785 — a policy-tier DERIVATION-CODE diff → review:pending (the committee), never review:human', () => {
    const v = resolveProducerReviewLabel({ changedFiles: ['scripts/lib/review-escalation.mjs'], diffLines: 10 });
    expect(v.label).toBe(REVIEW_LABELS.pending);
    expect(v.apply).toBe(true);
    expect(v.humanRequired).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/gate-derivation/);
  });
  it('#2771 Fork A — a STATUTE diff is UNCHANGED by the narrowing: still review:human', () => {
    const v = resolveProducerReviewLabel({ changedFiles: ['docs/agent/platform-decisions.md'], diffLines: 10 });
    expect(v.label).toBe(REVIEW_LABELS.human);
    expect(v.humanRequired).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/statute/);
  });
  it('an escalating non-gate-self diff (blast-radius) → review:pending, applied', () => {
    const v = resolveProducerReviewLabel({ changedFiles: ['scripts/pr-land.mjs'], diffLines: 10 });
    expect(v.label).toBe(REVIEW_LABELS.pending);
    expect(v.apply).toBe(true);
    expect(v.humanRequired).toBe(false);
  });
  it('a leaf diff with no escalation signal → no review label at all', () => {
    const v = resolveProducerReviewLabel({ changedFiles: ['backlog/2307-x.md'], diffLines: 10 });
    expect(v.label).toBe(null);
    expect(v.apply).toBe(false);
  });
  it('cross-repo + dismissed-findings signals off the manifest also escalate (review:pending)', () => {
    expect(resolveProducerReviewLabel({ crossRepo: true }).label).toBe(REVIEW_LABELS.pending);
    expect(resolveProducerReviewLabel({ dismissedFindings: 2 }).label).toBe(REVIEW_LABELS.pending);
  });
  it('a PR that already carries the verdict label is NOT re-applied (idempotent — never a double-apply)', () => {
    const v = resolveProducerReviewLabel({ changedFiles: ['scripts/pr-land.mjs'], diffLines: 10, currentLabels: [REVIEW_LABELS.pending] });
    expect(v.label).toBe(REVIEW_LABELS.pending);
    expect(v.apply).toBe(false);
  });
  it('#2890 — accepts diffHunks and is otherwise unaffected by it (pure plumbing, no detector reads it yet)', () => {
    const hunks = '@@ -1,2 +1,2 @@\n-old\n+new\n';
    const withHunks = resolveProducerReviewLabel({ changedFiles: ['scripts/pr-land.mjs'], diffLines: 10, diffHunks: hunks });
    const withoutHunks = resolveProducerReviewLabel({ changedFiles: ['scripts/pr-land.mjs'], diffLines: 10 });
    expect(withHunks.label).toBe(withoutHunks.label);
    expect(withHunks.apply).toBe(withoutHunks.apply);
    expect(withHunks.humanRequired).toBe(withoutHunks.humanRequired);
    expect(withHunks.reasons).toEqual(withoutHunks.reasons);
    expect(() => resolveProducerReviewLabel({ diffHunks: undefined })).not.toThrow();
  });
  it('#2890-review-fix finding 1 — the producer-side default is null (NOT COMPUTED), never the fail-open \'\'', () => {
    // `scoreEscalation` is what a follow-on detector reads, so the producer wrapper must not re-introduce the
    // `''` default underneath it: a `resolveProducerReviewLabel` caller with no diff in hand must be
    // distinguishable from one whose diff genuinely has no content.
    expect(scoreEscalation({ changedFiles: ['scripts/pr-land.mjs'] }).diffHunks).toBeNull();
    expect(scoreEscalation({ changedFiles: ['scripts/pr-land.mjs'], diffHunks: '' }).diffHunks).toBe('');
  });
});

describe('decideHoldReadyStrip — #2832/#984 findings 4+5 (held signal + observed-label strip gate)', () => {
  const rtm = READY_TO_MERGE_LABEL;
  it('#5 — a held PR that OBSERVABLY carries ready-to-merge is stripped, regardless of this run\'s applyLabel', () => {
    // currentLabels reflects the PR (add succeeded on a prior run / this run); the strip fires off THAT, not a
    // this-run `labelApplied` flag — so a transient add failure this pass can never leave a stale go-ahead.
    for (const hold of [REVIEW_LABELS.human, REVIEW_LABELS.pending, REVIEW_LABELS.changes]) {
      expect(decideHoldReadyStrip(hold, [rtm])).toEqual({ held: true, strip: true });
    }
  });
  it('#4 — a held PR with NO ready-to-merge to strip is STILL flagged held (distinct from an apply failure)', () => {
    // No go-ahead present ⇒ nothing to strip, but the PR is deliberately held — `held` stays true so the workflow
    // never re-labels it. This is the signal that is NOT `labelApplied:false`.
    expect(decideHoldReadyStrip(REVIEW_LABELS.human, [])).toEqual({ held: true, strip: false });
    expect(decideHoldReadyStrip(REVIEW_LABELS.pending, ['some:other'])).toEqual({ held: true, strip: false });
  });
  it('a non-hold verdict (or null) is neither held nor a strip — a clean/accepted PR keeps its go-ahead', () => {
    expect(decideHoldReadyStrip(null, [rtm])).toEqual({ held: false, strip: false });
    expect(decideHoldReadyStrip(REVIEW_LABELS.accepted, [rtm])).toEqual({ held: false, strip: false });
  });
  it('handles {name}-shaped observed labels, not just strings', () => {
    expect(decideHoldReadyStrip(REVIEW_LABELS.human, [{ name: rtm }])).toEqual({ held: true, strip: true });
  });
  it('#984 R4 — an OBSERVED hold is STICKY: a clean fresh verdict on an already-held PR is STILL held (and strips a stray go-ahead)', () => {
    // The fresh rubric came back clean (verdict null / accepted), but the PR ALREADY carries review:human (a prior
    // park, a #2409 re-park, a human). Without stickiness pr-land emits held:false and its unconditional
    // applyLabel() leaves the PR held AND ready — the forbidden state. `held` must stay true off the observed hold.
    expect(decideHoldReadyStrip(null, [REVIEW_LABELS.human, rtm])).toEqual({ held: true, strip: true });
    expect(decideHoldReadyStrip(REVIEW_LABELS.accepted, [REVIEW_LABELS.pending])).toEqual({ held: true, strip: false });
  });
  it('#984 minor 1 — the strip is belt-and-braced on this-run labelApplied when the live label read FAILS OPEN to []', () => {
    // A transient `gh pr view --json labels` miss caught to currentLabels=[] would (off observed labels alone)
    // return strip:false and leave the go-ahead this run just stamped. `labelApplied` (this run added ready-to-merge)
    // forces the strip so a held PR is never left ready on a read hiccup.
    expect(decideHoldReadyStrip(REVIEW_LABELS.human, [], { labelApplied: true })).toEqual({ held: true, strip: true });
    // …but without the go-ahead actually present or applied this run, there is nothing to strip.
    expect(decideHoldReadyStrip(REVIEW_LABELS.human, [], { labelApplied: false })).toEqual({ held: true, strip: false });
  });
  // #984 F3 — THE MISSING SHAPE, and the exact boundary of what the `labelApplied` belt can cover. The belt
  // engages only once `held` is true, and with a failed label read (`currentLabels` caught to `[]`) AND a clean
  // fresh verdict there is NO hold evidence from either input — so a genuinely held PR this run just stamped is
  // left held-and-ready. That is a real residual and it is pinned here rather than papered over.
  //
  // It is NOT fixable by widening: computing `strip` from `labelApplied` independently of `held` (the review's
  // suggested shape) would strip the go-ahead from EVERY healthy PR the producer just stamped — the second
  // assertion below is what that widening would break. The residual is covered DOWNSTREAM instead, by the
  // drain's `decideParkReadyStrip` seam, which strips on observed holds every pass for all three hold labels
  // with no dependence on this run's reads. The doc on `decideHoldReadyStrip` states exactly this scope.
  it('#984 F3 — a clean fresh verdict + a failed label read is NOT held, so the belt does not engage', () => {
    expect(decideHoldReadyStrip(null, [], { labelApplied: true })).toEqual({ held: false, strip: false });
  });
  it('#984 F3 — and it must stay that way: a healthy PR must never be un-queued by its own go-ahead stamp', () => {
    // The happy path — clean rubric, no hold anywhere, this run added ready-to-merge. `strip` MUST be false.
    expect(decideHoldReadyStrip(null, [READY_TO_MERGE_LABEL], { labelApplied: true })).toEqual({ held: false, strip: false });
    expect(decideHoldReadyStrip(REVIEW_LABELS.accepted, [READY_TO_MERGE_LABEL], { labelApplied: true })).toEqual({ held: false, strip: false });
  });
});

describe('pr-land post-land dirty-probe (#2225 — deps-symlinked clone must still heal/regen)', () => {
  it('a tree whose ONLY dirt is the untracked node_modules symlink is NOT blocking-dirty', () => {
    // `git status --porcelain --untracked-files=no` already hides it; the extra guard covers a tracked symlink.
    expect(isPostLandTreeDirty('?? node_modules\n')).toBe(false);
    expect(isPostLandTreeDirty(' M node_modules\n')).toBe(false);
    expect(isPostLandTreeDirty('')).toBe(false);
  });
  it('a genuinely TRACKED-dirty file blocks (a detached checkout could sweep it into the post-land commit)', () => {
    expect(isPostLandTreeDirty(' M .claude/skills/batch-backlog-items/claims.json\n')).toBe(true);
    expect(isPostLandTreeDirty(' M src/_data/blocks.json\n?? node_modules\n')).toBe(true);
  });
  it('postLandSkips lists only the steps that actually skipped (loud-skip surfacing)', () => {
    expect(postLandSkips({ skipped: true }, { done: [], failed: [] })).toEqual(['heal']);
    expect(postLandSkips({ healed: false }, { skipped: true })).toEqual(['regen']);
    expect(postLandSkips({ skipped: true }, { skipped: true })).toEqual(['heal', 'regen']);
    expect(postLandSkips({ healed: true }, { done: ['x'] })).toEqual([]);
    expect(postLandSkips(null, null)).toEqual([]);
  });
});

describe('postLandReport — the success line never throws when regen/heal is skipped or unset (#2218)', () => {
  it('SKIPPED regen (dirty checkout) reports "skipped", it does NOT read regen.done.length and crash', () => {
    // The reported bug: `regen` is `{ skipped:true, done:[], failed:[] }` (or unset) on the dirty-checkout /
    // --no-regen path; the old `regen.done.length` read threw a TypeError and misreported a successful land.
    const regen = { skipped: true, done: [], failed: [], warning: 'skipped derived-artifact regen — …' };
    expect(() => postLandReport(null, regen)).not.toThrow();
    expect(postLandReport(null, regen)).toBe('; derived-artifact regen: skipped (tracked-dirty tree)');
  });
  it('--no-regen / --no-heal (both null) → empty suffix, no throw', () => {
    expect(postLandReport(null, null)).toBe('');
  });
  it('a regen that ran but changed nothing reports "regenerated: none" (not a crash, not silence)', () => {
    expect(postLandReport(null, { done: [], failed: [] })).toBe('; regenerated: none');
  });
  it('reports the healed collisions and the regenerated artifacts on the happy path', () => {
    const heal = { healed: true, renumbered: [{ oldNum: '2219', newNum: '2220' }] };
    const regen = { done: ['npm run gen:inventory'], failed: [] };
    expect(postLandReport(heal, regen)).toBe('; healed id collision(s): #2219→#2220; regenerated: npm run gen:inventory');
  });
  it('a skipped heal reports skipped; a non-fatal regen failure is surfaced', () => {
    expect(postLandReport({ skipped: true }, { done: [], failed: [{ cmd: 'npm run gen:reference-index' }] }))
      .toBe('; id-collision heal: skipped (tracked-dirty tree); regen failed (non-fatal): npm run gen:reference-index');
  });
  it('tolerates a regen object missing its arrays entirely (optional-chained reads)', () => {
    expect(() => postLandReport({}, {})).not.toThrow();
    expect(postLandReport({}, {})).toBe('; regenerated: none');
  });
});

describe('pr-land pure helpers (#2138 Fork 5 / #2153)', () => {
  it('maps merge methods to gh flags (default = --merge, the no-ff history the drain wants)', () => {
    expect(mergeMethodFlag('merge')).toBe('--merge');
    expect(mergeMethodFlag('squash')).toBe('--squash');
    expect(mergeMethodFlag('rebase')).toBe('--rebase');
    expect(mergeMethodFlag(undefined)).toBe('--merge');
    expect(mergeMethodFlag('bogus')).toBe('--merge');
  });

  it('builds a self-approved PR create (NO reviewer; body never dropped; --fill only when nothing given)', () => {
    // Bare create (no title, no body): --fill autofills both from commits — the fallback branch.
    expect(buildCreateArgs({ base: 'main', head: 'lane/2153-x' }))
      .toEqual(['pr', 'create', '--base', 'main', '--head', 'lane/2153-x', '--fill']);
    // No --reviewer is ever added — self-approved (0 required approvals, #2152).
    expect(buildCreateArgs({ base: 'main', head: 'lane/2153-x' })).not.toContain('--reviewer');
    // With an explicit title+body: --title/--body, NO --fill (an explicit pair is complete on its own).
    const withTitle = buildCreateArgs({ base: 'main', head: 'lane/2153-x', title: 'land #2153', body: 'b' });
    expect(withTitle).toContain('--title');
    expect(withTitle).not.toContain('--fill');
    expect(withTitle[withTitle.indexOf('--body') + 1]).toBe('b');
    // BODY WITHOUT TITLE (the #2170 dismissals path): the body is HONORED, not dropped — and no --fill (which
    // is unusable for a remote-only lane/* head). The pr-land CLI derives a title from the commit subject so
    // a real create is always complete; this pure builder faithfully keeps the body regardless.
    const bodyOnly = buildCreateArgs({ base: 'main', head: 'lane/2170-x', body: '## Dismissed review findings\n- x' });
    expect(bodyOnly).toContain('--body');                     // body is present…
    expect(bodyOnly[bodyOnly.indexOf('--body') + 1]).toBe('## Dismissed review findings\n- x'); // …and unmangled
    expect(bodyOnly).not.toContain('--fill');                 // never --fill when a body is supplied
    // TITLE WITHOUT BODY (#2176): a title-only argv drops gh into an interactive body prompt and fails
    // headless — so the builder must ALWAYS carry a body when a title is present (an empty `--body ""`),
    // and never fall back to --fill (unusable for a remote-only lane/* head).
    const titleOnly = buildCreateArgs({ base: 'main', head: 'lane/2176-x', title: 'land #2176', body: null });
    expect(titleOnly).toContain('--body');                    // a body is always present…
    expect(titleOnly[titleOnly.indexOf('--body') + 1]).toBe(''); // …an explicit empty body (non-interactive)
    expect(titleOnly).not.toContain('--fill');                // never --fill for a lane/* head
  });

  it('#2332 prCreateBodyGuard — refuses a bodyless create, allows a non-empty body (producer fail-fast)', () => {
    // A real, non-empty body → ok (the create proceeds).
    expect(prCreateBodyGuard('## Real body\n- x').ok).toBe(true);
    expect(prCreateBodyGuard('## Real body\n- x').reason).toBeUndefined();
    // The bodyless cases the #2324 drain gate would later refuse to LAND — the producer must fail fast now.
    for (const empty of [null, undefined, '', '   ', '\n\t ']) {
      const g = prCreateBodyGuard(empty);
      expect(g.ok).toBe(false);            // refused at open…
      expect(g.reason).toMatch(/bodyless/); // …with a reason naming the omission (#2332)
    }
  });

  it('builds a one-PR merge that deletes the lane ref (not --auto on a native queue)', () => {
    expect(buildMergeArgs({ pr: 4, method: 'merge' }))
      .toEqual(['pr', 'merge', '4', '--merge', '--delete-branch']);
    expect(buildMergeArgs({ pr: 7, method: 'squash' })).not.toContain('--auto'); // drain owns ordering
  });

  it('omits --onto-ref when no pre-merge main sha is known (falls back to the git-ordinal heuristic, #2071)', () => {
    expect(buildRenumberHealArgs()).toEqual(['scripts/backlog-renumber-collisions.mjs', '--json']);
    expect(buildRenumberHealArgs({}).some((a) => a.startsWith('--onto-ref'))).toBe(false);
    expect(buildRenumberHealArgs()).not.toContain('--force');
  });

  it('passes --onto-ref=<pre-merge-main sha> so a published id is never yielded (resume-land fix, #2213)', () => {
    // Files already on the branch being landed ONTO are immutable keepers: only the INCOMING lane's new file
    // may yield — otherwise a lagging lane authored first, landing last, would renumber a live main item.
    const sha = 'a'.repeat(40);
    expect(buildRenumberHealArgs({ ontoRef: sha })).toEqual(['scripts/backlog-renumber-collisions.mjs', '--json', `--onto-ref=${sha}`]);
  });

  it('returns the derived-artifact regen command set in lock-step with the drain (gen:inventory + gen:reference-index, #2182)', () => {
    const cmds = buildRegenArgs();
    // Must be an array of [cmd, ...args] tuples (same shape as lane-drain.mjs DERIVED_REGEN).
    expect(Array.isArray(cmds)).toBe(true);
    expect(cmds.length).toBeGreaterThan(0);
    // Every entry is itself an array (the [cmd, ...args] tuple shape).
    for (const entry of cmds) expect(Array.isArray(entry)).toBe(true);
    // The two drain-equivalent generators must be present.
    const flat = cmds.map((c) => c.join(' '));
    expect(flat).toContain('npm run gen:inventory');
    expect(flat).toContain('npm run gen:reference-index');
    // No generator that writes OUTSIDE the WE repo (no impl-repo commands).
    for (const f of flat) expect(f).not.toMatch(/frontierui|plateau-app/);
  });

  it('builds the ready-to-merge label-apply args, and skips when disabled (#2196)', () => {
    // Default: apply the producer-certified label so the label lander (/drain) collects the PR.
    expect(buildAddLabelArgs({ pr: 60, label: 'ready-to-merge' }))
      .toEqual(['pr', 'edit', '60', '--add-label', 'ready-to-merge']);
    // --label=<name> overrides the label name.
    expect(buildAddLabelArgs({ pr: 5, label: 'draft-ok' }))
      .toEqual(['pr', 'edit', '5', '--add-label', 'draft-ok']);
    // --no-label (label null) → no args (PR opened UNlabelled, not auto-collected).
    expect(buildAddLabelArgs({ pr: 60, label: null })).toBe(null);
    // No PR number known → nothing to label.
    expect(buildAddLabelArgs({ pr: null, label: 'ready-to-merge' })).toBe(null);
  });

  it('classifies checks: pass → merge, any fail → abort, any pending → wait', () => {
    expect(classifyChecks([]).status).toBe('passed');                                  // no required checks
    expect(classifyChecks([{ bucket: 'pass' }, { bucket: 'skipping' }]).status).toBe('passed');
    expect(classifyChecks([{ bucket: 'pass' }, { bucket: 'pending' }]).status).toBe('pending');
    expect(classifyChecks([{ bucket: 'pass' }, { bucket: 'fail' }]).status).toBe('failed');
    // fail dominates pending (never merge a red PR even if something else is still running).
    expect(classifyChecks([{ bucket: 'pending' }, { bucket: 'fail' }]).status).toBe('failed');
    // tolerates the raw `state` field when `bucket` is absent.
    expect(classifyChecks([{ state: 'in_progress' }]).status).toBe('pending');
  });
});

describe('pollVerdict — producer labels a BEHIND-but-green PR, never aborts (#2284 residual 1)', () => {
  const green = { checkStatus: 'passed', requiredCount: 1 };
  it('CLEAN/UNSTABLE + green → label (either mode)', () => {
    expect(pollVerdict({ state: 'CLEAN', ...green, labelWhenGreen: true })).toBe('label');
    expect(pollVerdict({ state: 'UNSTABLE', ...green, labelWhenGreen: false })).toBe('label');
  });
  it('BEHIND + green in PRODUCER mode → label & hand off (the fix — was previously aborting)', () => {
    expect(pollVerdict({ state: 'BEHIND', ...green, labelWhenGreen: true })).toBe('label');
  });
  it('BEHIND in a non-producer (merge) path → abort behind (up-to-date still required to merge)', () => {
    expect(pollVerdict({ state: 'BEHIND', ...green, labelWhenGreen: false })).toBe('behind');
  });
  it('BEHIND + EMPTY required set → wait, never a premature label (empty-set green races a not-yet-registered check)', () => {
    expect(pollVerdict({ state: 'BEHIND', checkStatus: 'passed', requiredCount: 0, labelWhenGreen: true })).toBe('wait');
  });
  it('BEHIND + checks pending → wait', () => {
    expect(pollVerdict({ state: 'BEHIND', checkStatus: 'pending', requiredCount: 1, labelWhenGreen: true })).toBe('wait');
  });
  it('a red required check → red, in every state/mode', () => {
    expect(pollVerdict({ state: 'BEHIND', checkStatus: 'failed', requiredCount: 1, labelWhenGreen: true })).toBe('red');
    expect(pollVerdict({ state: 'CLEAN', checkStatus: 'failed', requiredCount: 1, labelWhenGreen: true })).toBe('red');
  });
  it('CONFLICTING / DIRTY → conflict (dominates)', () => {
    expect(pollVerdict({ state: 'CLEAN', ...green, labelWhenGreen: true, conflicting: true })).toBe('conflict');
    expect(pollVerdict({ state: 'DIRTY', ...green, labelWhenGreen: true })).toBe('conflict');
  });
  it('BLOCKED / pending → wait', () => {
    expect(pollVerdict({ state: 'BLOCKED', checkStatus: 'pending', requiredCount: 1, labelWhenGreen: true })).toBe('wait');
  });
});

describe('planPrLand — label only after CI green (#2199), never merges (#2290)', () => {
  it('default (land): wait → label when green → TRIGGER a single-couple drain; NEVER merges here (#2290)', () => {
    expect(planPrLand({ wait: true, labelOnGreen: false })).toEqual({ waitForChecks: true, labelWhenGreen: true, mergeWhenGreen: false, triggerDrain: true, mode: 'land' });
  });
  it('no mode EVER merges (the drain is the sole writer to main, #2290)', () => {
    for (const w of [true, false]) for (const g of [true, false]) {
      expect(planPrLand({ wait: w, labelOnGreen: g }).mergeWhenGreen).toBe(false);
    }
  });
  it('--label-on-green (producer): wait → label when green → STOP; no merge, no drain trigger (standalone drain lands it)', () => {
    const p = planPrLand({ wait: true, labelOnGreen: true });
    expect(p.mode).toBe('label-on-green');
    expect(p.waitForChecks).toBe(true);
    expect(p.labelWhenGreen).toBe(true);
    expect(p.mergeWhenGreen).toBe(false);
    expect(p.triggerDrain).toBe(false);
  });
  it('bare --no-wait (open-only): NEVER labels (CI unconfirmed) and never waits/merges/triggers', () => {
    const p = planPrLand({ wait: false, labelOnGreen: false });
    expect(p.mode).toBe('open-only');
    expect(p.waitForChecks).toBe(false);
    expect(p.labelWhenGreen).toBe(false); // the #2199 fix: no label before green
    expect(p.mergeWhenGreen).toBe(false);
    expect(p.triggerDrain).toBe(false);
  });
  it('--label-on-green forces the wait even alongside --no-wait (the label REQUIRES a green confirmation)', () => {
    expect(planPrLand({ wait: false, labelOnGreen: true }).mode).toBe('label-on-green');
  });
  it('no mode ever labels without waiting for checks first', () => {
    for (const w of [true, false]) for (const g of [true, false]) {
      const p = planPrLand({ wait: w, labelOnGreen: g });
      if (p.labelWhenGreen) expect(p.waitForChecks).toBe(true); // labelWhenGreen ⇒ waitForChecks
    }
  });
});

describe('resolveParkLabel + planPrLand park mode — #2622 held-for-review open', () => {
  it('PARK_LABELS is exactly the two held-for-review labels (sourced from REVIEW_LABELS, no drift)', () => {
    expect(PARK_LABELS).toEqual([REVIEW_LABELS.human, REVIEW_LABELS.pending]);
  });
  it('flag absent → not a park run', () => {
    expect(resolveParkLabel(undefined)).toEqual({ park: false });
    expect(resolveParkLabel(false)).toEqual({ park: false });
    expect(resolveParkLabel(null)).toEqual({ park: false });
  });
  it('a valid held-for-review label resolves ok', () => {
    expect(resolveParkLabel('review:human')).toEqual({ park: true, ok: true, label: REVIEW_LABELS.human });
    expect(resolveParkLabel('review:pending')).toEqual({ park: true, ok: true, label: REVIEW_LABELS.pending });
  });
  it('a bare --park (no value → true) is a validation failure, not a silent pass', () => {
    const r = resolveParkLabel(true);
    expect(r.park).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no value/);
  });
  it('an off-list label (even a real non-held review label) is rejected', () => {
    for (const bad of ['review:accepted', 'review:changes', 'ready-to-merge', 'redteam:accepted', 'nonsense']) {
      const r = resolveParkLabel(bad);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/--park must be one of/);
    }
  });
  it('park mode: open with the review label, do NOT wait/label-ready/merge/trigger a drain', () => {
    const p = planPrLand({ wait: true, labelOnGreen: false, park: REVIEW_LABELS.pending });
    expect(p.mode).toBe('park');
    expect(p.parkLabel).toBe(REVIEW_LABELS.pending);
    expect(p.waitForChecks).toBe(false);   // held for review — never waited/landed by this run
    expect(p.labelWhenGreen).toBe(false);  // NEVER applies ready-to-merge
    expect(p.mergeWhenGreen).toBe(false);
    expect(p.triggerDrain).toBe(false);
  });
  it('park takes precedence over --label-on-green and --no-wait (a held PR must not carry the auto-land signal)', () => {
    expect(planPrLand({ wait: true, labelOnGreen: true, park: REVIEW_LABELS.human }).mode).toBe('park');
    expect(planPrLand({ wait: false, labelOnGreen: true, park: REVIEW_LABELS.human }).mode).toBe('park');
  });
  it('no park label → the ordinary wait/label/open-only modes are unchanged', () => {
    expect(planPrLand({ wait: true, labelOnGreen: false, park: null }).mode).toBe('land');
    expect(planPrLand({ wait: true, labelOnGreen: true, park: null }).mode).toBe('label-on-green');
    expect(planPrLand({ wait: false, labelOnGreen: false, park: null }).mode).toBe('open-only');
  });
});

// ── draft-first PRs (operator-approved 2026-09-27) — `--park` opens a draft by default; `--no-draft` opts out ──
describe('resolveDraft — draft-first PRs, scoped to park mode only', () => {
  it('park mode, no opt-out → draft', () => {
    expect(resolveDraft({ mode: 'park', optOut: false })).toBe(true);
  });
  it('park mode WITH --no-draft → not a draft (human-opened/special-cased escape hatch)', () => {
    expect(resolveDraft({ mode: 'park', optOut: true })).toBe(false);
  });
  it('land / label-on-green / open-only are NEVER drafted, opt-out or not — their poll loop has no DRAFT branch', () => {
    for (const mode of ['land', 'label-on-green', 'open-only']) {
      expect(resolveDraft({ mode, optOut: false })).toBe(false);
      expect(resolveDraft({ mode, optOut: true })).toBe(false);
    }
  });
  it('buildCreateArgs threaded through resolveDraft carries --draft exactly when park+no-opt-out', () => {
    const draft = resolveDraft({ mode: 'park', optOut: false });
    expect(buildCreateArgs({ base: 'main', head: 'lane/x', title: 't', body: 'b', draft }))
      .toEqual(['pr', 'create', '--base', 'main', '--head', 'lane/x', '--title', 't', '--body', 'b', '--draft']);
  });
});

describe('pr-land.mjs source wiring — draft-first PRs applied at the park create call (operator-approved 2026-09-27)', () => {
  const src = readFileSync(resolve(process.cwd(), 'scripts/pr-land.mjs'), 'utf8');
  it('the create params carry `draft` computed via resolveDraft, threaded from PLAN.mode and the --no-draft flag', () => {
    expect(src).toMatch(/const DRAFT_OPT_OUT = !!flags\['no-draft'\];/);
    expect(src).toMatch(/const DRAFT = resolveDraft\(\{ mode: PLAN\.mode, optOut: DRAFT_OPT_OUT \}\);/);
    expect(src).toMatch(/const createParams = \{ base: BASE, head: REF, body: CREATE_BODY, draft: DRAFT,/);
    expect(src).toMatch(/get title\(\) \{ return publicationTitle\(/);
    expect(src).toMatch(/if \(DRY_RUN\) \{\s+const createArgs = buildCreateArgs\(createParams\);/);
  });
  it('the parked emit result surfaces `draft` for observability', () => {
    expect(src).toMatch(/draft: DRAFT,/);
  });
});

describe('pr-land contract guards (source-level, mirrors gated-push-wiring)', () => {
  const src = readFileSync(resolve(process.cwd(), 'scripts/pr-land.mjs'), 'utf8');
  it('#2199: the label is applied only after the green-wait — never eagerly at PR open', () => {
    // applyLabel() must be invoked AFTER the check-wait loop (`labelWhenGreen`), not in the open/3b block.
    expect(src).toMatch(/if \(PLAN\.labelWhenGreen\) applyLabel\(\)/);
    // the open-only (--no-wait) path emits UNLABELLED
    expect(src).toMatch(/opened UNLABELLED|UNLABELLED — CI not confirmed/);
    // the eager pre-CI add-label call is gone from the open path (applyLabel is a deferred closure)
    expect(src).toMatch(/const applyLabel = \(\) =>/);
  });
  // #2890-review-r2 finding 3 — the escalation inputs are derived by ONE shared function, and the review found
  // nothing pinning that: removing `basis:` from all three production call sites failed zero of 551 tests. The
  // durable guard is structural rather than a spelling grep — pr-land does not IMPORT the raw `{text, scored}`
  // producer at all, so the mis-mapping the review caught is not expressible here.
  it('#2890: derives the net-diff signals from the ONE shared function, and cannot hand-roll them', () => {
    expect(src).toMatch(/import \{ computeNetDiffSignals \} from '\.\/merge-ai-prs\.mjs'/);
    expect(src).toMatch(/computeNetDiffSignals\(\{ exec, remote: REMOTE, base: BASE, baseRev, rev: refSha \}\)/);
    // The raw producers are deliberately OUT of scope in this file.
    expect(src).not.toMatch(/\bcomputeNetDiffText\b\s*[,}]/);
    expect(src).not.toMatch(/\bresolveNetDiffBasis\b\s*[,}]/);
    // …and no `.text` can reach the diffHunks signal, whatever the spelling in between.
    expect(src.match(/diffHunks\s*[:=][^;\n]*\.text\b/)).toBeNull();
  });
  it('only ever pushes a lane/* head (guard carve-out) and never force-pushes', () => {
    expect(src).toMatch(/\/\^lane\\\//);        // enforces --ref starts with lane/
    expect(src).not.toMatch(/--force/);          // never force
  });
  it('#2832/#984: a producer that applies a review-HOLD strips ready-to-merge (never leaves held AND ready)', () => {
    // The strip decision comes from the pure `decideHoldReadyStrip` (findings 4+5, R4, minor-1): it is judged on
    // the OBSERVED label set (`currentLabels`) — so a stale go-ahead on an already-ready held PR is stripped even
    // when this run's add hit a transient gh failure (#984 #5) — AND, belt-and-braces, on this run's `labelApplied`
    // so a PR THIS run just stamped is stripped even if the live label read failed OPEN to `[]` (#984 minor 1).
    expect(src).toMatch(/const holdDecision = decideHoldReadyStrip\(verdict\.label, currentLabels, \{ labelApplied \}\)/);
    expect(src).toMatch(/if \(holdDecision\.strip\)/);
    expect(src).toMatch(/forge\.removeLabel\(prNum, READY_TO_MERGE_LABEL\)/);
    // The pre-#984 round-1 guard (strip gated SOLELY on this-run's applyLabel via a forked predicate) stays gone.
    expect(src).not.toMatch(/isReviewHoldLabel\(verdict\.label\) && labelApplied/);
  });
  it('aborts on a red required check (never merges a red PR)', () => {
    expect(src).toMatch(/check-red/);            // the abort path exists
    // The functional guarantee that no --auto native-queue flag is ever emitted is covered by the
    // buildMergeArgs test above (…).not.toContain('--auto') — the drain owns ordering, not GitHub.
  });
  it('retains a git-merge fallback (#2138 Fork 5 (a))', () => {
    expect(src).toMatch(/fallback-git/);
    expect(src).toMatch(/merge', '--no-ff'/);
  });
  it('#2622: --park opens the review label at open then STOPS — before the wait loop, no ready-to-merge/drain', () => {
    // The park branch exists and emits the `parked` outcome without waiting.
    expect(src).toMatch(/if \(PLAN\.mode === 'park'\)/);
    expect(src).toMatch(/reason: 'parked'/);
    // An invalid --park value is a fail-fast BEFORE any push/create (never a silently-ignored flag).
    expect(src).toMatch(/reason: 'bad-park'/);
    // The park branch is placed BEFORE the check-wait loop (so it never waits/labels ready-to-merge).
    expect(src.indexOf("PLAN.mode === 'park'")).toBeLessThan(src.indexOf('// 4. Wait until GitHub'));
    // An invalid --park fails fast BEFORE the lane-ref push / PR create — never after touching origin.
    expect(src.indexOf("reason: 'bad-park'")).toBeLessThan(src.indexOf('Publish the source commit to the lane ref'));
    // The plan is built with the validated park label threaded in.
    expect(src).toMatch(/park: PARK\.ok \? PARK\.label : null/);
  });
  it('#2833: the verification finish-guard is wired BEFORE the lane-ref push and refuses an unfinished/absent verification', () => {
    // The guard calls the shared pure decision core (never a re-implementation of the gate).
    expect(src).toMatch(/verifyGateDecision/);
    expect(src).toMatch(/from '\.\/lib\/lane-verify\.mjs'/);
    // #2833 finding 2 — the marker read is SINGLE-SOURCED via `readVerifyMarker`, NEVER a hand-inlined JSON.parse
    // of the marker here (pr-land's old inline parser caught only a throw, so a valid-JSON non-object slipped
    // through as untracked and landed unverified). Source-contract: pr-land calls the shared reader, and contains
    // no bare `JSON.parse(...VERIFY_FILENAME...)` / `JSON.parse(readFileSync(markerPath...))` of the marker.
    // #4296 — the read moved inside the extracted `resolveFinishGuardVerdict` (`readMarker(gitDir)`, its own
    // injected param), with the CLI passing `readMarker: readVerifyMarker` — still the one shared reader, never
    // re-inlined; the two assertions below cover both ends of that indirection.
    expect(src).toMatch(/readMarker\(gitDir\)/);
    expect(src).toMatch(/readMarker: readVerifyMarker/);
    expect(src).not.toMatch(/JSON\.parse\([^)]*VERIFY_FILENAME/);
    expect(src).not.toMatch(/JSON\.parse\(readFileSync\(markerPath/);
    // It reads the HEAD's marker and refuses (non-ok) on the source commit BEFORE publishing to the lane ref.
    expect(src).toMatch(/headSha: refSha/);
    // Anchor the ordering on a token unique to the guard BODY — NOT the bare identifier `verifyGateDecision`,
    // which also appears in the top-of-file ESM import (line ~98) and so ALWAYS sorts before the push, making the
    // assertion tautological (#2833 finding 3). "#2833's stall guard" lives only in the guard's emit() detail, so
    // moving the guard below the push actually flips this comparison and fails the test (house precedent: the
    // #2622 assertion anchors on `reason: 'bad-park'`, a body-unique token).
    const GUARD_BODY = "this is #2833's stall guard";
    expect(src).toContain(GUARD_BODY);
    expect(src.indexOf(GUARD_BODY)).toBeLessThan(src.indexOf('Publish the source commit to the lane ref'));
    // #2833 finding 5 — the require-verified / break-glass options are resolved through the SHARED
    // `resolveVerifyOptions` resolver (same as `verify-lane check`), never hand-inlined here, so the two entry
    // points can never disagree on the same flag/env pair.
    expect(src).toMatch(/resolveVerifyOptions\(\{ flags, env: process\.env \}\)/);
    expect(src).toMatch(/WE_LAND_UNVERIFIED/);
  });
  it('#4296: the finish-guard keys the marker to what LANE-RELEVANT changed since it was recorded, not the exact sha', () => {
    // The shared pure computation, never a re-derivation of "what does this lane touch" here.
    expect(src).toMatch(/laneRelevantChangeSinceForRecord/);
    expect(src).toMatch(/from '\.\/lib\/verify-lane-gate\.mjs'/);
    // The whole decision is extracted into ONE directly-testable function (converge round 1 — correctness /
    // security / standards-conformance jurors all flagged that source-regex alone can't prove this behaves;
    // `resolveFinishGuardVerdict` closes that with a real-git test, see pr-land-finish-guard.test.mjs) — the CLI
    // block is now a thin call into it, never a re-derivation of the guard/overlap/gate-call sequence inline.
    expect(src).toMatch(/export function resolveFinishGuardVerdict\(/);
    expect(src).toMatch(/const gate = resolveFinishGuardVerdict\(\{/);
    // Pinned to THIS land's base (remote/base params), not a hardcoded 'origin/main' — correct under a POC branch too.
    expect(src).toMatch(/base: `\$\{remote\}\/\$\{base\}`/);
    expect(src).toMatch(/base: BASE, runGit: gitC, readMarker: readVerifyMarker/);
  });
  it('#984 R4: the --park emit carries held:true (a parked PR is held by definition → the workflow never re-labels it)', () => {
    // The park branch emits `held: true` alongside `reason: 'parked'` so Finalize does not mistake a deliberate
    // hold for a `labelApplied:false` un-labelled strand (which it would re-run pr-land --label-on-green on).
    const parkBlock = src.slice(src.indexOf("reason: 'parked'"), src.indexOf("reason: 'parked'") + 700);
    expect(parkBlock).toMatch(/label: null, labelApplied: false, held: true/);
  });
  it('#2622: every PARK_LABELS value has REVIEW_LABEL_META (so the park label provision never crashes on undefined)', () => {
    for (const label of PARK_LABELS) {
      expect(REVIEW_LABEL_META[label]).toBeDefined();
      expect(REVIEW_LABEL_META[label].color).toBeTruthy();
      expect(REVIEW_LABEL_META[label].description).toBeTruthy();
    }
  });
  it('self-heals id collisions AFTER the merge, non-destructively, without ever failing the land (#2071)', () => {
    expect(src).toMatch(/function runHeal/);                      // the heal step exists
    expect(src).toMatch(/const HEAL = !flags\['no-heal'\]/);      // on by default, --no-heal opts out
    // Non-destructive sync: detached checkout of the post-merge base, NEVER `git reset --hard` on a branch
    // (so an accidental --repo=<primary-with-work> can't be reset out from under the user).
    expect(src).toMatch(/checkout', '--detach'/);
    expect(src).not.toMatch(/reset', '--hard'/);
    // Skips a dirty tree, and gates the healed tree before the (non-force) push.
    expect(src).toMatch(/skipped id-collision heal/);
    expect(src).toMatch(/check:standards/);
    // #2290 — the heal now runs only in the (break-glass-gated) --fallback-git path, after its local merge.
    expect(src.indexOf('const heal = HEAL ? runHeal')).toBeGreaterThan(src.indexOf("gitC(['merge', '--no-ff'"));
    // #2312 — `runHeal` must scope its commit to the renumber's OWN files (`scopeHealChangedPaths`), never a
    // bare `git diff --name-only` (that swept foreign checkout state into the healed commit, observed live,
    // PR #168): the bare diff is only ever fed straight into the scoping helper, never straight into `git add`.
    expect(src).toMatch(/scopeHealChangedPaths\(plan, allChanged\)/);
    expect(src).toMatch(/if \(foreign\.length\) return \{ healed: false, renumbered, warning:/);
    expect(src.indexOf("gitC(['add', ...changed])")).toBeGreaterThan(src.indexOf('scopeHealChangedPaths'));
  });
  it('#2312 — reproduces the leaky heal: a foreign dirty tracked file must never ride the renumber commit', () => {
    // The exact incident shape (PR #168, 2026-07-06): a clean single-file backlog renumber ran in a checkout
    // that ALSO carried unrelated uncommitted tracked work (agent-memory + skill + script edits from other
    // in-flight items) — a bare `git diff --name-only` would report ALL of it as "changed".
    const plan = { writePaths: ['2283-file.md'], deletePaths: ['2301-file.md'] };
    const allChanged = [
      'backlog/2283-file.md',
      'backlog/2301-file.md',
      'agent-memory-src/index-meta.md',
      'backlog/2301-force-agent-memory.md',
      'scripts/merge-ai-prs.mjs',
      'scripts/lane-drain.mjs',
      'scripts/__tests__/lane-drain.test.mjs',
      'skills-src/closing-session/SKILL.md',
    ];
    const { changed, foreign } = scopeHealChangedPaths(plan, allChanged);
    // BUG (pre-fix behaviour, if `changed` were just `allChanged`): all 8 paths would ride the heal commit.
    // FIX: only the renumber's own two paths are "changed"; every unrelated path is flagged "foreign" so the
    // caller aborts instead of committing them.
    expect(changed).toEqual(['backlog/2283-file.md', 'backlog/2301-file.md']);
    expect(foreign).toEqual([
      'agent-memory-src/index-meta.md',
      'backlog/2301-force-agent-memory.md',
      'scripts/merge-ai-prs.mjs',
      'scripts/lane-drain.mjs',
      'scripts/__tests__/lane-drain.test.mjs',
      'skills-src/closing-session/SKILL.md',
    ]);
  });
  it('#2312 — a checkout with ONLY the renumber\'s own diff has no foreign paths (the common, safe case)', () => {
    const plan = { writePaths: ['2283-file.md'], deletePaths: ['2301-file.md'] };
    const allChanged = ['backlog/2283-file.md', 'backlog/2301-file.md'];
    expect(scopeHealChangedPaths(plan, allChanged)).toEqual({ changed: allChanged, foreign: [] });
  });
  it('#2312 — tolerates a plan missing writePaths/deletePaths (older CLI output) without throwing', () => {
    expect(scopeHealChangedPaths({}, ['backlog/2283-file.md'])).toEqual({ changed: [], foreign: ['backlog/2283-file.md'] });
    expect(scopeHealChangedPaths(null, [])).toEqual({ changed: [], foreign: [] });
  });
  it('regenerates derived artifacts AFTER the merge (and after heal), without ever failing the land (#2182)', () => {
    expect(src).toMatch(/function runRegen/);                       // the regen step exists
    expect(src).toMatch(/const REGEN = !flags\['no-regen'\]/);     // on by default, --no-regen opts out
    // runRegen must be defined/called AFTER runHeal — heal wins ordering over regen (#2071 before #2182).
    expect(src.indexOf('function runRegen')).toBeGreaterThan(src.indexOf('function runHeal'));
    // Non-destructive: detached checkout (reuses runHeal's pattern), NEVER reset --hard on a branch.
    expect(src.indexOf('function runRegen')).toBeGreaterThan(src.indexOf('checkout', '--detach'.length));
    expect(src).not.toMatch(/reset', '--hard'/);
    // Skips a dirty tree (can't regen against uncommitted inputs).
    expect(src).toMatch(/skipped derived-artifact regen/);
    // A regen failure is surfaced but never fails the land.
    expect(src).toMatch(/regen failed \(non-fatal\)/);
    // Never force-pushes the regen commit.
    expect(src).not.toMatch(/--force/);
  });
  it('#2290: pr-land NEVER merges on the default path — the drain is the sole writer to main', () => {
    // No `gh pr merge` (or buildMergeArgs invocation) anywhere in the runCli land flow.
    expect(src).not.toMatch(/ghC\(buildMergeArgs/);
    // The default path triggers a single-couple fast drain instead of merging.
    expect(src).toMatch(/triggerSingleCoupleDrain/);
    expect(src).toMatch(/merge-ai-prs\.mjs/);
    expect(src).toMatch(/--only=/);
  });
  it('#2659: a post-push PR-open failure on an outside dependency routes to the infra-blocked state, not a hard fail', () => {
    // the create-fail catch routes through onCreateFailed (classify → record → blocked-on-infra), never straight
    // to a hard ghFailed — so built + PUSHED work is never stranded on a transient GitHub/network fault.
    expect(src).toMatch(/catch \(e\) \{ return onCreateFailed\(e\); \}/);
    expect(src).toMatch(/function onCreateFailed/);
    expect(src).toMatch(/classifyPrOpenFailure/);
    // a NON-infra failure (bad body / auth / already-exists) still hard-fails via ghFailed — never a doomed loop.
    expect(src).toMatch(/if \(!infra\) return ghFailed/);
    // it records the RESUMABLE handle (into the primary store, via the clone's alternates) and emits
    // blocked-on-infra (exit 4) with the resume handle so the conveyor can auto-retry/resume.
    expect(src).toMatch(/recordInfraBlockIO/);
    expect(src).toMatch(/primaryRootFromClone/);
    expect(src).toMatch(/reason: 'blocked-on-infra'/);
    expect(src).toMatch(/resumeHandle:/);
  });
  it('#3383: a non-standard lane ref (no numeric/hash id) still gets a resumable infra-block record, never silently dropped', () => {
    // The OLD `itemNum` regex only matched `lane/<NNN>` or `lane/x<hash>` — a ref like
    // `lane/mark-3521-deliveryagent-codex` (a housekeeping/marker commit) matched neither, so `itemNum` came
    // back `null`, and `recordInfraBlock` treats a blank `num` as "nothing to track" and silently no-ops. The
    // fix falls back to the ref's own slug so ANY lane ref is a valid tracking key.
    expect(src).toMatch(/REF\.replace\(\/\^lane\\\/\/, ''\)\.trim\(\) \|\| null/);
  });
  it('#3383: `recorded` reflects GROUND TRUTH (the store actually holds the item) rather than a bare no-throw', () => {
    // recordInfraBlockIO is idempotent-as-a-no-op both on a missing num/ref AND on an already-tracked item —
    // "it did not throw" is not the same claim as "the record now exists". The fix re-reads the store and
    // checks real membership via `infraHas`, rather than setting `recorded = true` unconditionally after a
    // non-throwing call (which is exactly how a falsy itemNum used to silently vanish while still being
    // reported as `recorded: true`).
    expect(src).toMatch(/recorded = infraHas\(readInfraStore\(path\), itemNum\)/);
    expect(src).not.toMatch(/recorded = true;/);
  });
  it('#2290: the --fallback-git local merge is routed through the shared gate (break-glass only)', () => {
    // fallback-git is a write to main → it must assert the caller may merge (blocked unless break-glass).
    expect(src).toMatch(/assertMayMerge\(\{ caller: 'pr-land'/);
    // still ff-syncs the user's primary checkout, best-effort, after a land.
    expect(src).toMatch(/function syncPrimaryMain/);
    expect(src).toMatch(/'pull', '--ff-only', '--autostash'/);
    expect(src).toMatch(/NOT fast-forwarded/);
  });
  // #3585 — every bare `gh` call in runCli now goes through the `forge` port (`createGhLandProvider`,
  // scripts/lib/forge-land-provider.mjs). Pin the real call sites, source-level, the same technique this
  // describe block already uses elsewhere — the port's OWN test only proves its argv literals are correct in
  // isolation, not that pr-land.mjs actually calls them.
  it('#3585: every runCli gh call site is wired to the forge port, not a bare literal', () => {
    expect(src).not.toMatch(/execFileSync\('gh'/); // no bare gh exec left in this file at all
    expect(src).toMatch(/const forge = createGhLandProvider\(\{ cwd: REPO \}\)/);
    expect(src).toMatch(/forge\.listOpenByHead\(REF\)/);
    expect(src).toMatch(/forge\.create\(createParams\)/);
    expect(src).toMatch(/forge\.viewPr\(prNum, 'body'\)/);
    expect(src).toMatch(/forge\.viewPr\(prNum, 'labels'\)/);
    expect(src).toMatch(/forge\.viewPr\(prNum, 'mergeable,mergeStateStatus'\)/);
    expect(src).toMatch(/forge\.editBody\(prNum, updated\)/);
    expect(src).toMatch(/forge\.editBody\(prNum, reconciled\.body\)/);
    expect(src).toMatch(/forge\.addLabel\(prNum, LABEL\)/);
    expect(src).toMatch(/forge\.addLabel\(prNum, verdict\.label\)/);
    expect(src).toMatch(/forge\.addLabel\(prNum, parkLabel\)/);
    expect(src).toMatch(/forge\.removeLabel\(prNum, READY_TO_MERGE_LABEL\)/);
    expect(src).toMatch(/forge\.requiredChecks\(prNum\)/);
    expect(src).toMatch(/forge\.ensureLabel\(LABEL, \{/);
    expect(src).toMatch(/forge\.ensureLabel\(verdict\.label, \{/);
    expect(src).toMatch(/forge\.ensureLabel\(parkLabel, \{/);
    // mechanical-dispatcher — the review:awaiting-advisory companion label also goes through the port.
    expect(src).toMatch(/forge\.addLabel\(prNum, REVIEW_LABELS\.awaitingAdvisory\)/);
    expect(src).toMatch(/forge\.ensureLabel\(REVIEW_LABELS\.awaitingAdvisory, \{/);
  });
});

describe('resolveRosterReconcile — #2635 bind + reconcile the jury roster from the REAL diff at PR-open', () => {
  it('a care=none (non-escalating) PR recomputes an EMPTY roster and reconciles to a pure bind', () => {
    const r = resolveRosterReconcile({ careLevel: 'none', changedFiles: ['src/components/thing.ts'] });
    expect(r.effective).toEqual([]);
    expect(r.expanded).toBe(false);
    expect(r.humanAlignmentRequired).toBe(false);
  });

  it('a falsy care-level short-circuits to an empty recompute (no jury) — pure bind, no throw', () => {
    const r = resolveRosterReconcile({ careLevel: undefined, changedFiles: ['scripts/pr-land.mjs'] });
    expect(r.effective).toEqual([]);
    expect(r.humanAlignmentRequired).toBe(false);
  });

  it('an escalating UI diff with NO pre-registered roster → binds the recomputed roster (incl. perspective lenses), no re-alignment', () => {
    // careLevel high → the static PANEL_LENSES; a UI file in the diff → the a11y + visual perspective lenses.
    const r = resolveRosterReconcile({ careLevel: 'high', changedFiles: ['src/components/widget.css'] });
    expect(r.effective).toEqual(expect.arrayContaining(['correctness', 'security', 'a11y', 'visual-vs-target']));
    expect(r.humanAlignmentRequired).toBe(false); // nothing pre-registered → nothing to have drifted past
  });

  it('a UI diff whose earned lenses EXCEED the pre-registered set → expansion re-triggers human alignment', () => {
    // The charter pre-registered exactly the static lenses; the real diff moved a page file, earning
    // a11y/visual/perf. DERIVED from `PANEL_LENSES` for the same reason the no-expansion case below is: the
    // typed four stopped being "the static lenses" when `claim-accuracy` joined them in #3035, so the literal
    // would have made this an expansion-by-a-fifth-static-lens case wearing an earned-UI-lens test's name.
    const r = resolveRosterReconcile({
      careLevel: 'high',
      changedFiles: ['demos/loan/index.html'],
      preRegistered: [...PANEL_LENSES],
    });
    expect(r.expanded).toBe(true);
    expect(r.added).toEqual(expect.arrayContaining(['a11y', 'visual-vs-target', 'perf']));
    expect(r.humanAlignmentRequired).toBe(true);
  });

  it('a script-only diff that matches its pre-registered roster → no expansion, no re-alignment', () => {
    const r = resolveRosterReconcile({
      careLevel: 'high',
      changedFiles: ['scripts/pr-land.mjs'],
      // The full static set — `claim-accuracy` joined it in #3035. A roster pre-registered against the old
      // four genuinely HAS expanded once a fifth lens resolves, so this fixture must carry all of them for the
      // no-expansion case to be the no-expansion case.
      preRegistered: [...PANEL_LENSES],
    });
    expect(r.expanded).toBe(false);
    expect(r.humanAlignmentRequired).toBe(false);
  });
});

// ── #3343 — the producer is where a `review:human` is FIRST applied, and it is the expensive one to get wrong:
//    `decideSetLabel` refuses `accepted` on such a PR and only the human ceremony removes it. So the basis's
//    trust question has to survive the trip from `computeNetDiffSignals` through this verdict. ─────────────
describe('resolveProducerReviewLabel — the basis trust question (#3343)', () => {
  const statute = ['docs/agent/platform-decisions.md'];

  it('threads `basisNarrowed:false` onto the verdict as `basisUntrusted`, so a human clearing the label can see the scored file set was not provably this PR\'s', () => {
    const v = resolveProducerReviewLabel({ changedFiles: ['backlog/a.md'], humanBasisFiles: ['backlog/a.md'], diffLines: 4, basisNarrowed: false });
    expect(v.basisUntrusted).toBe(true);
    expect(v.reasons.some((r) => r.startsWith('basis un-narrowed'))).toBe(true);
  });

  it('NEGATIVE DIRECTION — an un-narrowed basis still labels a genuine statute edit `review:human`; the flag never buys a PR its way past the gate', () => {
    const v = resolveProducerReviewLabel({ changedFiles: statute, humanBasisFiles: statute, diffLines: 12, basisNarrowed: false });
    expect(v.humanRequired).toBe(true);
    expect(v.label).toBe('review:human');
  });

  it('defaults to TRUSTED — a caller supplying no `basisNarrowed` produces the same verdict as before', () => {
    expect(resolveProducerReviewLabel({ changedFiles: statute, humanBasisFiles: statute, diffLines: 12 }))
      .toEqual(resolveProducerReviewLabel({ changedFiles: statute, humanBasisFiles: statute, diffLines: 12, basisNarrowed: true }));
    expect(resolveProducerReviewLabel({ changedFiles: statute, humanBasisFiles: statute, diffLines: 12 }).basisUntrusted).toBe(false);
  });
});

describe('#4386 push rejection guidance', () => {
  const refs = { SRC: 'HEAD', REF: 'lane/proof-4386', REMOTE: 'origin' };
  it.each(['! [rejected] HEAD -> lane/proof-4386 (non-fast-forward)',
    '! [rejected] HEAD -> lane/proof-4386 (fetch first)', 'fetch first', 'non-fast-forward', '[rejected]'])
    ('classifies full stderr before truncating: %s', (stderr) => {
      const detail = pushFailedDetail(`Command failed: git push origin HEAD\n${stderr}`, refs);
      expect(detail).toContain('not the tip of lane/proof-4386');
      expect(detail).toContain('acquire --base=<tip>');
      expect(detail).toContain('origin/lane/proof-4386');
    });
  it('preserves unrelated failure detail', () => {
    expect(pushFailedDetail('Command failed: git push origin HEAD\nPermission denied', refs))
      .toBe('git push origin HEAD:refs/heads/lane/proof-4386 failed (Command failed: git push origin HEAD)');
  });
});

// LIVE INCIDENT 2026-10-03/04, PR #3830: a `--label-on-green` run that ended red left the PR with no label at all.
describe('unlabelledHandOffLabel — label-on-green exits must not strand the PR label-less (PR #3830)', () => {
  it('hands a red / timed-out / behind label-on-green exit off with review:pending', () => {
    for (const reason of ['check-red', 'check-timeout', 'behind']) {
      expect(unlabelledHandOffLabel({ mode: 'label-on-green', reason, labelApplied: false, prNum: 3830 })).toBe('review:pending');
    }
  });
  it('never when a label was applied, no PR exists, another mode, a conflict, or a success reason', () => {
    expect(unlabelledHandOffLabel({ mode: 'label-on-green', reason: 'check-red', labelApplied: true, prNum: 1 })).toBeNull();
    expect(unlabelledHandOffLabel({ mode: 'label-on-green', reason: 'check-red', prNum: null })).toBeNull();
    expect(unlabelledHandOffLabel({ mode: 'land', reason: 'check-red', prNum: 1 })).toBeNull();
    expect(unlabelledHandOffLabel({ mode: 'label-on-green', reason: 'conflict', prNum: 1 })).toBeNull();
    expect(unlabelledHandOffLabel({ mode: 'label-on-green', reason: 'labelled-on-green', prNum: 1 })).toBeNull();
  });
});
