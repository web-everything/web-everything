/**
 * @file scripts/conveyor/prepare-outcome.mjs
 * @description The PREPARE worker's result, read into the outcome words of the planned `we.worker-result` v1
 * contract (handoff prepare-117: outcome `done | no-change | blocked | not-applicable`, blocker kinds such as
 * `spec-defect`). Pure text in, value out - no IO. Today a prepare worker still ends with a free-text line; this
 * module is the one place that line is read, so when item 117's schema-enforced JSON lands the producer changes
 * and the consumers (the prepare runner, the build-dispatch daemon) do not.
 *
 * Why it exists (live, 2026-10-07 19:35-20:05Z): the runner only understood `could-not-prepare:` (with a colon)
 * and had no already-done branch for a prepare. So a worker saying "already-done - delivered by commit X"
 * (#4560) and one saying "could-not-prepare - scope is wrong" (#4328) both fell through to "prepare requires a
 * card-only diff", were recorded as FAILURES, and the card sat `prepare-unstamped` for good.
 *
 *   no-change  + commit            -> resolve the card (after an independent check; never on the worker's word)
 *   blocked    + spec-defect       -> re-derive the scope from the code, or hold with a needs-you reason
 *   blocked    + needs-ruling      -> a real judgment call; the existing could-not-prepare finding path
 *   done                           -> the normal card-only diff
 */

import { redactSpawnText } from '../lib/describe-spawn-failure.mjs';

export const PREPARE_OUTCOMES = Object.freeze(['done', 'no-change', 'blocked', 'not-applicable']);
export const PREPARE_BLOCKER_KINDS = Object.freeze(['spec-defect', 'needs-ruling']);

