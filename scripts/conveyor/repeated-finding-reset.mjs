/** Repeated findings stop patch loops. Only operator scope-baseline markers authorize a reset. */
import { normalizeComment, parseFindings } from '../operations/coroner-rounds.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { FIX_END_INFRA_STALL_PREFIX } from '../lib/ruling-ledger.mjs';
import { createHash } from 'node:crypto';

export function resolveFixSafety({ env = process.env, tool = readSettings().fix, platform } = {}) {
  const bool = v => v === undefined ? undefined : /^(true|1|on)$/i.test(v) ? true : /^(false|0|off)$/i.test(v) ? false : v;
  return cascadePolicy('fix', tool, { standard: { alertAtRoundCap: true, resetOnRepeatedFinding: true }, platform, env,
    valid: { alertAtRoundCap: v => typeof v === 'boolean', resetOnRepeatedFinding: v => typeof v === 'boolean' },
    envValues: { alertAtRoundCap: bool(env.WE_FIX_ALERT_AT_ROUND_CAP), resetOnRepeatedFinding: bool(env.WE_FIX_RESET_ON_REPEATED_FINDING) } });
}
const normalized = text => text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const key = (f, envelope) => JSON.stringify([f.lens, f.file, normalized(f.claim), envelope]);
// review-pr renders a `---` trailer after the findings (Decision, skipped seats, Net basis with the head
// sha). Cut at its LAST occurrence, so juror text shaped like it stays in identity.
const TRAILER = /\n\n---\n\n(?:\*\*Decision:\*\* |Net basis: |⚠️ DEGRADED BASIS )/g;
// Before the trailer: card suggestions, then (advisory notes) verifier disputes, then the outcome line.
// Juror text can copy that shape, so the section is dropped only when its fix range names the head the
// renderer's own Net basis line names. The fixed-text outcome line stays in identity.
const CARDS = '\n\n### Card suggestions (filed later) (';
const CARD_SHAPE = new RegExp('^\\n\\n### Card suggestions \\(filed later\\) \\((\\d+)\\)\\n'
  + 'Later-round advisory findings on code the latest fix \\(`[0-9a-f]{8}\\.\\.([0-9a-f]{8})`\\) did not touch,[^\\n]*'
  + '((?:\\n- `[^`\\n]*` `[^`\\n]*` — [^\\n]*)+)'
  + '(?:\\n\\n\\*\\*Disputed by one verifier answer \\(\\d+\\):\\*\\* [^\\n]*(?:\\n- [^\\n]*)+)?'
  + '(\\n\\n\\*\\*Advisory outcome:\\*\\* [^\\n]*)?$');
