/** Deterministic repair scope fence. Operator prose is data; only explicit removal markers are executable policy. */
import { coversFile } from '../readiness/scope-lease.mjs';
import { cascadePolicy, platformPreference } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { isOperatorAuthored } from '../lib/marker-authorship.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';

export function resolveScopeFence({ env = process.env, tool = readSettings().fix, platform } = {}) {
  const bool = v => v === undefined ? undefined : /^(true|on|1)$/i.test(v) ? true : /^(false|off|0)$/i.test(v) ? false : v;
  const result = cascadePolicy('fix.scopeFence', tool?.scopeFence, {
    standard: { enabled: true, mode: 'warn' },
    platform: (platform ?? platformPreference('fix', { env }))?.scopeFence ?? {}, env,
    envValues: { enabled: bool(env.WE_FIX_SCOPE_FENCE_ENABLED), mode: env.WE_FIX_SCOPE_FENCE_MODE },
    valid: { enabled: v => typeof v === 'boolean', mode: v => ['stand-down', 'warn'].includes(v) },
  });
  return { ...result, value: { scopeFence: result.value },
    sources: Object.fromEntries(Object.entries(result.sources).map(([k, v]) => [`scopeFence.${k}`, v])) };
}

export function removalMarkers(text) {
  text = String(text ?? '');
  // Reject incomplete evidence rather than silently dropping a removal marker beyond a cap.
  if (text.length > 1024 * 1024) throw new RangeError('scope-removed input limit exceeded (1 MiB)');
  const removed = [], marker = 'scope-removed:';
  for (const raw of text.split(/\r\n?|\n|\u2028|\u2029/)) {
    if (raw.length > 16 * 1024) throw new RangeError('scope-removed line limit exceeded (16 KiB)');
    let line = raw.trim();
    if (line.startsWith('<!--')) line = line.slice(4).trimStart();
    if (!line.startsWith(marker)) continue;
    line = line.slice(marker.length).trimEnd();
    if (line.endsWith('-->')) line = line.slice(0, -3);
    removed.push(...line.split(/[,\s]+/).filter(s => /^[A-Za-z_$][\w$]*$/.test(s)));
  }
  return removed;
}

/** `incomplete` names marker evidence that could not be read; the brief warns and the push fence fails closed on it. */
export function operatorScope(comments = []) {
  const notes = [], removed = [], incomplete = [];
  for (const c of comments) {
    if (!isOperatorAuthored(c) || !/^🔁 review — changes requested/.test(c.body ?? '')) continue;
    try { removed.push(...removalMarkers(c.body)); } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      incomplete.push(e.message);
    }
    const lines = c.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(?:>\s*)?(?:Out of scope:|scopeNotes:)/i.test(lines[i])) {
        notes.push(lines[i]);
        while (i + 1 < lines.length && /^\s*(?:[-*]|\d+\.)\s/.test(lines[i + 1])) notes.push(lines[++i]);
      } else if (/\bx[a-z0-9]+ carries\b/i.test(lines[i])) notes.push(lines[i]);
    }
  }
  return { notes, removed: [...new Set(removed)], ...(incomplete.length ? { incomplete } : {}) };
}

/** The brief lists comment markers only; commit-message markers are enforced too, so the fixer is told where to read them. */
export const COMMIT_MARKERS_NOTE = 'PR commit messages can carry more `scope-removed:` markers, and the push fence enforces them too: run `git log --format=%B origin/<base>..HEAD` and honour every one before re-adding removed code.\n';

export function scopeBrief(scope, { notes = [], removed = [], incomplete = [] } = {}) {
  const warning = incomplete.length ? `Operator scope evidence is incomplete (${incomplete.join('; ')}). Treat every operator exclusion on the PR as binding; the push fence withholds any push it cannot check.\n` : '';
  return `## Declared repair scope\n\n${scope.join(', ')}\n\n${notes.join('\n')}\n${removed.length ? `scope-removed: ${removed.join(', ')}\n` : ''}${warning}${COMMIT_MARKERS_NOTE}\nStay inside this scope; anything else → stand down with a scope-increase request.\n\n`;
}

