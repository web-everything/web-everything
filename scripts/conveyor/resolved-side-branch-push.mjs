/** Saved conflict repair: push first; the existing gate/review machinery judges the new head.
 * No gate mutation, verification success marker, re-arm, or human-clearance carry is written here.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { ownerInstallationToken } from './missing-run-push.mjs';
import { pushRefusal } from './fix-procedure.mjs';
import { cascadePolicy, readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { readDeclaredSettings } from '../lib/settings-files.mjs';
import { ghRepoSlug } from '../lib/constellation-repos.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';
import { findResolvedSideBranch, resolvedSideBranchEvidenceReadable, resolvedBranchName, FULL_SHA, MAX_RESOLVED_BRANCHES, MAX_RESOLVED_ANCESTORS } from './resolved-side-branch.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const FALLBACK = 'operator inspection required; saved repair held, no fixer launch';
const safeRef = ref => typeof ref === 'string' && /^[\w./-]+(?![\s\S])/.test(ref)
  && !/\.\.|\/\/|\.lock(?:\/|$)|\/$/.test(ref) && !ref.startsWith('-');
export function resolveResolvedSideBranchSetting({ env = process.env, platform, tool, log } = {}) {
  if (tool === undefined) {
    const read = readDeclaredSettings();
    if (read.errors.length) return { value: false, source: 'unreadable tool (operator inspection required)' };
    tool = read.settings.fix;
  }
  if (platform === undefined) {
    const read = readPlatformPreferences({ env });
    if (read.errors.length) return { value: false, source: 'unreadable platform (operator inspection required)' };
    platform = read.prefs.fix;
  }
  const only = layer => layer?.pushResolvedSideBranch === undefined ? {} : { pushResolvedSideBranch: layer.pushResolvedSideBranch };
  const raw = env.WE_FIX_PUSH_RESOLVED_SIDE_BRANCH;
  const r = cascadePolicy('fix', only(tool), { standard: { pushResolvedSideBranch: true }, platform: only(platform), env,
    envValues: { pushResolvedSideBranch: raw === undefined ? undefined : raw === 'on' ? true : raw === 'off' ? false : raw },
    valid: { pushResolvedSideBranch: v => typeof v === 'boolean' }, log });
  return r.invalid.some(key => key.includes('pushResolvedSideBranch'))
    ? { value: false, source: 'invalid (operator inspection required)' }
    : { value: r.value.pushResolvedSideBranch, source: r.sources.pushResolvedSideBranch };
}

/** At most eight PR effects per tick; exceeding the bound leaves dispatch held for operator inspection.
 * Dedupe is observational only, after push + readback. A crash needs no recovery marker: the new head is
 * no longer a STRICT ancestor of the saved tip, so a retry cannot push it again.
 */