function withoutRendererTail(envelope) {
  const trailer = [...envelope.matchAll(TRAILER)].at(-1);
  if (!trailer) return envelope;
  const rest = envelope.slice(0, trailer.index);
  const head = [...envelope.slice(trailer.index).matchAll(/^Net basis: `[0-9a-f]+\.\.([0-9a-f]{8})[0-9a-f]*`/gm)].at(-1)?.[1];
  const at = rest.lastIndexOf(CARDS), m = at < 0 ? null : CARD_SHAPE.exec(rest.slice(at));
  if (!m || !head || m[2] !== head || Number(m[1]) !== m[3].split('\n- ').length - 1) return rest;
  return rest.slice(0, at) + (m[4] ?? '');
}
// Per-round finding state is not identity: the verify, citation-scope and impact tags that end a
// finding's text, and whether its prevention line was captured. Mirrors parseFindings' blocks and only
// touches those rendered positions, where juror text reads exactly as the renderer's own would.
const BOUNDARY = /^(?:### |\*\*Advisory outcome:|---\s*$|Net basis:)/;
const PREVENTION = /^(\s+- _Prevention) \((?:captured|OWED — file it)\):_/;
const TAGS = new RegExp('(?: _\\[(?:CONFIRMED|PLAUSIBLE|SPECULATIVE)\\]_)?'
  + '(?: _\\[⚠️ CITATION NOT IN THE NET DIFF — reported, but withheld from the verdict; re-cite it to block\\]_)?'
  + '(?: _\\[impact if unfixed: \\w+\\]_)?$');
function withoutFindingState(envelope) {
  const lines = envelope.split('\n');
  let block = null, lens = false;
  const close = () => {
    if (!block) return;
    let last = block.at(-1);
    if (block.length > 1 && PREVENTION.test(lines[last])) {
      lines[last] = lines[last].replace(PREVENTION, '$1:_');
      last = block.at(-2);
    }
    lines[last] = lines[last].replace(TAGS, '');
    block = null;
  };
  for (const [n, line] of lines.entries()) {
    if (BOUNDARY.test(line)) break;
    if (/^\*\*([^*/]+)\/([^*]+)\*\*\s*\(\d+\)/.test(line)) { close(); lens = true; continue; }
    if (lens && /^- `([^`:]+?)(?::(\d+))?`\s+—\s+/.test(line)) { close(); block = [n]; continue; }
    if (block && line.trim()) block.push(n);
  }
  close();
  return lines.join('\n');
}
// Markdown does not distinguish a multiline summary from injected headings/bullets.
// Bind a repeat to the complete rendered Findings envelope, including text the compact
// parser may treat as a footer. Ambiguous formatting can decline a reset, never grant one.
function reviewIdentity(body) {
  const text = body.replace(/\r\n?|[\u{2028}\u{2029}]/gu, '\n');
  const heading = /^### Findings[^\n]*$/m.exec(text);
  if (!heading) return { findings: [], envelope: '' };
  const end = heading.index + heading[0].length;
  const envelope = withoutFindingState(withoutRendererTail(text.slice(end)));
  // Claims are parsed from the same cleaned text, so both halves of the key share one normalization.
  const findings = parseFindings(text.slice(0, end) + envelope, { maxClaimChars: Infinity, fullClaim: true });
  const anchors = /^- `([^`\n]+?)(?::(\d+))?`\s+—\s+/gm;
  const declared = heading[0].match(/\((\d+)\)/)?.[1];
  // Strip moving source coordinates only when the declared count agrees with the
  // complete envelope; a fake bullet inside a summary must keep its own numeric text.
  if (declared === undefined || Number(declared) !== [...envelope.matchAll(anchors)].length
    || Number(declared) !== [...envelope.matchAll(/^- /gm)].length) return { findings, envelope };
  return { findings, envelope: envelope.replace(anchors, (_match, file) => `- \`${file}\` — `) };
}
export function repeatedFindingPlan(comments, { enabled = true } = {}) {
  if (!enabled) return { action: 'patch' };
  const seen = new Map(); let fix = 0, baseline = null, repeated = false;
  for (const raw of comments ?? []) {
    const c = normalizeComment(raw);
    if (!isTrustedMarkerAuthor({ author: { login: c.login } })) continue;
    if (c.operator) {
      const marker = c.body.match(/^(?:<!--\s*)?scope-baseline:\s*([0-9a-f]{40})(?:\s*-->)?\s*$/m);
      if (marker) baseline = marker[1];
    }
    if (/^🔓 conveyor fix-end/.test(c.body)) {
      if (!c.body.includes(FIX_END_INFRA_STALL_PREFIX)) fix++;
      continue;
    }
    const identity = reviewIdentity(c.body), findings = identity.findings;
    if (!findings.length) continue;
    const envelope = createHash('sha256').update(normalized(identity.envelope)).digest('hex');
    // Only the latest finding-bearing review determines whether a repeat still stands.
    repeated = false;
    for (const f of findings) {
      if (!f.file || !f.claim) continue;
      const k = key(f, envelope);
      if (seen.has(k) && seen.get(k) < fix) repeated = true;
      if (!seen.has(k)) seen.set(k, fix);
    }
  }
  return !repeated ? { action: 'patch' } : baseline ? { action: 'reset', baseline, reason: 'repeated finding' }
    : { action: 'stand-down', reason: 'repeated finding' };
}

/** Restore the scoped tree as a corrective commit, preserving published ancestry (no force push).
 * Replay only complete, linear commits whose every changed path is in the operator's scope.
 * Validation precedes mutation. Conflict/unreadable history stands down; the borrowed lane is discarded.
 */
export function applyScopeReset({ baseline, scope, git }) {
  if (!/^[0-9a-f]{40}$/.test(baseline ?? '') || !Array.isArray(scope) || !scope.length
      || scope.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.split('/').includes('..'))) throw Error('repeated finding: missing baseline or scope');
  if (git('status', '--porcelain').trim()) throw Error('repeated finding: dirty reset lane');
  git('merge-base', '--is-ancestor', baseline, 'HEAD');
  const main = git('rev-parse', '--verify', 'origin/main^{commit}').trim();
  const base = git('merge-base', baseline, main).trim();
  const baselineFiles = git('diff', '--name-only', '--no-renames', '-z', base, baseline, '--').split('\0').filter(Boolean);
  if (!baselineFiles.length) throw Error('repeated finding: baseline has no scoped net change');
  const allowed = file => scope.some(p => file === p || (p.endsWith('/') && file.startsWith(p)));
  // Project the baseline onto today's main so the reset cannot undo other PRs that have landed since.
  // merge-tree exits 1 on a conflict; any other failure stays the raw read error.
  let tree;
  try { tree = git('merge-tree', '--write-tree', `--merge-base=${base}`, main, baseline).trim(); }
  catch (e) { if (e?.status === 1) throw Error('repeated finding: baseline conflicts with main'); throw e; }
  if (!/^[0-9a-f]{40}$/.test(tree)) throw Error('repeated finding: baseline conflicts with main');
  const rows = git('rev-list', '--reverse', '--parents', 'HEAD', `^${baseline}`, `^${main}`).trim().split('\n').filter(Boolean);
  const replay = [];
  for (const row of rows) {
    const [sha, ...parents] = row.split(' ');
    if (parents.length !== 1) {
      let mainMerge = false;
      for (const parent of parents) { try { git('merge-base', '--is-ancestor', parent, main); mainMerge = true; } catch { /* not main */ } }
      if (!mainMerge) throw Error('repeated finding: non-main merge needs operator');
      continue;
    }
    const files = git('diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', sha).split('\0').filter(Boolean);
    if (files.length && files.every(allowed)) replay.push(sha);
  }
  git('read-tree', '--reset', '-u', tree);
  for (const sha of replay) git('cherry-pick', '--no-commit', sha);
  return { baseline, replay };
}
