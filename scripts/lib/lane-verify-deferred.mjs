/**
 * @file scripts/lib/lane-verify-deferred.mjs
 * @description R893 — "verify deferred to CI". When lane verify ends infra-failed or unsettled (NEVER red), a
 *   distinct `deferred-to-ci` marker is recorded, bound to the exact HEAD sha, in its OWN file
 *   (`<gitDir>/.lane-verify-deferred`). It is deliberately NOT written into `.lane-verify`: every existing reader
 *   (finish-guard, check, prototype-load, drain, review gates) reads only that file, so none of them can see a
 *   deferred marker as green, by construction. The single consumer is pr-land's OPEN path
 *   (`deferredToCiDecision`), which never accepts the `land` mode; ready-to-merge still needs a green CI `test`
 *   check-run on the exact sha (`ciTestGreenOnSha`).
 */
import { readFileSync, existsSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readVerifyMarker } from './lane-verify.mjs';

export const DEFERRED_FILENAME = '.lane-verify-deferred';
export const DEFERRED_STATUS = 'deferred-to-ci';
/** Modes that only OPEN (and at most label once CI is green). `land` merges, so it is never allowed. */
export const DEFERRED_OPEN_MODES = Object.freeze(['park', 'label-on-green', 'open-only']);
/** Finish-guard statuses a deferred marker may stand in for. red / corrupt / running are never overridden. */
const OVERRIDABLE_GATE_STATUSES = Object.freeze(['absent', 'unverified', 'untracked', 'infrastructure-failure']);

/** The only infrastructure reasons that may defer to CI (verificationInfrastructureFailure + remote termination). */
export const DEFERRABLE_INFRA_REASONS = Object.freeze(['verify-unsettled', 'verify-timeout', 'verify-signal', 'remote-termination-unconfirmed']);
const validInfra = i => !!i && typeof i === 'object' && !Array.isArray(i) && DEFERRABLE_INFRA_REASONS.includes(i.reason) && typeof i.detail === 'string' && i.detail.length > 0;

/** Pure. Null unless there is an exact sha and infra evidence. */
export function buildDeferredRecord({ sha, infrastructure, exitCode = null, recordedAt = new Date().toISOString() } = {}) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return null;
  if (!validInfra(infrastructure)) return null;
  return {
    status: DEFERRED_STATUS, sha,
    reason: String(infrastructure.reason),
    detail: String(infrastructure.detail || infrastructure.reason),
    infrastructure, exitCode: Number.isFinite(Number(exitCode)) && exitCode != null ? Number(exitCode) : null,
    recordedAt,
  };
}

export function readDeferredMarker(gitDir) {
  const path = join(gitDir, DEFERRED_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { corrupt: true };
  } catch { return { corrupt: true }; }
}

/**
 * The deferred record pr-land's open path may use for EXACTLY `headSha`, or null. PR #6674 red team: a verify the
 * dispatcher KILLS (queue/gate ceiling) is settled into `.lane-verify` by the dispatcher itself
 * (recordKilledVerification); the killed child never reaches its terminal hook, so no deferred file is written.
 * The main marker is the single source of truth for the latest verdict, so it must AUTHORISE every deferral:
 * - unless the main marker is `infrastructure-failure` for exactly this sha, there is no deferral (fail closed: a
 *   missing marker after `reset` or a manual `rm`, a corrupt, running, red or green one, or one for another sha
 *   each void any deferred file left behind — a stale file alone can never open a PR);
 * - the record is then built from the main marker's own deferrable evidence, never from the deferred file (that
 *   file is a second copy that a later same-sha kill does not rewrite, so it could show stale evidence); a legacy
 *   `red`-with-signal record never defers.
 */
export function readDeferredForSha(gitDir, headSha) {
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)) return null;
  const main = readVerifyMarker(gitDir);
  if (!main || main.corrupt || main.sha !== headSha || main.status !== 'infrastructure-failure') return null;
  return buildDeferredRecord({ sha: headSha, infrastructure: main.infrastructure, exitCode: main.exitCode,
    ...(typeof main.finishedAt === 'string' ? { recordedAt: main.finishedAt } : {}) });
}

export function clearDeferredMarker(gitDir) {
  try { rmSync(join(gitDir, DEFERRED_FILENAME), { force: true }); } catch { /* best effort */ }
}

