/**
 * @file scripts/lib/class-sweep-rule.mjs
 * @description THE CLASS-SWEEP RULE (card xet6iu0, operator 2026-10-08 "fix quality first") — a fix names, for each
 *   finding, the DEFECT CLASS it repairs and the sibling paths it checked for the same defect, each fixed or explicitly
 *   checked / not applicable.
 *
 * WHY. The 2026-10-08 fixer audit: later review rounds were blocked mostly by findings on code the fix itself changed.
 * Seven findings were caused by fixes — an uncovered sibling path (#4481), holes in the fix's own new recovery code
 * (#4433), whack-a-mole within one class (4441, 4446, 4461). The briefs already said "fix the class, not the instance"
 * in prose; nothing checked that the sweep was done. This makes the sweep a structured record a script can read.
 *
 * THE RECORD — a fenced block in the fixer's evidence text, info string `class-sweep`, JSON body:
 *
 *   ```class-sweep
 *   {"v":1,"findings":[{"finding":"F1","class":"truncated read","siblings":[
 *     {"path":"family","site":"scripts/a.mjs#readOne","status":"fixed","note":"same page cap"},
 *     {"path":"callers","site":"scripts/b.mjs#main","status":"checked","note":"passes the full list"},
 *     {"path":"branches","site":"scripts/a.mjs#readMany","status":"n/a","note":"no parallel branch reads pages"},
 *     {"path":"recovery","site":"scripts/a.mjs#retryRead","status":"checked","note":"the new retry re-reads with the cap"}]}]}
 *   ```
 *
 * Every finding must cover the four sibling PATHS: `family` (same function family), `callers`, `branches` (parallel
 * branches), `recovery` (the fix's own new recovery / error paths — the #4433 lesson). A path with nothing to check is
 * still listed, as `n/a` with a reason: a row nobody looked at is not `n/a`.
 *
 * THE SAME CLASS ANYWHERE IN THE PR (card 5536). The four paths look outward from the fixed site; review rounds kept
 * finding the same class in ANOTHER file of the same PR (#4624: round 1 swept the freeze-marker class in
 * `red-main-remediation.mjs`; round 3 found the same "a manual freeze is silently not honoured" class in
 * `red-main-hold.mjs`, a file of the same PR the sweep never named). So, given the PR's changed files, every finding's
 * rows must name every changed file: a row's `site` names a file (`path/file.mjs#fn`) or a directory prefix ending
 * in `/` (`scripts/lib/__tests__/`). The optional fifth path `pr` carries rows for files the four paths did not
 * reach (`{"path":"pr","site":"scripts/lib/x.mjs","status":"checked","note":"no freeze read"}`). Cards under
 * `backlog/` are exempt. A file no row names is `<finding>: pr-unswept-<n>`; the file list goes in the record only.
 *
 * STANDARD SHAPE (protocol card 5468): pure functions over plain facts plus a declared setting; today's behaviour is
 * the setting's off value. No IO, no clock, no forge vocabulary. The text is UNTRUSTED (agent-written, may quote PR
 * content): it is only ever parsed as JSON, sizes are bounded before parsing, and no field of it is executed or used
 * as a path.
 */

export const CLASS_SWEEP_MODES = Object.freeze(['off', 'warn', 'enforce']);
/** The sibling paths every finding's sweep must cover. */
export const SWEEP_PATHS = Object.freeze(['family', 'callers', 'branches', 'recovery']);
/** Optional extra path: rows for the PR's other changed files (the same class anywhere in the PR, card 5536). */
export const PR_PATH = 'pr';
/** Changed files never needing a sweep row (backlog cards are prose, not code). */
export const PR_EXEMPT_PREFIXES = Object.freeze(['backlog/']);
/** At most this many changed files are checked; a longer list reads `pr-files-truncated` (never `complete`). */
export const MAX_PR_FILES = 500;
export const SWEEP_STATUSES = Object.freeze(['fixed', 'checked', 'n/a']);
/** Bounds applied before any parsing. */
export const MAX_EVIDENCE_BYTES = 256 * 1024;
export const MAX_BLOCK_BYTES = 64 * 1024;
const MAX_FIELD = 300;
const MAX_FINDINGS = 50;
const MAX_SIBLINGS = 80;

