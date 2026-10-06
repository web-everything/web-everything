#!/usr/bin/env node
/**
 * check-review-gate.mjs — #2412 Layer 5: a required-status-check backstop against a MANUAL `gh pr merge` that
 * bypasses the drain.
 *
 * WHY. `we:scripts/lib/pr-merge-gate.mjs`'s `assertMayMerge` already refuses any route but `caller: 'drain'`
 * FROM WITHIN this repo's own scripts — but that only binds a process that goes through `mergePr()`. Nothing
 * stops an operator (or another tool) running `gh pr merge` directly against a PR that carries an un-cleared
 * review hold (`review:pending` / `review:changes` / `review:human`, `we:scripts/lib/review-escalation.mjs`'s
 * `REVIEW_HOLD_LABELS`). This script is wired into CI as a required check (`.github/workflows/review-gate.yml`)
 * so THAT bypass is caught too: the check reads RED for as long as a hold label sits on the PR, which — once
 * a repo admin adds it to the branch-protection required-check list (a repo-admin action, not a code change;
 * see `.github/workflows/ci.yml`'s own note on adding `smoke` for the same kind of step) — refuses the merge
 * button and a `gh pr merge` alike.
 *
 * THIS IS AN OUTER LAYER, NOT A REPLACEMENT for the drain's own code-side gate (`decideReviewGate`). It can't
 * tell "an independent validator accepted this" from "someone applied the label" — a required check reads a
 * label, nothing more — so it closes the MANUAL-BYPASS hole the code-side gate can't see (the drain applies
 * its own labels and is the gate itself), never the reverse.
 *
 * Usage:
 *   node scripts/check-review-gate.mjs --labels-json='[{"name":"review:human"}]'   # explicit label set (CI)
 *   node scripts/check-review-gate.mjs --pr=1234 [--repo=owner/name]               # fetched live via gh (manual/local)
 *   node scripts/check-review-gate.mjs --pr=1234 --json                            # machine-readable result
 *
 * Exit codes: 0 = clear (no hold label — check is green); 1 = held (a hold label is present — check is red);
 * 3 = usage error (neither --labels-json nor --pr given, or the gh fetch failed).
 */
import { readGh } from './lib/proc-read.mjs';
import { REVIEW_HOLD_LABELS, isReviewHoldLabel } from './lib/review-escalation.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';

/** The pure decision: which of this PR's labels are review holds? Pure — no I/O.
 *  `labels` is the observed label array, string or `{name}` shape (matches `hasReviewLabel`'s tolerance).
 *  @param {Array<string|{name?:string}>} labels
 *  @returns {{held:boolean, holdLabels:string[]}}
 */
export function reviewGateVerdict(labels) {
  const names = (Array.isArray(labels) ? labels : [])
    .map((l) => (typeof l === 'string' ? l : l && l.name))
    .filter(Boolean);
  const holdLabels = names.filter((n) => isReviewHoldLabel(n));
  return { held: holdLabels.length > 0, holdLabels };
}

function main() {
  const flags = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const AS_JSON = !!flags.json;

  const fail = (detail) => {
    if (AS_JSON) writeAllSync(1, JSON.stringify({ ok: false, reason: 'usage', detail }) + '\n');
    else process.stderr.write(`check-review-gate ✗ usage: ${detail}\n`);
    process.exit(3);
  };

  let labels;
  if (typeof flags['labels-json'] === 'string') {
    try { labels = JSON.parse(flags['labels-json']); }
    catch (e) { return fail(`--labels-json is not valid JSON: ${String(e.message || e)}`); }
  } else if (flags.pr) {
    const repoFlag = flags.repo ? ['--repo', String(flags.repo)] : [];
    try {
      const data = JSON.parse(readGh(['pr', 'view', String(flags.pr), ...repoFlag, '--json', 'labels'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      // Empty/oversize/malformed output is "unknown", never "no labels" (#74c): fail instead of passing the gate.
      if (!Array.isArray(data?.labels)) throw new Error('labels missing from gh output');
      labels = data.labels;
    } catch (e) { return fail(`could not read labels for PR ${flags.pr}: ${String(e.message || e).split('\n')[0]}`); }
  } else {
    return fail('pass --labels-json=<JSON array> or --pr=<number> [--repo=<owner/name>]');
  }

  const verdict = reviewGateVerdict(labels);
  if (AS_JSON) writeAllSync(1, JSON.stringify({ ok: !verdict.held, held: verdict.held, holdLabels: verdict.holdLabels, reviewHoldLabels: REVIEW_HOLD_LABELS }) + '\n');
  else if (verdict.held) process.stderr.write(`check-review-gate ✗ held — a review hold stands: ${verdict.holdLabels.join(', ')}\n`);
  else process.stderr.write('check-review-gate ✓ no review hold present\n');
  process.exit(verdict.held ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
