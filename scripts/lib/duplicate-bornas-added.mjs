/**
 * @file scripts/lib/duplicate-bornas-added.mjs
 * @description xsjn0uf-incident — warn when a PR ADDS a backlog card whose `bornAs` hash already exists
 * on main (as a numbered card) or in another open PR (as a hash-named card). The same card file landing
 * twice makes the drain mint two numbers for one identity and turns main's health gate red for every PR
 * (#5319/#5321). The drain now refuses to mint (lane-drain.mjs `numberPendingHashes`); this is the earlier,
 * author-side signal. ADVISORY ONLY and fail-soft: any git/gh failure yields no warnings, never a throw.
 *
 * Pure decider `duplicateBornAsWarnings` + a thin `checkDuplicateBornAs` that gathers the facts through an
 * injected `exec(cmd, args) => stdout`.
 */

import { ghRepoSlug } from './constellation-repos.mjs';

const HASH = /^x[0-9a-z]{6}$/;
const stemOf = (path) => String(path).split('/').pop().replace(/\.md$/, '');
const hashOfStem = (stem) => stem.split('-')[0];

/**
 * @param {{added: Array<{path: string, bornAs: string}>, mainBornAs: Map<string,string>, openPrFiles: Array<{pr:number, path:string}>}} facts
 * @returns {string[]} one human-readable warning per conflicting added card
 */
export function duplicateBornAsWarnings({ added, mainBornAs, openPrFiles }) {
  const out = [];
  for (const { path, bornAs } of added) {
    if (!HASH.test(bornAs || '')) continue;
    const onMain = mainBornAs.get(bornAs);
    if (onMain && onMain !== path) {
      out.push(`${path} adds bornAs ${bornAs}, which main already holds as ${onMain} — landing it would make the drain skip or hold the copy (never a second number). Drop the card from this PR.`);
    }
    const others = openPrFiles.filter((f) => f.path.startsWith('backlog/') && hashOfStem(stemOf(f.path)) === bornAs).map((f) => `#${f.pr}`);
    if (others.length) {
      out.push(`${path} adds bornAs ${bornAs}, which open ${others.length > 1 ? 'PRs' : 'PR'} ${[...new Set(others)].join(', ')} also add. Only one PR should carry the card.`);
    }
  }
  return out;
}

/** Gather the facts for a PR of `sha` against `base` and return the warnings (fail-soft: [] on any error). */
export function checkDuplicateBornAs({ exec, base = 'main', sha = 'HEAD', branch = '' }) {
  try {
    const names = exec('git', ['diff', '--name-only', '--diff-filter=A', `origin/${base}...${sha}`, '--', 'backlog/'])
      .split('\n').filter((p) => /^backlog\/.+\.md$/.test(p));
    if (!names.length) return [];
    const added = [];
    for (const path of names) {
      const text = exec('git', ['show', `${sha}:${path}`]);
      const m = text.match(/^bornAs:\s*(x[0-9a-z]{6})\s*$/m);
      if (m) added.push({ path, bornAs: m[1] });
      else if (HASH.test(hashOfStem(stemOf(path)))) added.push({ path, bornAs: hashOfStem(stemOf(path)) });
    }
    if (!added.length) return [];
    const mainBornAs = new Map();
    try {
      for (const line of exec('git', ['grep', '-E', '^bornAs: x[0-9a-z]{6}$', `origin/${base}`, '--', 'backlog/']).split('\n')) {
        const m = line.match(new RegExp(`^origin/${base}:(backlog/.*):bornAs: (x[0-9a-z]{6})$`));
        if (m && !mainBornAs.has(m[2])) mainBornAs.set(m[2], m[1]);
      }
    } catch { /* no match / no ref → nothing on main */ }
    let openPrFiles = [];
    try {
      const prs = JSON.parse(exec('gh', ['pr', 'list', '--repo', ghRepoSlug('we'), '--state', 'open', '--limit', '200', '--json', 'number,headRefName,files']));
      openPrFiles = prs.filter((p) => !branch || p.headRefName !== branch)
        .flatMap((p) => (p.files || []).map((f) => ({ pr: p.number, path: f.path })));
    } catch { /* gh unavailable → skip the open-PR half */ }
    return duplicateBornAsWarnings({ added, mainBornAs, openPrFiles });
  } catch { return []; }
}
