/**
 * @file scripts/lib/pre-pr-review.mjs
 * @description The pre-PR review gate (opus perf sweep 2026-10-07, card 2). A RISKY code PR must have run the
 *   `/converge` panel on its exact head tree BEFORE `open-pr` opens it. This is an ADDED step: it never replaces
 *   or weakens the post-PR review gate.
 *
 * Pure policy + small git readers. Three parts:
 *  - settings knob `prePrReview.mode` = off | advise | enforce (we:scripts/pre-pr-review-settings.json; the
 *    built-in/product default is `advise`; this repo's file sets `enforce`). Read from the WE root RUNNING
 *    open-pr, never from the lane, so a lane cannot weaken its own gate.
 *  - the RISK rule (coroner predictors): a code PR is gated when ANY of lines > 264, subsystems > 2, files > 5,
 *    no prepared card, or the builder is an operator agent (not a conveyor worker). Card-only PRs (every path
 *    under backlog/) are never gated.
 *  - the RECEIPT: `converge-cli.mjs receipt` writes `<git-dir>/pre-pr-review-receipt.json` keyed by the head
 *    TREE hash after a converge run ended in `land`. A new tree (any further edit) invalidates it.
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCardPath } from '../ci-card-only.mjs';
import { classifySession } from '../operations/session-role.mjs';

export const PRE_PR_MODES = Object.freeze(['off', 'advise', 'enforce']);
export const BUILT_IN_PRE_PR_SETTINGS = Object.freeze({ mode: 'advise', maxLines: 264, maxSubsystems: 2, maxFiles: 5 });
export const RECEIPT_FILE = 'pre-pr-review-receipt.json';
export const BYPASS_LOG_FILE = 'pre-pr-review-bypass.log';

const rules = {
  mode: (v) => PRE_PR_MODES.includes(v),
  maxLines: (v) => Number.isSafeInteger(v) && v >= 0,
  maxSubsystems: (v) => Number.isSafeInteger(v) && v >= 0,
  maxFiles: (v) => Number.isSafeInteger(v) && v >= 0,
};

export function defaultPrePrSettingsPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../pre-pr-review-settings.json');
}

/** Merge a settings object over the built-ins; an invalid key is ignored (and named), never trusted. */
export function resolvePrePrSettings(raw = {}) {
  const settings = { ...BUILT_IN_PRE_PR_SETTINGS };
  const ignored = [];
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (rules[k] && rules[k](v)) settings[k] = v; else ignored.push(k);
  }
  return { settings, ignored };
}

export function loadPrePrSettings({ path = defaultPrePrSettingsPath(), read = readFileSync } = {}) {
  try { return resolvePrePrSettings(JSON.parse(read(path, 'utf8'))); } catch { return resolvePrePrSettings({}); }
}

/** Subsystem = up to two leading directories (`backlog` alone); a root file is `.` (same rule as the coroner). */
export const subsystemOf = (p) => p.split('/').slice(0, -1).slice(0, p.startsWith('backlog/') ? 1 : 2).join('/') || '.';

/**
 * @param {{files: {path: string, additions?: number, deletions?: number}[], hasPreparedCard: boolean,
 *   operatorAgent: boolean, settings?: object}} input
 * @returns {{gated: boolean, cardOnly: boolean, reasons: string[], lines: number, subsystems: number, files: number}}
 */
export function classifyPrRisk({ files = [], hasPreparedCard = false, operatorAgent = false, settings = BUILT_IN_PRE_PR_SETTINGS } = {}) {
  const lines = files.reduce((n, f) => n + (f.additions || 0) + (f.deletions || 0), 0);
  const subsystems = new Set(files.map((f) => subsystemOf(f.path))).size;
  const base = { lines, subsystems, files: files.length };
  if (files.length === 0 || files.every((f) => isCardPath(f.path))) return { gated: false, cardOnly: true, reasons: [], ...base };
  const reasons = [];
  if (lines > settings.maxLines) reasons.push(`${lines} lines changed (> ${settings.maxLines})`);
  if (subsystems > settings.maxSubsystems) reasons.push(`${subsystems} subsystems (> ${settings.maxSubsystems})`);
  if (files.length > settings.maxFiles) reasons.push(`${files.length} files (> ${settings.maxFiles})`);
  if (!hasPreparedCard) reasons.push('no prepared card in the diff');
  if (operatorAgent) reasons.push('built by an operator agent (not a conveyor worker)');
  return { gated: reasons.length > 0, cardOnly: false, reasons, ...base };
}

