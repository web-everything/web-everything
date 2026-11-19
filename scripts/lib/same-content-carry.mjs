/** Local history proof for WAIVER rulings across clean automatic merges of main only. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { laneHistoryProofEnv } from './lane-git-hardening.mjs';
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
/** Bounded, local-only Git IO. Any unreadable proof requires a fresh audit/review on the current head. */
export function classifyHeadMove({ repo = process.cwd(), base = 'origin/main', from, to,
  exec = execFileSync, env = process.env, setting } = {}) {
  const commits = [];
  const refuse = reason => ({ carries: false, reason: `${reason}; re-audit/re-review the current head`, commits });
  try {
    const policy = setting === undefined ? resolveSameDiffCarry({ env }) : { value: setting };
    if (env.WE_SAME_DIFF_CARRY === 'off' || policy.value !== 'on') return refuse('sameDiffCarry is off');
    if (![base, from, to].every(v => typeof v === 'string' && REF.test(v))) return refuse('invalid ref');
    const git = args => String(exec('git', ['-C', repo, ...args], { encoding: 'utf8',
      env: laneHistoryProofEnv(env),
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
    const inMain = parent => {
      try { git(['merge-base', '--is-ancestor', parent, main]); return true; }
      catch (e) { if (e.status === 1) return false; throw e; }
    };
    for (const sha of range) {
      if (!SHA.test(sha)) return refuse('invalid range commit');
      const parents = git(['show', '-s', '--format=%P', sha]).trim().split(' ').filter(Boolean);
      let kind;
      if (parents.length === 2 && (inMain(parents[0]) || inMain(parents[1]))) {
        const tree = git(['merge-tree', '--write-tree', ...parents]).trim();
        if (!SHA.test(tree)) return refuse('unreadable automatic merge');
        const actual = git(['rev-parse', `${sha}^{tree}`]).trim();
        if (tree === actual) kind = 'clean-main-merge';
      }
      if (!kind) return refuse(`unproven commit ${sha}`);
      commits.push({ sha, kind });
    }
    return { carries: true, reason: 'same PR content proven by commit history', commits };
  } catch { return refuse('git proof failed or non-ancestor head'); }
}

/** PURE: findings must match in text, order and multiplicity. */
export function findingsEqual(findings, ruled) {
  return Array.isArray(findings) && findings.length > 0 && Array.isArray(ruled)
    && findings.length === ruled.length
    && findings.every((finding, i) => typeof finding === 'string' && finding.trim() && finding === ruled[i]);
}