/**
 * Called with the terminal record verify just wrote. An infrastructure-failure writes the deferred marker; any
 * other terminal status (red, green) clears a stale one, so a red can never coexist with a deferred for its sha.
 * @returns {object|null} the deferred record written, else null
 */
export function recordTerminalVerifyOutcome(gitDir, finished) {
  if (finished?.status !== 'infrastructure-failure') { clearDeferredMarker(gitDir); return null; }
  const rec = buildDeferredRecord({ sha: finished.sha, infrastructure: finished.infrastructure, exitCode: finished.exitCode });
  if (!rec) { clearDeferredMarker(gitDir); return null; }
  const path = join(gitDir, DEFERRED_FILENAME);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  renameSync(tmp, path);
  return rec;
}

/**
 * Pure. May this refused finish-guard result still OPEN the PR? Only for a refused gate whose status is
 * absent/unverified/infrastructure-failure, a well-formed deferred marker for EXACTLY `headSha` (no carry-forward),
 * and a non-`land` mode.
 */
export function deferredToCiDecision({ gate, deferred, headSha, mode } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!gate || gate.ok !== false) return no('gate-not-refused');
  if (!OVERRIDABLE_GATE_STATUSES.includes(gate.status)) return no(`gate-status-${gate.status}`);
  if (!DEFERRED_OPEN_MODES.includes(mode)) return no(`mode-${mode}`);
  if (!deferred || deferred.corrupt || deferred.status !== DEFERRED_STATUS) return no('no-deferred-marker');
  if (!headSha || deferred.sha !== headSha) return no('deferred-sha-mismatch');
  if (!validInfra(deferred.infrastructure) || deferred.reason !== deferred.infrastructure.reason) return no('deferred-evidence-invalid');
  const disclosure = disclosureFor(deferred.infrastructure);
  if (!disclosure) return no('deferred-evidence-invalid');
  return { ok: true, reason: 'deferred-to-ci', disclosure };
}

const SIGNAL_NAME = /^SIG[A-Z0-9]{1,12}$/;
/**
 * Pure. The disclosure sentence, rendered from a FIXED template per deferrable reason — never from the marker's free
 * `detail` text. Any process in the lane can write `.lane-verify`, and text in a PR body means something to GitHub
 * and the bots that read it (`fixes #N` closes an issue on merge, `@user` pings, a main-red sha claims the red-main
 * fix), which no character filter can neutralise. Only validated fields are filled in: an integer ceiling, a
 * `queue`/`gate` phase, a `SIG*` name. The full evidence stays in the marker and the verify log.
 * @returns {string|null} null for an unknown reason
 */
export function disclosureFor(infrastructure) {
  const i = infrastructure && typeof infrastructure === 'object' ? infrastructure : {};
  let fact = null;
  if (i.reason === 'verify-timeout') {
    const ms = Number.isSafeInteger(i.ceilingMs) && i.ceilingMs > 0 ? `${i.ceilingMs}ms ` : '';
    const phase = i.phase === 'queue' || i.phase === 'gate' ? `${i.phase}-phase ` : '';
    fact = `the verify process tree was killed after the ${ms}${phase}ceiling`;
  } else if (i.reason === 'verify-signal') {
    fact = `the verify process ended on ${SIGNAL_NAME.test(String(i.signal)) ? i.signal : 'a signal'}`;
  } else if (i.reason === 'verify-unsettled') {
    fact = 'a test shard stayed inventory-incomplete after one split retry';
  } else if (i.reason === 'remote-termination-unconfirmed') {
    fact = 'the remote verify run could not be confirmed terminated';
  }
  return fact ? `lane verify deferred to CI: ${i.reason} - ${fact}; no test verdict (details in the lane verify marker and log)` : null;
}

/** Longest `detail` the disclosure carries; the full evidence stays in the marker and the verify log. */
export const DISCLOSURE_DETAIL_MAX = 300;
/**
 * Pure. Collapse marker text (verify detail derived from shard/runner output) to ONE bounded, inert line before it
 * reaches a PR body or a terminal: no newline, CR, U+2028/2029 or other control character (it would escape the
 * `> ` blockquote and could forge body lines that bots parse), no invisible/bidi format character, no backtick or
 * angle bracket (no code span or HTML comment marker). NFKC first so a full-width look-alike cannot slip through.
 */
