/**
 * @file scripts/lib/merge-freshness.mjs
 * @description PURE rule "is this PR merge-fresh?" for the merge-queue protocol (card xs1hdl7; Integration
 *   Authority protocol under the delivery-standard epic 5407). Facts in, verdict out. No IO, no clock, no forge.
 *
 * WHY: 2026-10-08, PR #4361 merged on a required-check pass that was 103 min old, run on a base 125 commits
 * behind main. Main went red 7 minutes later and stayed red 6 h 41 min. A pass only proves the code that ran.
 *
 * A PR is merge-fresh only if ALL hold:
 *   1. its required check passed on its CURRENT head;
 *   2. that head's base is the current main tip, or (setting `allowDisjointMainMoves`) main moved only on files
 *      the PR does not touch;
 *   3. the pass is no older than `maxAgeMinutes`.
 * Missing or truncated facts fail closed (`facts-incomplete`), never "fresh".
 *
 * Off (`enabled: false`, the default) is today's behaviour: every PR reads fresh, reason `rule-off`.
 */

/** Declared settings. Off = today. */
export const MERGE_FRESHNESS_DEFAULTS = Object.freeze({
  enabled: false,
  maxAgeMinutes: 30,
  /** true: main moving only on files the PR doesn't touch still counts as a current base. */
  allowDisjointMainMoves: false,
});

/**
 * @typedef {object} PrFacts
 * @property {string} headSha
 * @property {string} baseSha            merge-base of the head and main
 * @property {string[]} files            files the PR changes
 * @property {boolean} filesComplete     false when the forge capped the list
 * @property {{state:'passed'|'pending'|'failed'|'missing', headSha:string|null, completedAtMs:number|null}} requiredCheck
 *
 * @typedef {object} MainFacts
 * @property {string} tipSha
 * @property {number} commitsSinceBase   main commits after the PR's base, up to the tip
 * @property {string[]} filesChangedSinceBase
 * @property {boolean} complete          false when the commit/file read was cut off
 */

/**
 * @param {{pr: PrFacts, main: MainFacts, nowMs: number, settings?: typeof MERGE_FRESHNESS_DEFAULTS}} facts
 * @returns {{fresh: boolean, reasons: string[]}}
 */
export function assessMergeFreshness({ pr, main, nowMs, settings = MERGE_FRESHNESS_DEFAULTS }) {
  const s = { ...MERGE_FRESHNESS_DEFAULTS, ...settings };
  if (!s.enabled) return { fresh: true, reasons: ['rule-off'] };

  const check = pr?.requiredCheck;
  const incomplete = !pr?.headSha || !pr?.baseSha || !main?.tipSha || main?.complete !== true
    || !check || !Number.isFinite(check.completedAtMs) || !Number.isFinite(nowMs)
    || (s.allowDisjointMainMoves && (pr.filesComplete !== true || !Array.isArray(pr.files) || !Array.isArray(main.filesChangedSinceBase)));
  if (incomplete) return { fresh: false, reasons: ['facts-incomplete'] };

  const reasons = [];
  const onHead = check.state === 'passed' && check.headSha === pr.headSha;
  if (!onHead) reasons.push('pass-not-on-head');

  const baseCurrent = pr.baseSha === main.tipSha || main.commitsSinceBase === 0;
  if (!baseCurrent) {
    const touched = new Set(main.filesChangedSinceBase || []);
    const disjoint = s.allowDisjointMainMoves && !pr.files.some((f) => touched.has(f));
    if (!disjoint) reasons.push('base-behind-main');
  }

  if (onHead && nowMs - check.completedAtMs > s.maxAgeMinutes * 60_000) reasons.push('pass-too-old');
  return { fresh: reasons.length === 0, reasons };
}
