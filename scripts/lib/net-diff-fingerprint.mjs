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
    const raw = (args) => exec('git', ['-C', repo, ...args], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
    const run = (args) => Buffer.from(raw(args) ?? '').toString('utf8');
    const sha = (rev) => { const s = run(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim(); return /^[0-9a-f]{40,64}$/i.test(s) ? s : null; };
    const headSha = sha(head), baseSha = sha(base);
    if (!headSha || !baseSha) return null;
    const fork = run(['merge-base', '--end-of-options', baseSha, headSha]).split('\n')[0].trim();
    if (!/^[0-9a-f]{40,64}$/i.test(fork)) return null;
    // No external driver, no text conversion, and submodule changes stay visible: nothing may hide a change.
    const bytes = Buffer.from(raw(['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--end-of-options', fork, headSha]) ?? '');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } // valid UTF-8 matches R200's value exactly
    catch { text = `\0latin1\n${bytes.toString('latin1')}`; } // invalid bytes stay distinct (a lossy decode would merge 0xFE and 0xFF)
    return normalizeDiffFingerprint(text);
  } catch { return null; }
}

/** PURE: a recorded fingerprint covers the live head only when both are real fingerprints and equal. */
export function carriesAcross(recordedFp, liveFp) {
  return typeof recordedFp === 'string' && typeof liveFp === 'string' && FP.test(recordedFp) && FP.test(liveFp)
    && recordedFp.toLowerCase() === liveFp.toLowerCase();
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const TEST_FILE = /(^|\/)[^/]*\.(test|spec)\.(?:[cm]?[jt]sx?)$/;
const SETUP_OR_CONFIG = /(setup|config|vitest|jest|global|helper|fixture|mock|\.d\.ts$)/i;
const WEAKENING_ADDED = /\.(skip|only|todo|skipIf|runIf|fails)\b|\b(xit|xtest|xdescribe|fit|fdescribe|ftest)\s*\(/;

/**
 * Merge-path (fail closed): does `from..to` change ONLY test files, and only by adding lines? `from` must be an
 * ancestor of `to`. Every unreadable or unexpected input refuses. Derived from the diff alone, never from labels.
 * Allowed: new or in-place-modified `*.test|spec.(js|mjs|cjs|ts|...)` files with zero deleted lines, regular modes,
 * no setup/config/helper-like names, and no added skip/only/todo markers.
 * @returns {{ok: true, from: string, to: string} | {ok: false, reason: string}}
 */
export function testOnlyAdditiveDelta(repo, from, to, { exec = execFileSync } = {}) {
  const no = (reason) => ({ ok: false, reason });
  try {
    if (typeof repo !== 'string' || !repo || !FULL_SHA.test(String(from)) || !FULL_SHA.test(String(to)) || from === to) return no('bad-shas');
    const run = (args) => Buffer.from(exec('git', ['-C', repo, ...args], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) ?? '').toString('utf8');
    try { run(['merge-base', '--is-ancestor', from, to]); } catch { return no('not-ancestor'); }
    const flags = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--no-renames'];
    const raw = run(['diff', '--raw', '-z', '--no-abbrev', ...flags, '--end-of-options', from, to]).split('\0');
    if (raw.pop() !== '') return no('unreadable-diff');
    if (!raw.length) return no('empty-delta');
    const paths = [];
    for (let i = 0; i < raw.length; i += 2) {
      const m = /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([AM])$/.exec(raw[i]);
      const path = raw[i + 1];
      if (!m || typeof path !== 'string' || !path) return no('unexpected-entry');
      if (m[2] !== '100644' || (m[3] === 'M' && m[1] !== '100644')) return no('non-regular-mode');
      if (!TEST_FILE.test(path) || SETUP_OR_CONFIG.test(path.slice(path.lastIndexOf('/') + 1))
        || path.split('/').some(s => !s || s === '.' || s === '..')) return no(`non-test-path:${path}`);
      paths.push(path);
    }
    const stat = run(['diff', '--numstat', '-z', ...flags, '--end-of-options', from, to]).split('\0');
    if (stat.pop() !== '' || stat.length !== paths.length) return no('unreadable-numstat');
    for (const line of stat) {
      const m = /^(\d+)\t(\d+)\t(.+)$/.exec(line);
      if (!m || m[2] !== '0' || !paths.includes(m[3])) return no('deleted-or-binary');
    }
    const patch = run(['diff', '-U0', ...flags, '--end-of-options', from, to]);
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && WEAKENING_ADDED.test(line)) return no('weakening-marker-added');
    }
    return { ok: true, from, to };
  } catch { return no('git-failure'); }
}
