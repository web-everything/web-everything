/** Repeated findings stop patch loops. Only operator scope-baseline markers authorize a reset. */
import { normalizeComment, parseFindings } from '../operations/coroner-rounds.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';

export function resolveFixSafety({ env = process.env, tool = readSettings().fix, platform } = {}) {
  const bool = v => v === undefined ? undefined : /^(true|1|on)$/i.test(v) ? true : /^(false|0|off)$/i.test(v) ? false : v;
  return cascadePolicy('fix', tool, { standard: { alertAtRoundCap: true, resetOnRepeatedFinding: true }, platform, env,
    valid: { alertAtRoundCap: v => typeof v === 'boolean', resetOnRepeatedFinding: v => typeof v === 'boolean' },
    envValues: { alertAtRoundCap: bool(env.WE_FIX_ALERT_AT_ROUND_CAP), resetOnRepeatedFinding: bool(env.WE_FIX_RESET_ON_REPEATED_FINDING) } });
}
const key = f => JSON.stringify([f.lens, f.file, f.claim.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()]);
export function repeatedFindingPlan(comments, { enabled = true } = {}) {
  if (!enabled) return { action: 'patch' };
  const seen = new Map(); let fix = 0, baseline = null, repeated = false;
  for (const raw of comments ?? []) {
    const c = normalizeComment(raw);
    if (!c.trusted) continue;
    if (c.operator) {
      const marker = c.body.match(/^(?:<!--\s*)?scope-baseline:\s*([0-9a-f]{40})(?:\s*-->)?\s*$/m);
      if (marker) baseline = marker[1];
    }
    if (/^🔓 conveyor fix-end/.test(c.body)) { fix++; continue; }
    const findings = parseFindings(c.body, { maxClaimChars: Infinity });
    if (!findings.length) continue;
    // Only the latest finding-bearing review determines whether a repeat still stands.
    repeated = false;
    for (const f of findings) {
      if (!f.file || !f.claim) continue;
      const k = key(f);
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
  const tree = git('merge-tree', '--write-tree', `--merge-base=${base}`, main, baseline).trim();
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
