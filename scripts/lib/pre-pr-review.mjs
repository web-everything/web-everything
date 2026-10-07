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
import { readFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCardPath } from '../ci-card-only.mjs';
import { isAllowlistedLitterPath } from './lane-litter.mjs';
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

/**
 * Never throws. A MISSING file is the product default (`advise`). A file that is present but unreadable, not
 * JSON, or carrying an unrecognised `mode` fails CLOSED to `enforce` (and says why in `error`): a typo in the
 * settings file must never silently downgrade the gate. The caller surfaces `error` loudly.
 */
export function loadPrePrSettings({ path = defaultPrePrSettingsPath(), read = readFileSync } = {}) {
  let text;
  try { text = read(path, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { ...resolvePrePrSettings({}), error: '' };
    return { ...resolvePrePrSettings({ mode: 'enforce' }), error: `pre-PR review settings unreadable (${e?.message || e}) — failing closed to enforce` };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    return { ...resolvePrePrSettings({ mode: 'enforce' }), error: `pre-PR review settings are not valid JSON (${e.message}) — failing closed to enforce` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...resolvePrePrSettings({ mode: 'enforce' }), error: 'pre-PR review settings are not a JSON object — failing closed to enforce' };
  }
  const resolved = resolvePrePrSettings(parsed);
  // A present file must say a valid `mode`, and carry only keys/values the loader understands: a missing,
  // misspelled or nested `mode` (`{"prePrReview":{"mode":"off"}}`, `{"Mode":"off"}`), or a threshold written as a
  // string, would otherwise silently fall back to the lenient default.
  if (!PRE_PR_MODES.includes(parsed.mode) || resolved.ignored.length > 0) {
    const why = !PRE_PR_MODES.includes(parsed.mode)
      ? `has no valid \`mode\` (got ${JSON.stringify(parsed.mode)}; expected ${PRE_PR_MODES.join(' | ')})`
      : `carries keys or values it does not understand (${resolved.ignored.join(', ')})`;
    return { settings: { ...resolved.settings, mode: 'enforce' }, ignored: resolved.ignored, error: `pre-PR review settings ${why} — failing closed to enforce` };
  }
  return { ...resolved, error: '' };
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
  // A rename carries its SOURCE path (`from`): moving a code file under `backlog/` must not read as card-only,
  // and both ends count as touched subsystems.
  const paths = files.flatMap((f) => [f.path, f.from].filter(Boolean));
  const subsystems = new Set(paths.map(subsystemOf)).size;
  const base = { lines, subsystems, files: files.length };
  if (files.length === 0 || paths.every((p) => isCardPath(p))) return { gated: false, cardOnly: true, reasons: [], ...base };
  const reasons = [];
  if (lines > settings.maxLines) reasons.push(`${lines} lines changed (> ${settings.maxLines})`);
  if (subsystems > settings.maxSubsystems) reasons.push(`${subsystems} subsystems (> ${settings.maxSubsystems})`);
  if (files.length > settings.maxFiles) reasons.push(`${files.length} files (> ${settings.maxFiles})`);
  if (!hasPreparedCard) reasons.push('no prepared card in the diff');
  if (operatorAgent) reasons.push('built by an operator agent (not a conveyor worker)');
  return { gated: reasons.length > 0, cardOnly: false, reasons, ...base };
}

/** A card is prepared when its LEADING frontmatter block (opened on line 1, closed by a later `---`) carries a dated
 *  `preparedDate`. Body text, fenced examples and an unterminated block never count. */
export const isPreparedCard = (text) => {
  const m = /^---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(String(text ?? ''));
  return !!m && /^preparedDate:[ \t]*["']?\d{4}-\d{2}-\d{2}/m.test(m[1] ?? '');
};

/** `/converge` scratch at the lane root (`.converge-state.json`, `-obs-*`, `-material-*`) plus the brief's other
 *  sanctioned in-lane scratch (`.commit-msg.txt`, `.pr-body*.md`, … — the one `lane-litter` allowlist): the brief
 *  tells agents to keep these inside the lane, so an UNTRACKED one is neither reviewed content nor a leftover —
 *  the tree hash and `receipt` skip it. A TRACKED file of the same name is real content and still counts. */
export const CONVERGE_SCRATCH_RE = /^\.converge-[^/]*$/;
export const isScratchPath = (p) => CONVERGE_SCRATCH_RE.test(p) || isAllowlistedLitterPath(p);

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
    + 'on the committed head, and open the PR again. Bypass only with `--skipPrePrReview=<reason>` (the reason is recorded). A bypass also needs `--actor=<name>` and `--operatorInstruction="<quoted operator instruction>"`; a dispatched worker is refused a bypass.';
  if (settings.mode === 'advise') return { action: 'advise', why, message: msg };
  if (typeof skip === 'string' && skip.trim()) return { action: 'pass', why: 'bypass', message: '' };
  return { action: 'refuse', why, message: msg };
}

/** Bounded: a hung git is a thrown check error (which `open-pr` refuses under enforce), never a silent hang. */
export const GIT_TIMEOUT_MS = 60 * 1000;
const gitIn = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });

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
    let from = '';
    if (path === '') { from = parts[i + 1] ?? ''; path = parts[i + 2] ?? ''; i += 2; }
    if (path) files.push({ path, ...(from ? { from } : {}), additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) });
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

