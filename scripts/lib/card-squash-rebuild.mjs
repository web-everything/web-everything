import { squashPatchHash, patchWithoutPositions } from './card-squash-marker.mjs';
export { patchWithoutPositions } from './card-squash-marker.mjs';
/** Single-parent card rebuilds: immutable inputs, preserved attribution and a fail-closed net patch proof. */
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A changed base can absorb PR hunks, so patch equality alone is insufficient.
// Independently reproduce each unresolved result from the three immutable inputs.
function provePerPathMerge({ run, cwd, base, mergeRef, newCommit, oldFiles, newFiles, resolved }) {
  const isOid = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
  const ok = result => result?.status === 0 && !result.error && !result.signal;
  let scratch;
  try {
    const mb = run('git', ['merge-base', base, mergeRef], { cwd });
    const ancestor = String(mb.stdout ?? '').trim();
    if (!ok(mb) || !isOid(ancestor)) return null;
    // Verify every input tree independently of its per-path listing.
    for (const ref of new Set([ancestor, base, mergeRef, newCommit])) {
      const verified = run('git', ['rev-parse', '--verify', '-q', `${ref}^{tree}`], { cwd });
      if (!ok(verified) || !isOid(String(verified.stdout ?? '').trim())) return null;
    }
    const readEntry = (ref, path) => {
      const result = run('git', ['ls-tree', '--full-tree', '-z', ref, '--', path], { cwd });
      if (!ok(result) || !(typeof result.stdout === 'string' || Buffer.isBuffer(result.stdout)))
        throw new Error('unreadable squash proof entry');
      const output = String(result.stdout);
      if (!output) {
        const exists = run('git', ['rev-parse', '--verify', '-q', `${ref}:${path}`], { cwd });
        const verified = run('git', ['rev-parse', '--verify', '-q', `${ref}^{tree}`], { cwd });
        if (exists.status !== 1 || exists.error || exists.signal
          || ![exists.stdout, exists.stderr].every(value => value === '' || (Buffer.isBuffer(value) && value.length === 0))
          || !ok(verified) || !isOid(String(verified.stdout ?? '').trim()))
          throw new Error('unproven squash proof absence');
        return null;
      }
      const match = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/.exec(output);
      if (!match || match[0] !== output || match[4] !== path) throw new Error('invalid squash proof entry');
      return { mode: match[1], type: match[2], oid: match[3] };
    };
    const entriesEqual = (a, b) => a === b || (a !== null && b !== null
      && a.mode === b.mode && a.type === b.type && a.oid === b.oid);
    const absorbedPaths = [];
    const regularBlob = entry => entry?.mode === '100644' && entry.type === 'blob';
    const resolvedPaths = new Set(resolved.map(({ path }) => path));
    for (const path of [...new Set([...oldFiles, ...newFiles])].sort()) {
      // Union resolver output is exempt only while the path remains in both diffs.
      const entries = [ancestor, base, mergeRef, newCommit].map(ref => readEntry(ref, path));
      const [mbEntry, baseEntry, headEntry, treeEntry] = entries;
      if (entries.every(entry => entry === null)) return null;
      if (resolvedPaths.has(path) && oldFiles.includes(path) && newFiles.includes(path)) {
        // A resolved addition may lack ancestor/base entries, but never its head/result.
        if (!regularBlob(headEntry) || !regularBlob(treeEntry)
          || (mbEntry && !regularBlob(mbEntry)) || (baseEntry && !regularBlob(baseEntry))
          || (mbEntry && !baseEntry)) return null;
        continue;
      }
      const equalsHead = entriesEqual(treeEntry, headEntry);
      if (entriesEqual(baseEntry, mbEntry)) {
        if (!equalsHead) return null;
      } else if (entries.every(regularBlob)) {
        scratch ??= mkdtempSync(join(tmpdir(), 'card-squash-proof-'));
        let allInputsNonEmpty = true;
        const files = [baseEntry, mbEntry, headEntry].map(({ oid }, index) => {
          const blob = run('git', ['cat-file', 'blob', oid], { cwd, encoding: 'buffer' });
          if (!ok(blob) || !Buffer.isBuffer(blob.stdout)) throw new Error('unreadable squash merge input');
          allInputsNonEmpty &&= blob.stdout.length > 0;
          const hash = run('git', ['hash-object', '--stdin'], { cwd, input: blob.stdout });
          if (!ok(hash) || String(hash.stdout ?? '').trim() !== oid)
            throw new Error('invalid squash merge input bytes');
          const file = join(scratch, String(index));
          writeFileSync(file, blob.stdout, { mode: 0o600 });
          return file;
        });
        const merged = run('git', ['merge-file', '-p', ...files], { cwd, encoding: 'buffer' });
        if (!ok(merged) || !Buffer.isBuffer(merged.stdout)
          || (allInputsNonEmpty && merged.stdout.length === 0)) return null;
        const repeated = run('git', ['merge-file', '-p', ...files], { cwd, encoding: 'buffer' });
        if (!ok(repeated) || !Buffer.isBuffer(repeated.stdout) || !merged.stdout.equals(repeated.stdout)) return null;
        const hash = run('git', ['hash-object', '--stdin'], { cwd, input: merged.stdout });
        if (!ok(hash) || String(hash.stdout ?? '').trim() !== treeEntry.oid) return null;
      } else if (!entriesEqual(headEntry, baseEntry) || !entriesEqual(treeEntry, baseEntry)) return null;
      if (oldFiles.includes(path) !== newFiles.includes(path) || !equalsHead) absorbedPaths.push(path);
    }
    return { patchEqual: false, proofKind: 'per-path-merge', absorbedPaths };
  } catch { return null; }
  finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}

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
export function cardSquashRebuild({ run, cwd, base, mergeRef, tree, message, resolved = [] }) {
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
  // Only resolver-proven blobs may differ; all other paths retain the original net patch proof.
  const pathspecs = resolved.length ? ['--', ':(top)', ...resolved.map(({ path }) => `:(top,exclude,literal)${path}`)] : [];
  const oldUnresolved = resolved.length
    ? run('git', ['diff', '--binary', '--no-renames', '-U0', oldRange, ...pathspecs], { cwd }) : oldPatch;
  const newUnresolved = resolved.length
    ? run('git', ['diff', '--binary', '--no-renames', '-U0', base, newCommit, ...pathspecs], { cwd }) : newPatch;
  const blobsEqual = resolved.every(({ path, oid }) => {
    if (!oldFiles?.includes(path) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) return false;
    const blob = run('git', ['rev-parse', `${newCommit}:${path}`], { cwd });
    return blob.status === 0 && String(blob.stdout ?? '').trim() === oid;
  });
  let mergeProof;
  if (!oldFiles || !newFiles || JSON.stringify(oldFiles) !== JSON.stringify(newFiles)
    || oldPatch.status !== 0 || newPatch.status !== 0
    || oldUnresolved.status !== 0 || newUnresolved.status !== 0 || !blobsEqual
    || patchWithoutPositions(oldUnresolved.stdout) !== patchWithoutPositions(newUnresolved.stdout)) {
    if (oldFiles && newFiles && oldPatch.status === 0 && newPatch.status === 0
      && oldUnresolved.status === 0 && newUnresolved.status === 0 && blobsEqual)
      mergeProof = provePerPathMerge({ run, cwd, base, mergeRef, newCommit, oldFiles, newFiles, resolved });
    if (!mergeProof)
      return { action: 'error', guard: 'squash-net-diff-mismatch', reason: 'card squash changed the PR net patch or changed path set; refusing push' };
  }
  return { newCommit, proof: { oldHead: mergeRef, newHead: newCommit, patchHash: squashPatchHash(newPatch.stdout), oldFiles, newFiles, patchEqual: true,
    ...mergeProof,
    ...(resolved.length ? { resolvedPaths: resolved.map(({ path }) => path) } : {}) } };
}
