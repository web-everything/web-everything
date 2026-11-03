/**
 * @file scripts/lib/net-diff-fingerprint.mjs
 * @description R503: the ONE shared "did the code change?" test for every carry (operator approval, canonical
 *   audit, prototype-load ruledWeakened entries and ready records). It is R200's reviewed-diff fingerprint
 *   (`normalizeDiffFingerprint`, which drops only the drain's root lane manifest) applied to the PR's net diff
 *   against its merge-base with `base`, so a rebase or a merge of main that leaves the PR's own change alone keeps
 *   the same value, and any other change (even one character) moves it. Never a second hashing rule.
 *   Fail closed: any git failure, unresolvable ref, option-shaped ref or empty diff yields `null`, and `null`
 *   never carries.
 */
import { execFileSync } from 'node:child_process';
import { normalizeDiffFingerprint } from './review-escalation.mjs';

const REF = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$/;
const FP = /^[0-9a-f]{64}$/i;

/**
 * IO (injectable `exec`): fingerprint of `git diff <merge-base(base,head)> <head>` in `repo`, or null.
 * @returns {string|null}
 */
export function netDiffFingerprint(repo, base, head, { exec = execFileSync } = {}) {
  try {
    if (typeof repo !== 'string' || !repo || !REF.test(String(base ?? '')) || !REF.test(String(head ?? ''))) return null;
    const run = (args) => String(exec('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }) || '');
    const sha = (rev) => { const s = run(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim(); return /^[0-9a-f]{40,64}$/i.test(s) ? s : null; };
    const headSha = sha(head), baseSha = sha(base);
    if (!headSha || !baseSha) return null;
    const fork = run(['merge-base', '--end-of-options', baseSha, headSha]).split('\n')[0].trim();
    if (!/^[0-9a-f]{40,64}$/i.test(fork)) return null;
    return normalizeDiffFingerprint(run(['diff', '--no-ext-diff', '--end-of-options', fork, headSha]));
  } catch { return null; }
}

/** PURE: a recorded fingerprint covers the live head only when both are real fingerprints and equal. */
export function carriesAcross(recordedFp, liveFp) {
  return typeof recordedFp === 'string' && typeof liveFp === 'string' && FP.test(recordedFp) && FP.test(liveFp)
    && recordedFp.toLowerCase() === liveFp.toLowerCase();
}
