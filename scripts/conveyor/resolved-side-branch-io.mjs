/** Bounded read-only saved-ref discovery. All writes belong to the normal fixer launch. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { resolveRealGhBinary } from '../lib/gh-app-shim.mjs';
import { ownerInstallationToken } from './missing-run-push.mjs';
import { cascadePolicy, readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { readDeclaredSettings } from '../lib/settings-files.mjs';
import { ghRepoSlug } from '../lib/constellation-repos.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { resolvedSideBranchEvidenceReadable, resolvedBranchName, FULL_SHA, MAX_RESOLVED_BRANCHES, MAX_RESOLVED_ANCESTORS } from './resolved-side-branch.mjs';
const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const APP_GITHUB_CREDENTIAL = 'credential.https://github.com.helper=!f() { echo username=x-access-token; printf "password=%s\\n" "$WE_RESOLVED_DISCOVERY_TOKEN"; }; f';
const FALLBACK = 'operator inspection required; inspect saved-ref evidence before retrying';
const safeRef = ref => typeof ref === 'string' && /^[\w./-]+$/.test(ref)
  && !/\s/.test(ref) && !/\.\.|\/\/|\.lock(?:\/|$)|\/$/.test(ref) && !ref.startsWith('-');
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

export function defaultResolvedSideBranchIo({ exec = execFileSyncThrottled, env = process.env,
  tokenForRepo = repo => ownerInstallationToken(repo, { env }), maxCalls = 128,
  ghBin = resolveRealGhBinary({ pathEnv: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }),
} = {}) {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 128) throw Error(`invalid API budget; ${FALLBACK}`);
  let calls = 0;
  const gh = (repo, args, parse = true) => {
    const token = tokenForRepo(repo);
    if (typeof ghBin !== 'string' || !ghBin.startsWith('/') || !/^ghs_[\w]+(?![\s\S])/.test(token ?? '') || !/^[\w.-]+\/[\w.-]+(?![\s\S])/.test(repo ?? '')) throw Error('App API unavailable');
    if (++calls > maxCalls) throw Error(`API budget exhausted; ${FALLBACK}`);
    const clean = { PATH: '/usr/bin:/bin', GH_HOST: 'github.com', GH_TOKEN: token, GITHUB_TOKEN: token,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GH_CONFIG_DIR: '/dev/null', GH_PROMPT_DISABLED: '1' };
    const output = exec('gh', args, { cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
      env: clean, throttle: { bin: ghBin, env: clean, personalRoute: false, retries: 0 } });
    return parse ? JSON.parse(output) : output;
  };
  const api = (repo, endpoint) => gh(repo, ['api', '--hostname', 'github.com', `repos/${repo}/${endpoint}`]);
  const view = p => ({ number: p.number, state: p.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefOid: p.head?.sha, headRefName: p.head?.ref, baseRefOid: p.base?.sha,
    baseRefName: p.base?.ref, isCrossRepository: p.head?.repo?.full_name !== p.base?.repo?.full_name });
  const comments = (repo, number) => readCompletePrComments(number, { repo, gh: args => gh(repo, args) });
  const transport = (repo, token, use) => {
    if (!/^[\w.-]+\/[\w.-]+(?![\s\S])/.test(repo ?? '') || !/^ghs_[\w]+(?![\s\S])/.test(token ?? '')) throw Error('invalid App target');
    const scratch = mkdtempSync(join(tmpdir(), 'we-resolved-branch-'));
    try {
      // An allowlist drops GIT_DIR/WORK_TREE, indexed config, tracing, proxies and hostile PATH.
      const clean = { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: tmpdir(),
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', WE_RESOLVED_DISCOVERY_TOKEN: token };
      const git = (...args) => String(exec('/usr/bin/git', ['-c', 'core.commitGraph=false', '-c', 'credential.helper=', '-c', 'http.extraHeader=',
        '-c', APP_GITHUB_CREDENTIAL,
        ...args], { cwd: scratch, env: clean, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).trim();
      git('init', '--bare', '.');
      return use(git, scratch, `https://github.com/${repo}.git`);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  };
  return {
    readPr: (repo, pr) => ({ ...view(api(repo, `pulls/${pr}`)), comments: comments(repo, pr) }),
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
  };
}

const scanCursors = new Map();
/** Shared planner scan: unreadable is held, unscanned is untouched. Rotation never grants push permission. */
export function enrichResolvedSideBranches(prs, { repo, io = defaultResolvedSideBranchIo(), cursors = scanCursors, maxPrs = 8 } = {}) {
  if (!Number.isSafeInteger(maxPrs) || maxPrs < 0 || maxPrs > 8) throw Error(`invalid scan bound; ${FALLBACK}`);
  repo = ghRepoSlug(repo ?? 'we');
  const start = Math.max(0, prs.findIndex(p => p.number === cursors.get(repo)));
  const selected = [...prs.slice(start), ...prs.slice(0, start)].slice(0, maxPrs);
  const scanned = new Map();
  for (const pr of selected) {
    try {
      const live = io.readPr(repo, pr.number);
      if (live.state !== 'OPEN' || live.isCrossRepository !== false || live.headRefOid !== pr.headRefOid
        || live.headRefName !== pr.headRefName || live.baseRefName !== pr.baseRefName) throw Error('PR moved');
      const evidence = { ...pr, comments: live.comments, baseRefOid: live.baseRefOid,
        commentsComplete: true, resolvedSideBranches: io.readBranches(live, repo) };
      if (!resolvedSideBranchEvidenceReadable({ pr: evidence, branches: evidence.resolvedSideBranches }))
        throw Error(`saved-ref evidence unreadable; ${FALLBACK}`);
      scanned.set(pr.number, evidence);
    } catch { scanned.set(pr.number, { ...pr, resolvedSideBranches: null }); }
  }
  if (selected.length && prs.length > selected.length) cursors.set(repo, prs[(start + selected.length) % prs.length].number);
  else cursors.delete(repo);
  return prs.map(pr => {
    const { resolvedSideBranches: _staleEvidence, ...unscanned } = pr;
    return scanned.get(pr.number) ?? unscanned;
  });
}