// A separator after the keyword: a colon, a dash, an em/en dash, a full stop, or just whitespace. Markdown emphasis
// around the keyword is ignored: live 2026-10-09, `**could-not-prepare** — <policy choice>` (#4354, #4355, #4411,
// #4488) and `→ could-not-prepare. I left no diff` (#4328) were not read as declines and sat held as failures.
const SEP = String.raw`[*_\x60]*\s*(?:[:\-.‒-―]|\s)\s*`;
const ALREADY_DONE_RE = new RegExp(String.raw`(?:^|\n|\b)already[- ]done\b${SEP}`, 'i');
const COULD_NOT_RE = new RegExp(String.raw`(?:^|\n|\b)could[- ]not[- ]prepare\b${SEP}`, 'i');
// The sha may be quoted (`'10fedba…'`, live #4560) or back-ticked.
const COMMIT_RE = /\bcommit\s+[`'"]?([0-9a-f]{7,40})\b/i;
const BARE_SHA_RE = /\b([0-9a-f]{7,40})\b/;
// "scope is wrong", "wrong scope", "scope: points at the 4309 card itself", "the scope is stale / names the wrong file".
const SCOPE_DEFECT_RE = /\b(?:wrong|incorrect|stale|bad|invalid)\s+scope\b|\bscope:?`?\s*(?:(?:is|are|was|looks|seems)\s+(?:also\s+|clearly\s+|just\s+|[a-z]+ly\s+)?)?(?:wrong|incorrect|stale|invalid|bad|missing|empty|mismatch\w*)\b|\bscope:?`?\s+(?:points? (?:at|to)|names?|targets?|lists?)\b[^.;\n]{0,80}\b(?:itself|wrong|nothing to build|backlog card)/i;

/**
 * Read a prepare worker's final message.
 * @param {string} message
 * @returns {{outcome:'done'|'no-change'|'blocked', blocker:null|{kind:'spec-defect'|'needs-ruling'}, commit:string|null, summary:string}}
 *   `done` here means "the message declines nothing" - the caller still checks the diff.
 */
export function classifyPrepareReport(message) {
  const text = String(message ?? '');
  // Redacted BEFORE the cut: a secret straddling the 280-char boundary would otherwise leave a prefix no pattern matches.
  const summary = redactSpawnText(text.replace(/\s+/g, ' ').trim()).slice(0, 280);
  // A decline outranks an "already done" mention inside its own explanation.
  const decline = COULD_NOT_RE.exec(text);
  const done = ALREADY_DONE_RE.exec(text);
  if (done && (!decline || done.index < decline.index)) {
    const tail = text.slice(done.index);
    const commit = (COMMIT_RE.exec(tail) ?? BARE_SHA_RE.exec(tail))?.[1] ?? null;
    return { outcome: 'no-change', blocker: null, commit, summary };
  }
  if (decline) {
    const kind = SCOPE_DEFECT_RE.test(text.slice(decline.index)) ? 'spec-defect' : 'needs-ruling';
    return { outcome: 'blocked', blocker: { kind }, commit: null, summary };
  }
  return { outcome: 'done', blocker: null, commit: null, summary };
}

// ---- re-scope: the deterministic touch-set probe ---------------------------------------------------------------

const PATH_TOKEN_RE = /(?:we:)?((?:[\w.-]+\/)+[\w.-]+\.(?:mjs|cjs|js|ts|tsx|json|md|html|njk|css|yml|yaml))(?::\d+(?:-\d+)?)?/g;
const SCOPE_KEY_RE = /^scope:[^\n]*(?:\n[ \t]+[^\n]*)*/m;
export const MAX_DERIVED_SCOPE = 8;

/**
 * A repo-relative path that provably stays inside the repo: non-empty, no NUL/backslash, not absolute, and no `.`, `..`
 * or `.git` segment (one trailing `/` is allowed for a directory scope entry). Card text is untrusted (externally sourced or LLM-authored), and every path read out of it reaches
 * `existsSync`/`readFileSync` of `join(lanePath, rel)` and is written back into the card as a scope entry - so a
 * `backlog/../../../.ssh/x.md` or `../../other-repo/a.mjs` must be refused here, at the one boundary
 * (PR #4323 review). The real fs probes in the runner re-check containment against the lane's real path as well.
 */
export const isSafeRepoRelativePath = (p) => {
  if (typeof p !== 'string' || !p || /[\0\\]/.test(p) || p.startsWith('/') || /^[a-z]:/i.test(p)) return false;
  // One trailing "/" is a directory scope entry ("we:reports/"); every other empty segment is refused.
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  return trimmed.split('/').every((seg) => seg && seg === seg.trim() && seg !== '.' && seg !== '..' && seg !== '.git');
};

/** Bare repo path of a scope entry (`we:scripts/a.mjs` -> `scripts/a.mjs`), or null for another repo or an unsafe path. */
export const bareScopePath = (entry) => {
  const s = String(entry ?? '').trim();
  if (/^[a-z][\w-]*:/i.test(s) && !s.startsWith('we:')) return null;
  const bare = s.replace(/^we:/, '');
  return isSafeRepoRelativePath(bare) ? bare : null;
};

/** A scope is defective when it has no entry, or every entry is a backlog card or a file that does not exist. */
export function scopeIsDefective(scope, { exists }) {
  const paths = (Array.isArray(scope) ? scope : []).map(bareScopePath).filter(Boolean);
  if (!paths.length) return true;
  return paths.every((p) => p.startsWith('backlog/') || !exists(p));
}

/**
 * Re-derive a card's scope from the code it cites. Every existing, non-backlog path the card body names is kept;
 * a cited BACKLOG card is followed one hop, taking that card's own scope (the card that says "tests for #4309"
 * touches what #4309 touches). Pure: `exists(path)` and `readScope(path)` are injected.
 * @returns {string[]} `we:`-prefixed entries, file-level, at most {@link MAX_DERIVED_SCOPE}; `[]` when none found
 */
export function deriveScopeFromCard(raw, { exists, readScope }) {
  const text = String(raw ?? '');
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  const found = [];
  const add = (p) => { if (!found.includes(p)) found.push(p); };
  for (const m of body.matchAll(PATH_TOKEN_RE)) {
    const p = m[1];
    if (!isSafeRepoRelativePath(p)) continue;
    if (p.startsWith('backlog/')) {
      for (const entry of readScope(p) ?? []) {
        const bare = bareScopePath(entry);
        if (bare && !bare.startsWith('backlog/') && exists(bare)) add(bare);
      }
    } else if (exists(p)) add(p);
  }
  return found.slice(0, MAX_DERIVED_SCOPE).map((p) => `we:${p}`);
}

/** Replace the card frontmatter's `scope:` (inline or block list) with `scope`. Text in, text out. */
export function replaceCardScope(raw, scope) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---(?=\n|$)/.exec(text);
  if (!fm) throw new Error('replaceCardScope: card has no frontmatter');
  const line = `scope: [${scope.map((s) => JSON.stringify(s)).join(', ')}]`;
  const inner = SCOPE_KEY_RE.test(fm[1]) ? fm[1].replace(SCOPE_KEY_RE, line) : `${fm[1]}\n${line}`;
  return `---\n${inner}\n---${text.slice(fm[0].length)}`;
}

/** The hold reason a spec-defect with no derivable scope carries: plain, names the way out, no card text. */
export function needsYouReason(kind, detail) {
  // The hold router scans hold reasons for its own phrases (already-done / superseded / not buildable) and routes
  // lane work on them; a needs-you reason must never trigger that, so those phrases are defused.
  // The detail is raw WORKER text and lands in the failure ledger, the findings ledger and the tick line, so a
  // token-shaped string in it is redacted like the ledger's `evidence`. Redact the whole raw text BEFORE the
  // truncation: a cut after it can never leave a partial secret that no pattern matches any more. (The strip below
  // swaps a character for a SPACE, so it cannot join two halves into a new token-shaped string.)
  const clean = redactSpawnText(detail).replace(/[\p{Cc}`<>]+/gu, ' ')
    .replace(/spec\s+(?:not buildable|superseded)/gi, 'spec issue').replace(/already done on main/gi, 'done elsewhere')
    .replace(/^\s*worker-declined/i, 'declined').replace(/\s+/g, ' ').trim().slice(0, 300);
  return `needs-you: prepare blocked (${kind}) - ${clean || 'no detail'}; re-scope the card by hand or close it`;
}
