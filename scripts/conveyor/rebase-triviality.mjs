/**
 * @file rebase-triviality.mjs — bounded local Git proof of an accepted rebase's net change.
 * Usage: node scripts/conveyor/rebase-triviality.mjs <oldHead> <newHead> <oldTarget> <newTarget>
 * Pin both targets before rebasing. Exit 0 proves triviality; exit 1 requires rearm-review.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRebaseTriviality, MAX_REBASE_DIFF_BYTES } from './accepted-conflict-rebase.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';

/** IO injection keeps failures and both merge-base reads hermetic in tests. */
export function proveRebaseTriviality(args, git = argv => execFileSync('git', argv, {
  encoding: 'utf8', timeout: resolveChildTimeoutMs(), maxBuffer: MAX_REBASE_DIFF_BYTES,
})) {
  try {
    if (args.length !== 4 || args.some(s => !/^[0-9a-f]{40}$/i.test(s))) throw new Error('four pinned SHAs required');
    const [oldHead, newHead, oldTarget, newTarget] = args;
    const patch = (head, target) => {
      const base = git(['merge-base', head, target]).trim();
      if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error('merge-base unreadable');
      // Whole-file context disambiguates repeated identical neighborhoods. Oversized evidence
      // hits the existing output bound and requires independent review.
      return git(['-c', 'core.quotePath=true', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames',
        '--no-color', '--no-relative', '--ignore-submodules=none', '--unified=2147483647', base, head, '--']);
    };
    return classifyRebaseTriviality(patch(oldHead, oldTarget), patch(newHead, newTarget));
  } catch {
    return { trivial: false, handback: 'rearm-review', why: 'Git proof unavailable — independent review required' };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = proveRebaseTriviality(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.trivial ? 0 : 1;
}