const FENCE_RE = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*class-sweep[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;

/**
 * Extract the class-sweep block(s). PURE.
 * @param {string} text the evidence text.
 * @returns {{blocks: string[], truncated: boolean}}
 */
export function extractSweepBlocks(text) {
  const raw = typeof text === 'string' ? text : '';
  const truncated = raw.length > MAX_EVIDENCE_BYTES;
  const bounded = truncated ? raw.slice(0, MAX_EVIDENCE_BYTES) : raw;
  return { blocks: [...bounded.matchAll(FENCE_RE)].map((m) => m[3]), truncated };
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Parse and check one block's JSON. PURE.
 * @returns {{ok: boolean, sweep: object|null, problems: string[]}}
 */
export function checkSweep(blockText) {
  const problems = [];
  if (typeof blockText !== 'string' || blockText.length > MAX_BLOCK_BYTES) return { ok: false, sweep: null, problems: ['block-too-large'] };
  let parsed;
  try { parsed = JSON.parse(blockText); } catch { return { ok: false, sweep: null, problems: ['block-not-json'] }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, sweep: null, problems: ['block-not-object'] };
  if (parsed.v !== 1) problems.push('unknown-version');
  const findings = Array.isArray(parsed.findings) ? parsed.findings : null;
  if (!findings || findings.length === 0) return { ok: false, sweep: null, problems: [...problems, 'no-findings'] };
  if (findings.length > MAX_FINDINGS) return { ok: false, sweep: null, problems: [...problems, 'too-many-findings'] };

  const clean = [];
  findings.forEach((f, i) => {
    // The id is echoed in problem codes, so it is reduced to a closed character set (no newline, no markup).
    const id = str(f?.finding).replace(/[^\w.#-]/g, '').slice(0, 40) || `#${i + 1}`;
    const cls = str(f?.class);
    if (!cls) problems.push(`${id}: no-class`);
    else if (cls.length > MAX_FIELD) problems.push(`${id}: class-too-long`);
    const siblings = Array.isArray(f?.siblings) ? f.siblings : [];
    if (siblings.length > MAX_SIBLINGS) { problems.push(`${id}: too-many-siblings`); return; }
    const rows = [];
    siblings.forEach((s, j) => {
      const path = str(s?.path);
      const status = str(s?.status);
      const site = str(s?.site);
      const note = str(s?.note);
      const where = `${id}.siblings[${j}]`;
      if (!SWEEP_PATHS.includes(path) && path !== PR_PATH) { problems.push(`${where}: unknown-path`); return; }
      if (!SWEEP_STATUSES.includes(status)) { problems.push(`${where}: unknown-status`); return; }
      if (status !== 'n/a' && !site) problems.push(`${where}: no-site`);
      if (status !== 'fixed' && !note) problems.push(`${where}: no-reason`);
      if (site.length > MAX_FIELD || note.length > MAX_FIELD) problems.push(`${where}: field-too-long`);
      rows.push({ path, status, site: site.slice(0, MAX_FIELD), note: note.slice(0, MAX_FIELD) });
    });
    for (const path of SWEEP_PATHS) if (!rows.some((r) => r.path === path)) problems.push(`${id}: missing-${path}`);
    clean.push({ finding: id, class: cls.slice(0, MAX_FIELD), siblings: rows });
  });
  return { ok: problems.length === 0, sweep: { v: 1, findings: clean }, problems };
}

/**
 * THE VERDICT. PURE: facts and the declared setting in, verdict out.
 * @param {{mode: string, changeKind: string|null, evidence: string|null}} facts
 *   `changeKind` — the session's role (`fix` / `ci-heal`); anything else is not a fix and is skipped.
 *   `evidence` — the evidence text, or null when none could be read.
 *   `changedFiles` — the PR's changed files (card 5536): an array is checked, `null` (unreadable) fails closed,
 *   undefined (not supplied) skips the PR-wide check.
 * @returns {{mode: string, status: 'skipped'|'complete'|'missing'|'malformed'|'incomplete', reason: string,
 *   blocking: boolean, problems: string[], sweep: object|null, findings: number, classes: string[]}}
 */
/**
 * Which changed files of the PR a finding's rows never name. PURE.
 * @param {{siblings: {site: string}[]}} finding a cleaned finding (from checkSweep).
 * @param {string[]} changedFiles repo-relative paths.
 * @returns {string[]} the unswept files, in input order.
 */
export function unsweptPrFiles(finding, changedFiles) {
  const sites = (finding?.siblings ?? []).map((r) => r.site).filter(Boolean);
  const prefixes = sites.flatMap((s) => s.split(/[\s,;+()]+/)).filter((t) => t.endsWith('/') && t.length > 1);
  return changedFiles.filter((f) => !PR_EXEMPT_PREFIXES.some((p) => f.startsWith(p))
    && !sites.some((s) => s.includes(f)) && !prefixes.some((p) => f.startsWith(p)));
}

const cleanFiles = (list) => [...new Set(list.filter((f) => typeof f === 'string').map((f) => f.trim()).filter(Boolean))];

export function classSweepVerdict({ mode, changeKind = null, evidence = null, changedFiles } = {}) {
  const m = CLASS_SWEEP_MODES.includes(mode) ? mode : 'off';
  const out = (status, reason, extra = {}) => ({
    mode: m, status, reason, problems: [], sweep: null, findings: 0, classes: [], unswept: {}, ...extra,
    blocking: m === 'enforce' && !['skipped', 'complete'].includes(status),
  });
  if (m === 'off') return out('skipped', 'mode-off');
  if (!['fix', 'ci-heal'].includes(changeKind)) return out('skipped', 'not-a-fix');
  if (typeof evidence !== 'string' || !evidence.trim()) return out('missing', 'no-evidence-text');
  const { blocks, truncated } = extractSweepBlocks(evidence);
  if (blocks.length === 0) return out('missing', truncated ? 'evidence-truncated-before-block' : 'no-class-sweep-block');
  if (blocks.length > 1) return out('malformed', 'more-than-one-class-sweep-block');
  const checked = checkSweep(blocks[0]);
  // The same class anywhere in the PR (card 5536). `changedFiles` undefined = a caller that does not know the PR's
  // files (legacy facts): not checked. `null` = the files could not be read: fail closed.
  const unswept = {};
  if (checked.sweep && changedFiles !== undefined) {
    if (!Array.isArray(changedFiles)) checked.problems.push('pr-files-unknown');
    else if (changedFiles.length > MAX_PR_FILES) checked.problems.push('pr-files-truncated');
    else {
      const files = cleanFiles(changedFiles);
      for (const f of checked.sweep.findings) {
        const miss = unsweptPrFiles(f, files);
        if (miss.length) { unswept[f.finding] = miss.slice(0, 100); checked.problems.push(`${f.finding}: pr-unswept-${miss.length}`); }
      }
    }
    checked.ok = checked.problems.length === 0;
  }
  const extra = {
    unswept,
    problems: checked.problems, sweep: checked.sweep,
    findings: checked.sweep?.findings.length ?? 0,
    classes: [...new Set((checked.sweep?.findings ?? []).map((f) => f.class).filter(Boolean))],
  };
  if (!checked.sweep) return out('malformed', checked.problems[0] ?? 'unreadable', extra);
  if (!checked.ok) return out('incomplete', checked.problems[0], extra);
  return out('complete', 'every-finding-has-class-and-four-sibling-paths', extra);
}

/** One line for the fixer's terminal and the log. PURE. Prints codes and counts only — never the untrusted text. */
export function formatClassSweep(v) {
  if (!v) return 'class-sweep: no result';
  const head = `class-sweep (${v.mode}): ${v.status} — ${v.reason}`;
  if (v.status === 'skipped' || v.status === 'missing') return head;
  const more = v.problems.length > 1 ? ` (+${v.problems.length - 1} more)` : '';
  return `${head}; ${v.findings} finding(s)${v.problems.length ? `; first problem ${v.problems[0]}${more}` : ''}`;
}
