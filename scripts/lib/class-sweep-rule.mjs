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
 * STANDARD SHAPE (protocol card 5468): pure functions over plain facts plus a declared setting; today's behaviour is
 * the setting's off value. No IO, no clock, no forge vocabulary. The text is UNTRUSTED (agent-written, may quote PR
 * content): it is only ever parsed as JSON, sizes are bounded before parsing, and no field of it is executed or used
 * as a path.
 */

export const CLASS_SWEEP_MODES = Object.freeze(['off', 'warn', 'enforce']);
/** The sibling paths every finding's sweep must cover. */
export const SWEEP_PATHS = Object.freeze(['family', 'callers', 'branches', 'recovery']);
export const SWEEP_STATUSES = Object.freeze(['fixed', 'checked', 'n/a']);
/** Bounds applied before any parsing. */
export const MAX_EVIDENCE_BYTES = 256 * 1024;
export const MAX_BLOCK_BYTES = 64 * 1024;
const MAX_FIELD = 300;
const MAX_FINDINGS = 50;
const MAX_SIBLINGS = 40;

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
      if (!SWEEP_PATHS.includes(path)) { problems.push(`${where}: unknown-path`); return; }
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
 * @returns {{mode: string, status: 'skipped'|'complete'|'missing'|'malformed'|'incomplete', reason: string,
 *   blocking: boolean, problems: string[], sweep: object|null, findings: number, classes: string[]}}
 */
export function classSweepVerdict({ mode, changeKind = null, evidence = null } = {}) {
  const m = CLASS_SWEEP_MODES.includes(mode) ? mode : 'off';
  const out = (status, reason, extra = {}) => ({
    mode: m, status, reason, problems: [], sweep: null, findings: 0, classes: [], ...extra,
    blocking: m === 'enforce' && !['skipped', 'complete'].includes(status),
  });
  if (m === 'off') return out('skipped', 'mode-off');
  if (!['fix', 'ci-heal'].includes(changeKind)) return out('skipped', 'not-a-fix');
  if (typeof evidence !== 'string' || !evidence.trim()) return out('missing', 'no-evidence-text');
  const { blocks, truncated } = extractSweepBlocks(evidence);
  if (blocks.length === 0) return out('missing', truncated ? 'evidence-truncated-before-block' : 'no-class-sweep-block');
  if (blocks.length > 1) return out('malformed', 'more-than-one-class-sweep-block');
  const checked = checkSweep(blocks[0]);
  const extra = {
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
