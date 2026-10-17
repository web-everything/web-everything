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
// Markdown does not distinguish a multiline summary from injected headings/bullets.
// Bind a repeat to the complete rendered Findings envelope, including text the compact
// parser may treat as a footer. Ambiguous formatting can decline a reset, never grant one.
function findingEnvelope(body) {
  const text = body.replace(/\r\n?|[\u2028\u2029]/g, '\n');
  const heading = /^### Findings[^\n]*$/m.exec(text);
  if (!heading) return '';
  const envelope = text.slice(heading.index + heading[0].length);
  const anchors = /^- `([^`\n]+?)(?::(\d+))?`\s+—\s+/gm;
  const declared = heading[0].match(/\((\d+)\)/)?.[1];
  // Strip moving source coordinates only when the declared count agrees with the
  // complete envelope; a fake bullet inside a summary must keep its own numeric text.
  if (declared === undefined || Number(declared) !== [...envelope.matchAll(anchors)].length
    || Number(declared) !== [...envelope.matchAll(/^- /gm)].length) return envelope;
  return envelope.replace(anchors, (_match, file) => `- \`${file}\` — `);
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
    const findings = parseFindings(c.body, { maxClaimChars: Infinity, fullClaim: true });
    if (!findings.length) continue;
    const envelope = createHash('sha256').update(normalized(findingEnvelope(c.body))).digest('hex');
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