/** A card is prepared when its frontmatter carries a non-empty `preparedDate`. */
export const isPreparedCard = (text) => /^preparedDate:\s*["']?\d{4}-\d{2}-\d{2}/m.test(String(text ?? ''));

/**
 * The gate decision. `skip` is a recorded bypass reason. Never throws.
 * @returns {{action: 'pass'|'advise'|'refuse', why: string, message: string}}
 */
export function decidePrePrReview({ settings, risk, receipt, headTree, skip = '' }) {
  if (settings.mode === 'off') return { action: 'pass', why: 'mode-off', message: '' };
  if (!risk.gated) return { action: 'pass', why: risk.cardOnly ? 'card-only' : 'low-risk', message: '' };
  if (receipt && receipt.tree && receipt.tree === headTree && receipt.verdict === 'land') {
    return { action: 'pass', why: 'receipt', message: '' };
  }
  const why = receipt && receipt.tree && receipt.tree !== headTree ? 'receipt-stale' : 'receipt-missing';
  const detail = why === 'receipt-stale'
    ? `the receipt is for tree ${String(receipt.tree).slice(0, 12)}, but HEAD is tree ${String(headTree).slice(0, 12)} (edited since the review)`
    : 'no pre-PR review receipt exists for this head';
  const msg = `pre-PR review required — this PR is risky (${risk.reasons.join('; ')}) and ${detail}. `
    + 'Run `/converge` against this lane (brief step 6), then `node scripts/converge-cli.mjs receipt --lane=<lane> --state=<file>` '
    + 'on the committed head, and open the PR again. Bypass only with `--skipPrePrReview=<reason>` (the reason is recorded).';
  if (settings.mode === 'advise') return { action: 'advise', why, message: msg };
  if (typeof skip === 'string' && skip.trim()) return { action: 'pass', why: 'bypass', message: '' };
  return { action: 'refuse', why, message: msg };
}

const gitIn = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

export function gitDirOf(cwd) { return resolve(cwd, gitIn(cwd, ['rev-parse', '--git-dir']).trim()); }
export function treeOf(cwd, sha = 'HEAD') { return gitIn(cwd, ['rev-parse', `${sha}^{tree}`]).trim(); }

/** Changed files (numstat) of `sha` against the merge base with `base`. */
export function readDiffFiles({ cwd, base = 'main', sha = 'HEAD', git = (a) => gitIn(cwd, a) }) {
  let ref = `origin/${base}`;
  try { git(['rev-parse', '--verify', '--quiet', ref]); } catch { ref = base; }
  const out = git(['diff', '--numstat', '-z', `${ref}...${sha}`]);
  // -z numstat: "<add>\t<del>\t<path>\0" (renames carry two extra NUL parts; the destination is the last)
  const files = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let path = m[3];
    if (path === '') { path = parts[i + 2] ?? ''; i += 2; }
    if (path) files.push({ path, additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) });
  }
  return { files, ref };
}

export function readReceipt(cwd) {
  try { return JSON.parse(readFileSync(join(gitDirOf(cwd), RECEIPT_FILE), 'utf8')); } catch { return null; }
}

export function buildReceipt({ tree, head, envelope, now = new Date() }) {
  return {
    schema: 1, tree, head, verdict: 'land', issuedAt: now.toISOString(),
    rounds: envelope?.state?.round ?? null, careLevel: envelope?.state?.careLevel ?? null,
    lenses: envelope?.state?.activeLenses ?? [], dismissed: (envelope?.state?.dismissed ?? []).length,
  };
}

export function recordBypass(cwd, { reason, head, risk, now = new Date() }) {
  appendFileSync(join(gitDirOf(cwd), BYPASS_LOG_FILE), `${JSON.stringify({ at: now.toISOString(), head, reason: String(reason).slice(0, 500), risk: risk.reasons })}\n`);
}

/**
 * The whole open-pr pre-check, over a lane checkout. IO only through `cwd` git. Returns the decision plus the risk.
 */
export function checkPrePrReview({ cwd, base = 'main', sha = 'HEAD', env = process.env, skip = '', settings, role } = {}) {
  const { settings: s } = settings ? { settings } : loadPrePrSettings();
  if (s.mode === 'off') return { ...decidePrePrReview({ settings: s, risk: { gated: false }, headTree: '' }), settings: s };
  const { files } = readDiffFiles({ cwd, base, sha });
  const cards = files.filter((f) => isCardPath(f.path)).map((f) => f.path);
  const hasPreparedCard = cards.some((p) => { try { return isPreparedCard(gitIn(cwd, ['show', `${sha}:${p}`])); } catch { return false; } });
  const operatorAgent = (role ?? sessionRole(env)) !== 'worker';
  const risk = classifyPrRisk({ files, hasPreparedCard, operatorAgent, settings: s });
  const headTree = treeOf(cwd, sha);
  const decision = decidePrePrReview({ settings: s, risk, receipt: readReceipt(cwd), headTree, skip });
  if (decision.why === 'bypass') recordBypass(cwd, { reason: skip, head: sha, risk });
  return { ...decision, risk, headTree, settings: s };
}

const sessionRole = (env) => classifySession(env).role;