// Built from code points so this source stays ASCII (a raw U+2028 would end a regex literal; raw bidi characters
// in source are a trojan-source hazard). [lo, hi] is a range; a bare number is one character.
const charClass = (...cps) => cps.map((c) => (Array.isArray(c) ? `${String.fromCharCode(c[0])}-${String.fromCharCode(c[1])}` : String.fromCharCode(c))).join('');
/** C0/C1 controls (newline, CR, tab, ESC...) plus the Unicode line and paragraph separators. */
const CONTROL_RE = new RegExp(`[${charClass([0x00, 0x1f], [0x7f, 0x9f], 0x2028, 0x2029)}]+`, 'g');
/** Invisible and bidi format characters: soft hyphen, ALM, MVS, zero-width/LRM/RLM, embeddings/overrides, isolates, BOM. */
const INVISIBLE_RE = new RegExp(`[${charClass(0xad, 0x61c, 0x180e, [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], 0xfeff)}]`, 'g');
export function oneLine(text, max = DISCLOSURE_DETAIL_MAX) {
  const flat = String(text ?? '').normalize('NFKC')
    .replace(CONTROL_RE, ' ')
    .replace(INVISIBLE_RE, '')
    .replace(/`/g, "'").replace(/</g, '‹').replace(/>/g, '›')
    .replace(/\s+/g, ' ').trim();
  // Cut on code points (never a lone surrogate) and end with ASCII `...` so a second pass (NFKC) is a no-op.
  const cps = Array.from(flat);
  return cps.length > max ? `${cps.slice(0, max - 3).join('')}...` : flat;
}

export function appendDeferredDisclosure(body, disclosure) {
  const base = typeof body === 'string' ? body : '';
  const line = oneLine(disclosure, DISCLOSURE_DETAIL_MAX + 100);
  if (base.includes(line)) return base; // idempotent: a rerun never stacks a second copy
  return `${base}${base.endsWith('\n') || !base ? '' : '\n'}\n> ${line}\n> ready-to-merge is withheld until the GitHub CI \`test\` check is green on this exact commit.\n`;
}

/**
 * pr-land's rerun path for an ALREADY-OPEN PR: write the composed body plus (for a deferred-to-ci open) the
 * disclosure in ONE edit, and only when it differs from the live body. Returns the body the PR now carries.
 * @param {{forge:{editBody:(pr:number|string, body:string)=>void}, prNum:number|string, liveBody:string, composed:string, deferred:{disclosure:string}|null}} o
 */
export function syncDeferredBody({ forge, prNum, liveBody, composed, deferred }) {
  const target = deferred?.disclosure ? appendDeferredDisclosure(composed, deferred.disclosure) : composed;
  if (target !== liveBody) forge.editBody(prNum, target);
  return target;
}

/**
 * pr-land's ready-to-merge gate for a deferred-to-ci PR: null when the label may be applied (not deferred, or a
 * green CI `test` check-run exists on exactly `sha`), else the `deferred-ci-not-green` refusal to emit (exit 3)
 * INSTEAD of labelling. A failed or unreadable PR view refuses (fail closed).
 */
export function deferredLabelRefusal({ forge, prNum, sha, deferred }) {
  if (!deferred) return null;
  let view = null;
  try { view = forge.viewPr(prNum, 'headRefOid,statusCheckRollup'); } catch { view = null; }
  if (ciTestGreenOnSha(view, sha)) return null;
  return {
    reason: 'deferred-ci-not-green', pr: Number(prNum), sha,
    detail: `PR #${prNum} opened with lane verify deferred to CI - no green CI test check-run on ${String(sha).slice(0, 8)} yet, so ready-to-merge is NOT applied`,
  };
}

/** Pure. A `gh pr view --json headRefOid,statusCheckRollup` result: is the `test` check green on exactly `sha`? */
export function ciTestGreenOnSha(view, sha) {
  if (!view || !sha || view.headRefOid !== sha || !Array.isArray(view.statusCheckRollup)) return false;
  // EVERY `test` entry must be green: a newer pending/failed run of the same name voids an older success.
  const tests = view.statusCheckRollup.filter(c => c && c.name === 'test');
  return tests.length > 0 && tests.every(c => String(c.conclusion).toUpperCase() === 'SUCCESS');
}