export async function runResolvedSideBranchPass({ repo, maxPrs = 8 } = {}, io = defaultResolvedSideBranchIo()) {
  const rows = [];
  if (!Number.isSafeInteger(maxPrs) || maxPrs < 0 || maxPrs > 8) throw Error(`invalid scan bound; ${FALLBACK}`);
  let attempted = 0;
  for (const pr of await io.listPrs(repo)) {
    if (pr.state !== 'OPEN' || pr.isCrossRepository !== false) continue;
    try {
      if (attempted++ >= maxPrs) { rows.push({ pr: pr.number, result: 'refused', why: `PR scan bound; ${FALLBACK}` }); continue; }
      const branches = await io.readBranches(pr, repo);
      const candidate = findResolvedSideBranch({ pr, branches });
      if (!resolvedSideBranchEvidenceReadable({ pr, branches })) throw Error('branch evidence unavailable, ambiguous or oversized');
      if (!candidate) continue;
      const same = live => live?.state === 'OPEN' && live.isCrossRepository === false
        && live.headRefOid === pr.headRefOid && live.headRefName === pr.headRefName
        && live.baseRefOid === pr.baseRefOid && live.baseRefName === pr.baseRefName;
      if (!same(await io.readPr(repo, pr.number))) throw Error('head/base moved before preparation');
      const token = await io.appToken(repo);
      if (typeof token !== 'string' || !/^ghs_[\w]+(?![\s\S])/.test(token)) throw Error('App installation token required');
      // Undefined is not an empty claim. Re-check after all preparation, immediately before the write.
      if (!same(await io.readPr(repo, pr.number))) throw Error('head/base moved before push');
      if (await io.pushRefusal({ repo, branch: pr.headRefName }) !== null) throw Error('fix claim held or unreadable');
      await io.push({ repo, sha: candidate.sha, branch: pr.headRefName, head: pr.headRefOid, token });
      const after = await io.readPr(repo, pr.number);
      if (!same({ ...after, headRefOid: pr.headRefOid }) || after.headRefOid !== candidate.sha) throw Error('head/base moved after push');
      await io.record({ repo, pr: pr.number, head: pr.headRefOid, sha: candidate.sha, branch: candidate.name });
      io.log(`push-resolved-side-branch: PR #${pr.number} ${candidate.name} ${candidate.sha} pushed (no fixer launch)`);
      rows.push({ pr: pr.number, result: 'pushed', sha: candidate.sha, branch: candidate.name });
    } catch {
      // Child failures can contain credentials/remote text; only a fixed operator fallback is published.
      rows.push({ pr: pr.number, result: 'refused', why: FALLBACK });
      io.log(`push-resolved-side-branch: PR #${pr.number} refused — ${FALLBACK}`);
    }
  }
  return rows;
}

/** Injectable, bounded transport. All git runs in a fresh bare repo, never in fixer-authored config.
 * Use only a fresh owner-bound App cache token. No gh auth token, env PAT, stored helper or personal fallback.
 */
