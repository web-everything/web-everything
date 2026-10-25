/** Bounded Git proof for re-settling a card-only policy skip on a moved head. */
import { proveNumberingOnlyMove } from './numbering-carry.mjs';
import { isCardOnlyDiff } from '../ci-card-only.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const MAX_COMMITS = 20;
const LIMIT = 1024 * 1024;

/**
 * Renumber-only (shared numbering proof) or card-only: toSha descends from fromSha through a bounded
 * linear chain of single-parent commits, and EVERY commit touches only card files (submodule and
 * external-diff config cannot hide a change). Anything unprovable is refused.
 */
export function proveCardOnlyHeadMove({ exec, fromSha, toSha, cwd, mainRef = 'origin/main' } = {}) {
  if (typeof exec !== 'function' || !SHA.test(fromSha ?? '') || !SHA.test(toSha ?? '') || fromSha === toSha) return { ok: false };
  const numbering = proveNumberingOnlyMove({ exec, fromSha, toSha, cwd, mainRef });
  if (numbering.ok) return numbering;
  const git = args => {
    const out = exec('git', args, { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: LIMIT, stdio: ['ignore', 'pipe', 'pipe'] });
    if (typeof out !== 'string' || Buffer.byteLength(out) > LIMIT) throw Error('git output unusable');
    return out;
  };
  try {
    git(['merge-base', '--is-ancestor', fromSha, toSha]);
    const lines = git(['rev-list', `--max-count=${MAX_COMMITS + 1}`, '--parents', `${fromSha}..${toSha}`]).trim().split('\n').filter(Boolean);
    if (!lines.length || lines.length > MAX_COMMITS) return { ok: false };
    for (const line of lines) {
      const [sha, ...parents] = line.trim().split(/\s+/);
      if (!SHA.test(sha) || parents.length !== 1) return { ok: false };
      const names = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames',
        '--ignore-submodules=none', '--no-ext-diff', sha]);
      if (!names.endsWith('\0') || !isCardOnlyDiff(names.slice(0, -1).split('\0'))) return { ok: false };
    }
    return { ok: true, kind: 'card-only' };
  } catch { return { ok: false }; }
}
