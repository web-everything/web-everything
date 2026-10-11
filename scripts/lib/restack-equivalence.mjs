/**
 * Answers whether one head is only a mechanical restack of another, with identical PR contribution.
 * PR #4770: a base-only merge spent a takeover without fixing its blocked finding; the next review
 * then treated that same code as an ignored ruling and asked the operator to rule again.
 * This is the one definition of "mechanical restack" for ruling/ledger purposes. A "merge of
 * the base" is proven by shape (only merges on the first-parent line) plus identical own
 * contribution against the latest merged-in tip. No remote ref is read and nothing is
 * fetched, so the check is hermetic and works in any clone that has the commit objects.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeContributionFingerprint } from './review-escalation.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = /^[0-9a-f]{40}$/i;
const cache = new Map();
export const clearRestackEquivalenceCache = () => cache.clear();

export function isRestackOf({ fromHead, toHead, root = REPO_ROOT, exec = execFileSync }) {
  const key = `${root}|${fromHead}|${toHead}`;
  if (cache.has(key)) return cache.get(key);
  const git = (...args) => {
    const output = exec('git', ['-C', root, ...args], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (typeof output !== 'string') throw new Error('Unexpected git output');
    return output;
  };
  const sha = (output) => {
    const value = output.trim();
    if (!SHA.test(value)) throw new Error('Expected one commit SHA');
    return value;
  };
  const shas = (output) => {
    if (!output.trim()) return [];
    return output.trim().split('\n').map(sha);
  };
  const ancestor = (from, to) => {
    try {
      if (git('merge-base', '--is-ancestor', '--end-of-options', from, to) !== '') throw new Error('Unexpected ancestry output');
      return true;
    }
    catch (error) { if (error.status === 1) return false; throw error; }
  };
  const probe = () => {
    if (typeof fromHead !== 'string' || typeof toHead !== 'string' || !SHA.test(fromHead) || !SHA.test(toHead)
      || fromHead.toLowerCase() === toHead.toLowerCase()) return false;
    for (const head of [fromHead, toHead]) {
      if (git('cat-file', '-e', '--end-of-options', `${head}^{commit}`) !== '') return false;
    }
    if (!ancestor(fromHead, toHead)) return false;
    const chain = shas(git('rev-list', '--first-parent', '--end-of-options', `${fromHead}..${toHead}`));
    if (!chain.length) return false;
    let base;
    for (const [index, merge] of chain.entries()) {
      const parents = git('show', '-s', '--format=%P', '--end-of-options', merge).trim().split(' ');
      if (parents.length < 2 || parents.some((p) => !SHA.test(p))) return false;
      if (index === 0) base = parents[1];
      if (index === chain.length - 1 && parents[0].toLowerCase() !== fromHead.toLowerCase()) return false;
    }
    const contribution = (head) => {
      const mb = sha(git('merge-base', '--end-of-options', base, head));
      const diff = git('diff', '--no-color', '--no-ext-diff', '--no-renames', '--end-of-options', mb, head);
      // The normalizer also accepts already-computed digests; only raw diffs belong here.
      if (!diff.startsWith('diff --git ')) return null;
      return normalizeContributionFingerprint(diff);
    };
    const from = contribution(fromHead), to = contribution(toHead);
    return from !== null && to !== null && from === to;
  };
  let result = false;
  try { result = probe(); } catch { result = false; }
  cache.set(key, result);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return result;
}