export function defaultResolvedSideBranchIo({ exec = execFileSyncThrottled, env = process.env,
  tokenForRepo = repo => ownerInstallationToken(repo, { env }), checkClaim = pushRefusal, log = line => console.error(line),
  record = row => appendDaemonEvent({ kind: 'resolved-side-branch-pushed', repo: row.repo, pr: row.pr, detail: row }),
} = {}) {
  const api = (repo, endpoint) => {
    const token = tokenForRepo(repo);
    if (!token?.startsWith('ghs_')) throw Error('App token unavailable');
    return JSON.parse(exec('gh', ['api', `repos/${repo}/${endpoint}`], {
      cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
      env: { ...env, GH_TOKEN: token, GITHUB_TOKEN: token },
    }));
  };
  const view = p => ({ number: p.number, state: p.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefOid: p.head?.sha, headRefName: p.head?.ref, baseRefOid: p.base?.sha,
    baseRefName: p.base?.ref, isCrossRepository: p.head?.repo?.full_name !== p.base?.repo?.full_name });
  const transport = (repo, token, use) => {
    if (!/^[\w.-]+\/[\w.-]+(?![\s\S])/.test(repo ?? '') || !/^ghs_[\w]+(?![\s\S])/.test(token ?? '')) throw Error('invalid App target');
    const scratch = mkdtempSync(join(tmpdir(), 'we-resolved-branch-'));
    try {
      // An allowlist drops GIT_DIR/WORK_TREE, indexed config, tracing, proxies and hostile PATH.
      const clean = { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: tmpdir(),
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', WE_RESOLVED_PUSH_TOKEN: token };
      const git = (...args) => String(exec('/usr/bin/git', ['-c', 'core.commitGraph=false', '-c', 'core.hooksPath=hooks',
        '-c', 'credential.helper=', '-c', 'http.extraHeader=',
        '-c', 'credential.helper=!f() { echo username=x-access-token; printf "password=%s\\n" "$WE_RESOLVED_PUSH_TOKEN"; }; f',
        ...args], { cwd: scratch, env: clean, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).trim();
      git('init', '--bare', '.');
      return use(git, scratch, `https://github.com/${repo}.git`);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  };
  return {
    log, record, appToken: tokenForRepo, pushRefusal: checkClaim,
    listPrs: repo => {
      const rows = api(repo, 'pulls?state=open&per_page=100');
      if (!Array.isArray(rows) || rows.length >= 100) throw Error(`PR inventory incomplete; ${FALLBACK}`);
      return rows.map(view);
    },
    readPr: (repo, pr) => view(api(repo, `pulls/${pr}`)),
    readBranches: (pr, repo) => transport(repo, tokenForRepo(repo), (git, _scratch, remote) => {
      if (!safeRef(pr.baseRefName) || !safeRef(pr.headRefName) || !FULL_SHA.test(pr.headRefOid ?? '') || !FULL_SHA.test(pr.baseRefOid ?? '')) throw Error('unpinned PR');
      const refs = git('ls-remote', '--heads', remote, `refs/heads/lane/*-fix-${pr.number}-*`).split('\n').filter(Boolean)
        .map(line => { const [sha, ref] = line.split(/\s+/); return { sha, name: ref?.replace(/^refs\/heads\//, '') }; });
      if (refs.length > MAX_RESOLVED_BRANCHES || refs.some(b => !resolvedBranchName(b.name, pr.number) || !FULL_SHA.test(b.sha))) throw Error('ambiguous/oversized refs');
      if (!refs.length) return [];
      const fetch = (ref, sha) => {
        git('fetch', '--no-tags', '--no-write-fetch-head', remote, `${ref}:refs/probe/${sha}`);
        if (git('rev-parse', `refs/probe/${sha}^{commit}`) !== sha) throw Error('fetched ref moved');
      };
      fetch(`refs/heads/${pr.baseRefName}`, pr.baseRefOid);
      fetch(`refs/heads/${pr.headRefName}`, pr.headRefOid);
      return refs.map(b => {
        fetch(`refs/heads/${b.name}`, b.sha);
        const ancestors = git('rev-list', `--max-count=${MAX_RESOLVED_ANCESTORS + 1}`, b.sha).split('\n');
        if (ancestors.length > MAX_RESOLVED_ANCESTORS) throw Error('ancestry bound');
        return { ...b, ancestors };
      });
    }),
    push: ({ repo, sha, branch, head, token }) => transport(repo, token, (git, scratch, remote) => {
      if (!safeRef(branch) || !FULL_SHA.test(sha) || !FULL_SHA.test(head) || sha === head) throw Error('unpinned push');
      git('fetch', '--no-tags', remote, sha, head);
      if (git('rev-parse', `${sha}^{commit}`) !== sha || git('rev-parse', `${head}^{commit}`) !== head) throw Error('missing exact commits');
      git('merge-base', '--is-ancestor', head, sha);
      // Plain push's server CAS uses the advertised old oid. This trusted pre-push hook pins THAT oid
      // too, closing the read-to-advertisement race without force or force-with-lease.
      mkdirSync(join(scratch, 'hooks'), { recursive: true });
      writeFileSync(join(scratch, 'hooks/pre-push'), `#!/bin/sh\nread local_ref local_oid remote_ref remote_oid || exit 1\n[ "$local_oid" = "${sha}" ] && [ "$remote_oid" = "${head}" ] && [ "$remote_ref" = "refs/heads/${branch}" ] || exit 1\nif read extra; then exit 1; fi\nexit 0\n`, { mode: 0o700 });
      if (checkClaim({ repo, branch }) !== null) throw Error('fix claim appeared during preparation');
      git('push', remote, `${sha}:refs/heads/${branch}`);
    }),
  };
}

/** Planner enrichment: a failed scan holds the PR; it never means "nothing owed".
 * The push pass and planner share this evidence format, but neither trusts the other's previous read.
 */
export function enrichResolvedSideBranches(prs, { repo, io = defaultResolvedSideBranchIo() } = {}) {
  repo = ghRepoSlug(repo ?? 'we');
  let scanned = 0;
  return prs.map(pr => {
    try {
      // Read exact current base/head from the API; old snapshot heads cannot acquire new evidence.
      const live = io.readPr(repo, pr.number);
      if (live.headRefOid !== pr.headRefOid || scanned++ >= 8) throw Error('head moved or scan bound');
      return { ...pr, baseRefOid: live.baseRefOid, resolvedSideBranches: io.readBranches(live, repo) };
    } catch { return { ...pr, resolvedSideBranches: null }; }
  });
}
