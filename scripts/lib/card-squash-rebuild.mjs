import { squashPatchHash, patchWithoutPositions } from './card-squash-marker.mjs';
export { patchWithoutPositions } from './card-squash-marker.mjs';
/** Single-parent card rebuilds: immutable inputs, preserved attribution and a fail-closed net patch proof. */
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';

export function loadCardRebaseSettings({ env = process.env, platform = platformPreference('cardRebase', { env }),
  repo = readSettings()?.cardRebase } = {}) {
  const raw = env.WE_CARD_REBASE_SQUASH_TO_SINGLE_COMMIT;
  const value = ['true', '1'].includes(raw) ? true : ['false', '0'].includes(raw) ? false : raw || undefined;
  return cascadePolicy('cardRebase', repo, { standard: { squashToSingleCommit: true }, platform,
    envValues: { squashToSingleCommit: value }, valid: { squashToSingleCommit: v => typeof v === 'boolean' } });
}
export const CARD_SQUASH_SUBJECT = /^drain: rebase \S+ onto \S+, (?:drop transient \.lane-manifest\.json(?:, drop fix evidence [^,]+(?:, [^,]+)*?)?|auto-resolve non-overlapping content conflict\(s\) in [^,]+(?:, [^,]+)*?(?:, drop transient \.lane-manifest\.json)?)(?:, renumber #\d+→#\d+(?:\/#\d+→#\d+)*)?, squash to one commit$/;
const paths = r => r.status === 0 ? [...new Set(String(r.stdout ?? '').split('\n').filter(Boolean))].sort() : null;
export function cardTreeOnly({ run, cwd, base, tree }) {
  try {
    const changed = paths(run('git', ['diff', '--name-only', '--no-renames', base, tree], { cwd }));
    if (!isCardOnlyDiff(changed)) return false;
    // A card-shaped name is insufficient: reject links, executables and unreadable trees.
    // Every changed path must exist in the result; base entries may be absent for additions.
    for (const ref of [tree, base]) {
      const result = run('git', ['ls-tree', '-r', '-z', ref, '--', ...changed], { cwd });
      if (result.status !== 0) return false;
      const entries = String(result.stdout ?? '').split('\0').filter(Boolean);
      const seen = new Set();
      for (const entry of entries) {
        const match = /^100644 blob (?:[a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(entry);
        if (!match || !changed.includes(match[1]) || seen.has(match[1])) return false;
        seen.add(match[1]);
      }
      if (ref === tree && changed.some(path => !seen.has(path))) return false;
    }
    return true;
  } catch { return false; }
}
export function pinCardInputs({ run, cwd, base, mergeRef }) {
  const results = [base, mergeRef].map(ref => run('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd }));
  const ids = results.map(r => String(r.stdout ?? '').trim());
  return results.every(r => r.status === 0) && ids.every(id => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id)) ? ids : null;
}
export function dirtyCardStack({ run, cwd, base, mergeRef }) {
  const counts = [[], ['--merges']].map(flags => run('git', ['rev-list', ...flags, '--count', `${base}..${mergeRef}`], { cwd }));
  // An unreadable stack is never proof of currentness.
  return counts.some(r => r.status !== 0 || !/^\d+$/.test(String(r.stdout).trim()))
    || Number(counts[0].stdout) !== 1 || Number(counts[1].stdout) !== 0;
}
export function cardSquashRebuild({ run, cwd, base, mergeRef, tree, message }) {
  const log = run('git', ['log', `${base}..${mergeRef}`, '--format=%B'], { cwd });
  if (log.status !== 0) return { action: 'error', reason: 'cannot read squash co-authors' };
  const trailers = [...new Set(String(log.stdout).split('\n').filter(line => /^Co-Authored-By:/i.test(line)))];
  const body = ['Preserve the PR net patch while rebuilding its card history onto the current base.', ...trailers].join('\n');
  const ct = run('git', ['commit-tree', tree, '-p', base, '-m', `${message}, squash to one commit`, '-m', body], { cwd });
  const newCommit = String(ct.stdout ?? '').trim();
  if (ct.status !== 0 || !newCommit) return { action: 'error', reason: 'card squash commit-tree failed' };
  const oldRange = `${base}...${mergeRef}`;
  const oldFiles = paths(run('git', ['diff', '--name-only', '--no-renames', oldRange], { cwd }));
  const newFiles = paths(run('git', ['diff', '--name-only', '--no-renames', base, newCommit], { cwd }));
  const oldPatch = run('git', ['diff', '--binary', '--no-renames', '-U0', oldRange], { cwd });
  const newPatch = run('git', ['diff', '--binary', '--no-renames', '-U0', base, newCommit], { cwd });
  if (!oldFiles || !newFiles || JSON.stringify(oldFiles) !== JSON.stringify(newFiles)
    || oldPatch.status !== 0 || newPatch.status !== 0
    || patchWithoutPositions(oldPatch.stdout) !== patchWithoutPositions(newPatch.stdout))
    return { action: 'error', guard: 'squash-net-diff-mismatch', reason: 'card squash changed the PR net patch or changed path set; refusing push' };
  return { newCommit, proof: { oldHead: mergeRef, newHead: newCommit, patchHash: squashPatchHash(newPatch.stdout), oldFiles, newFiles, patchEqual: true } };
}