/** Fixer-controlled text is percent-encoded outside a safe path alphabet and capped before it reaches a posted comment or prompt. */
export function inertText(value, max = 200) {
  const chars = Array.from(String(value ?? ''));
  const cut = chars.slice(0, max).join('').replace(/[^\w./+-]/gu, c => `%${c.codePointAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return chars.length > max ? `${cut}...` : cut;
}

const LISTED_VIOLATIONS = 20;

/** The added lines of a plain `git diff -U0` patch, file headers excluded. */
export function addedLines(patch = '') {
  let inHunk = false;
  return patch.split('\n').filter(line => {
    if (line.startsWith('diff --git ')) inHunk = false;
    if (line.startsWith('@@ ')) inHunk = true;
    return line.startsWith('+') && (inHunk || !line.startsWith('+++ '));
  });
}

/** `additions` (lines) wins over `patch` when the caller already attributed the added lines. */
export function scopeFenceDecision({ scope = [], repo, paths = [], patch = '', additions = addedLines(patch), removed = [], policy }) {
  if (policy?.enabled === false) return { action: 'push', violations: [] };
  const key = repoKeyForSlug(repo) ?? repo;
  const allowed = scope.map(s => s.trim().split('#')[0]).filter(s => !s.includes(':') || s.startsWith(`${key}:`))
    .map(s => s.replace(/^[^:]+:/, ''));
  const outside = paths.filter(p => !allowed.some(s => coversFile(`${key}:${s}`, `${key}:${p}`)));
  const addedIdentifiers = new Set(additions.join('\n').match(/[A-Za-z_$][\w$]*/g) ?? []);
  const identifiers = [...new Set(removed)].filter(id => addedIdentifiers.has(id));
  const violations = [...outside.map(p => `outside declared scope: ${inertText(p)}`), ...identifiers.map(id => `re-adds operator-removed identifier: ${inertText(id)}`)];
  if (!violations.length) return { action: 'push', violations };
  const more = violations.length - LISTED_VIOLATIONS;
  const listed = [...violations.slice(0, LISTED_VIOLATIONS), ...(more > 0 ? [`and ${more} more`] : [])];
  return { action: policy?.mode === 'warn' ? 'warn' : 'stand-down', violations, files: outside, identifiers,
    reason: `scope-increase request: proposed repair ${listed.join('; ')}. Operator approval is required to widen this PR's scope.` };
}

/** A known head movement refuses the push without sending the repair into an infrastructure retry loop. */
export class ScopeFenceHeadMovedError extends Error {
  constructor(head, sha) {
    super(`PR head ${head.slice(0, 8)} moved beyond the verified ${sha.slice(0, 8)} or is unavailable locally; follow push-rejected recovery`);
  }
}

/** Evidence that will not become readable by retrying (an oversized marker, an uncompletable commit list): a person decides. */
export class ScopeFenceEvidenceError extends Error {
  constructor(message, context) { super(message); this.context = context; }
}

/** The same gate wraps early, green and salvage pushes. Warn is observational, including evidence failures. */
export function fencedPush({ readContext, readDiff, push, standDown, note, policy }) {
  if (policy.enabled === false) return push();
  const warn = event => {
    // Diagnostics must never turn advisory policy into a push refusal.
    try { note({ event: 'fix.scopeFence.would-block', mode: 'warn', files: [], identifiers: [], ...event }); } catch {}
  };
  let context, decision;
  try {
    context = readContext();
    decision = scopeFenceDecision({ ...context, ...readDiff(context), policy });
  } catch (e) {
    if (policy.mode === 'warn') {
      warn({ reason: String(e?.message ?? e), error: e?.constructor?.name ?? 'Unknown', evidenceUnavailable: true });
      return push();
    }
    if (e instanceof ScopeFenceHeadMovedError) return { ok: false, moved: true, terminal: true, reason: e.message };
    if (e instanceof ScopeFenceEvidenceError) {
      const reason = `scope-increase request: scope fence evidence cannot be read in full (${e.message}). Operator review is required before this repair is pushed.`;
      standDown(reason, e.context);
      return { ok: false, scopeFence: true, terminal: true, reason };
    }
    return { ok: false, scopeFence: true, transient: true, reason: `scope fence evidence unavailable: ${e.message}` };
  }
  if (decision.action === 'stand-down') {
    standDown(decision.reason, context);
    return { ok: false, scopeFence: true, terminal: true, reason: decision.reason };
  }
  if (decision.action === 'warn') warn({ reason: decision.reason, files: decision.files, identifiers: decision.identifiers, violations: decision.violations });
  return push();
}