export function recordBypass(cwd, { reason, head, risk, actor = '', operatorInstruction = '', now = new Date(), recordDir = defaultBypassRecordDir() }) {
  const row = { at: now.toISOString(), head, reason: String(reason).slice(0, 500), actor: String(actor).slice(0, 200), operatorInstruction: String(operatorInstruction).slice(0, 1000), risk: risk.reasons };
  appendFileSync(join(gitDirOf(cwd), BYPASS_LOG_FILE), `${JSON.stringify(row)}\n`);
  // Durable + countable: the coroner hook is not built yet, so every bypass is ALSO one JSONL line under
  // `.operations/pre-pr-bypass/` (gitignored with the rest of `.operations/`), which a coroner pass can count.
  // Not best-effort: a bypass that cannot be counted is refused (open-pr turns this throw into a refusal), so the
  // audit can never silently undercount.
  mkdirSync(recordDir, { recursive: true });
  appendFileSync(join(recordDir, `${row.at.slice(0, 10)}.jsonl`), `${JSON.stringify(row)}\n`);
}

/** `<repo root>/.operations/pre-pr-bypass`, resolved from this file's location. */
export function defaultBypassRecordDir() { return process.env.WE_PRE_PR_BYPASS_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.operations', 'pre-pr-bypass'); }

/** One untrusted string as a single-line markdown code span: line breaks (CR, LF, NEL, U+2028/9, VT, FF) and other
 *  control characters become spaces, backticks become `'`, so the text can never open a new block, a heading, a
 *  mention or an HTML comment in the PR body. NFKC-folded first so look-alike backticks/newlines fold too. */
export function codeSpan(text, max = 1000) {
  // Cut to length FIRST, then strip: control, format (bidi overrides, zero-width), lone surrogates (a cut can leave
  // half a pair), and line/paragraph separators all become a space.
  const flat = String(text ?? '').normalize('NFKC').slice(0, max).replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+/gu, ' ').replace(/`/g, "'").trim();
  return `\`\` ${flat} \`\``;
}

/** The PR-body line recording a bypass. Every dynamic part is a code span. */
export function renderBypassNote({ actor = '', reason = '', operatorInstruction = '' } = {}) {
  return `\n\n**Pre-PR review bypassed** by ${codeSpan(actor, 200)} — reason: ${codeSpan(reason, 500)}. Operator instruction: ${codeSpan(operatorInstruction, 1000)}\n`;
}

/**
 * Who may bypass. A dispatched worker (WE_CONVEYOR_WORKER=1) never; an unrecognised marker fails closed; an
 * interactive session only with an explicit `--actor` plus a quoted operator instruction (the same honesty tax
 * as review-set-label's clear-human). @returns {{ok:boolean, refusal:string}}
 */
export function authoriseBypass({ role, actor = '', operatorInstruction = '' }) {
  if (role === 'worker') return { ok: false, refusal: 'a dispatched worker (WE_CONVEYOR_WORKER=1) is refused a bypass of the pre-PR review — run /converge and stamp the receipt instead' };
  if (role !== 'orchestrator') return { ok: false, refusal: 'the session role is unknown (unrecognised WE_CONVEYOR_WORKER marker), so the bypass is refused' };
  if (!String(actor).trim() || !String(operatorInstruction).trim()) {
    return { ok: false, refusal: '--skipPrePrReview needs an operator-approved instruction: pass --actor=<name> and --operatorInstruction="<the operator instruction authorising it, quoted>"' };
  }
  return { ok: true, refusal: '' };
}

/**
 * The whole open-pr pre-check, over a lane checkout. IO only through `cwd` git. Returns the decision plus the risk.
 */
export function checkPrePrReview({ cwd, base = 'main', sha = 'HEAD', env = process.env, skip = '', actor = '', operatorInstruction = '', settings, role, recordDir } = {}) {
  const loaded = settings ? { settings, error: '' } : loadPrePrSettings();
  const { settings: s } = loaded;
  const settingsError = loaded.error || '';
  if (s.mode === 'off') return { ...decidePrePrReview({ settings: s, risk: { gated: false }, headTree: '' }), settings: s };
  // Pin the commit ONCE: the diff, the card reads, the tree and (via the returned `sha`) the commit pr-land
  // publishes are all this one object, never a `HEAD` that can move between the gate and the push.
  sha = gitIn(cwd, ['rev-parse', '--verify', `${sha}^{commit}`]).trim();
  const { files } = readDiffFiles({ cwd, base, sha });
  const cards = files.filter((f) => isCardPath(f.path)).map((f) => f.path);
  const hasPreparedCard = cards.some((p) => { try { return isPreparedCard(gitIn(cwd, ['show', `${sha}:${p}`])); } catch { return false; } });
  const sessRole = role ?? sessionRole(env);
  const operatorAgent = sessRole !== 'worker';
  const risk = classifyPrRisk({ files, hasPreparedCard, operatorAgent, settings: s });
  const headTree = treeOf(cwd, sha);
  const wantsSkip = typeof skip === 'string' && skip.trim() !== '';
  const auth = wantsSkip ? authoriseBypass({ role: sessRole, actor, operatorInstruction }) : { ok: true, refusal: '' };
  const decision = decidePrePrReview({ settings: s, risk, receipt: readReceipt(cwd), headTree, skip: auth.ok ? skip : '' });
  if (wantsSkip && !auth.ok && decision.action === 'refuse') decision.message = `bypass refused — ${auth.refusal}. ${decision.message}`;
  if (decision.why === 'bypass') {
    recordBypass(cwd, { reason: skip, head: sha, risk, actor, operatorInstruction, ...(recordDir ? { recordDir } : {}) });
    decision.bypass = { reason: skip.trim(), actor: actor.trim(), operatorInstruction: operatorInstruction.trim() };
  }
  return { ...decision, risk, headTree, sha, settings: s, ...(settingsError ? { settingsError } : {}) };
}

/**
 * The tree hash of the lane's WORKING TREE as `/converge` reads it (tracked edits plus untracked, non-ignored
 * files — `git add -A` semantics) — computed through a throwaway index, so the lane's real index and HEAD are
 * untouched. After the reviewed content is committed, the commit's tree equals this.
 */
export function workingTreeOf(cwd) {
  const tmp = mkdtempSync(join(tmpdir(), 'pre-pr-idx-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') };
  const run = (args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    run(['read-tree', 'HEAD']);
    // Against the temp index (= HEAD), `--others` is exactly the untracked set; skip the scratch among it by literal path.
    const scratch = run(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter((p) => p && isScratchPath(p));
    run(['add', '-A', '--', '.', ...scratch.map((p) => `:(exclude,literal)${p}`)]);
    return run(['write-tree']).trim();
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const sessionRole = (env) => classifySession(env).role;
