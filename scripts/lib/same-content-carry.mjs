/** One history proof for same-content waiver, acceptance and red-team carries. No diff hashing. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cascadePolicy } from './policy-cascade.mjs';

const REF = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$/;
const SHA = /^[a-f0-9]{40,64}$/;
const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), '../settings/same-diff-carry.json');
export function resolveSameDiffCarry({ env = process.env, readFile = readFileSync, platform, log } = {}) {
  let tool = 'off';
  try { tool = JSON.parse(readFile(SETTINGS, 'utf8')).sameDiffCarry; } catch { /* closed */ }
  const result = cascadePolicy('sameDiffCarry', tool, { standard: 'off', platform, env,
    envValues: { '': env.WE_SAME_DIFF_CARRY },
    valid: v => v === 'on' || v === 'off', log });
  // An explicit kill switch always wins, including with malformed lower layers.
  return { value: env.WE_SAME_DIFF_CARRY === 'off' ? 'off' : result.value, source: result.sources };
}
export const isTestPath = path => /(?:^|\/)__tests__\//.test(path)
  || /\.test\.(?:mjs|js|ts)$/.test(path) || path === 'scripts/ci/test-timings.json';

/** PURE: parse raw -z diff records, retaining both paths, modes and object identities. */
export function parseCarryChanges(raw) {
  const parts = raw.split('\0');
  if (parts.pop() !== '') throw Error('unterminated diff');
  const changes = [];
  let index = 0;
  while (index < parts.length) {
    const header = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z][0-9]*)$/.exec(parts[index++]);
    if (!header || index >= parts.length) throw Error('malformed diff');
    const [, beforeMode, afterMode, before, after, status] = header;
    const oldPath = parts[index++];
    const newPath = /^[RC]/.test(status) ? parts[index++] : oldPath;
    if (!oldPath || !newPath) throw Error('missing diff path');
    changes.push({ beforeMode, afterMode, before, after, status, oldPath, newPath });
  }
  return changes;
}
const testsOnly = changes => changes.length > 0 && changes.every(c =>
  isTestPath(c.oldPath) && isTestPath(c.newPath) && ![c.beforeMode, c.afterMode].includes('160000')
  && (c.beforeMode === c.afterMode || c.beforeMode === '000000' || c.afterMode === '000000'));
const jitOnly = changes => changes.length > 0 && changes.every(c => {
  const old = /^backlog\/[^/]+?-(.+)\.md$/.exec(c.oldPath);
  const next = /^backlog\/\d+-(.+)\.md$/.exec(c.newPath);
  return c.status === 'R100' && c.before === c.after && c.beforeMode === '100644'
    && c.afterMode === c.beforeMode && old && next && old[1] === next[1];
});

/** Bounded, local-only Git IO. Any unreadable proof requires a fresh audit/review on the current head. */
export function classifyHeadMove({ repo = process.cwd(), base = 'origin/main', from, to,
  allowTestOnly = false, exec = execFileSync, env = process.env, setting } = {}) {
  const commits = [];
  const refuse = reason => ({ carries: false, reason: `${reason}; re-audit/re-review the current head`, commits });
  try {
    const policy = setting === undefined ? resolveSameDiffCarry({ env }) : { value: setting };
    if (env.WE_SAME_DIFF_CARRY === 'off' || policy.value !== 'on') return refuse('sameDiffCarry is off');
    if (![base, from, to].every(v => typeof v === 'string' && REF.test(v))) return refuse('invalid ref');
    const git = args => String(exec('git', ['-C', repo, ...args], { encoding: 'utf8',
      env: { ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
      timeout: 10000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    const resolve = ref => {
      const sha = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
      if (!SHA.test(sha) || (/^[a-f0-9]{40,64}$/i.test(ref) && sha !== ref.toLowerCase())) throw Error('unknown or mismatched commit');
      return sha;
    };
    const start = resolve(from), end = resolve(to), main = resolve(base);
    git(['merge-base', '--is-ancestor', start, end]);
    if (start === end) return { carries: true, reason: 'same head', commits };
    const range = git(['rev-list', '--reverse', end, `^${start}`, `^${main}`]).trim().split('\n').filter(Boolean);
    if (!range.length) return refuse('empty moved-head range');
    if (range.length > 256) return refuse('history exceeds 256 commits');
    const diff = (a, b) => parseCarryChanges(git(['diff', '--raw', '-z', '--no-abbrev', '-M100%',
      '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', a, b, '--']));
    const inMain = parent => {
      try { git(['merge-base', '--is-ancestor', parent, main]); return true; }
      catch (e) { if (e.status === 1) return false; throw e; }
    };
    for (const sha of range) {
      if (!SHA.test(sha)) return refuse('invalid range commit');
      const parents = git(['show', '-s', '--format=%P', sha]).trim().split(' ').filter(Boolean);
      let kind;
      if (parents.length === 1) {
        const changes = diff(parents[0], sha);
        if (jitOnly(changes) && git(['diff', '--name-status', '-z', '-M100%', '--no-ext-diff',
          '--no-textconv', '--ignore-submodules=none', parents[0], sha, '--'])
          === changes.map(c => `R100\0${c.oldPath}\0${c.newPath}\0`).join('')) kind = 'jit-rename';
        else if (allowTestOnly && testsOnly(changes)) kind = 'test-only';
      } else if (parents.length === 2 && (inMain(parents[0]) || inMain(parents[1]))) {
        let output, clean = true;
        try { output = git(['merge-tree', '--write-tree', '--name-only', '--no-messages', ...parents]); }
        catch (e) {
          if (!allowTestOnly || e.status !== 1) throw e;
          clean = false; output = String(e.stdout || '');
        }
        const [tree, ...conflicts] = output.trim().split('\n');
        if (!SHA.test(tree)) return refuse('unreadable automatic merge');
        const actual = git(['rev-parse', `${sha}^{tree}`]).trim();
        if (clean && tree === actual) kind = 'clean-main-merge';
        else if (allowTestOnly && (clean || conflicts.length > 0 && conflicts.every(isTestPath))
          && testsOnly(diff(tree, actual))) kind = 'test-only-merge';
      }
      if (!kind) return refuse(`unproven commit ${sha}`);
      commits.push({ sha, kind });
    }
    return { carries: true, reason: 'same PR content proven by commit history', commits };
  } catch { return refuse('git proof failed or non-ancestor head'); }
}

/** PURE: strip recognized source locations, preserving numeric content such as endpoint ports.
 * Unknown filename forms retain their locations (a conservative mismatch requires a fresh ruling).
 */
export function normalizeFinding(finding) {
  return typeof finding === 'string' ? finding.replace(/(^|[\s([{"'`])((?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@.+-]+\.(?:[cm]?[jt]sx?|json|njk|md|html?|css|scss|ya?ml|toml|py|rs|go|java|cs|[ch](?:pp)?|sh)):\d+(?:-\d+)?(?::\d+)?(?=$|[\s)\]},.;"'`])/g, '$1$2')
    .replace(/\b(?:lines?\s+\d+(?:-\d+)?|L\d+(?:-L?\d+)?)\b/g, '').replace(/\s+/g, ' ').trim() : '';
}
export function findingsSubset(findings, ruled) {
  return Array.isArray(findings) && findings.length > 0 && Array.isArray(ruled) && ruled.length > 0
    && findings.every(f => normalizeFinding(f) && ruled.some(r => normalizeFinding(r) === normalizeFinding(f)));
}
