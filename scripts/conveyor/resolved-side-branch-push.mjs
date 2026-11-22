/** Saved repairs never bypass the normal hook or verification admission paths. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { resolveRealGhBinary } from '../lib/gh-app-shim.mjs';
import { ownerInstallationToken } from './missing-run-push.mjs';
import { pushRefusal, acquireFixClaim, releaseFixClaim, isClaimHolder, repoKeyOf } from './fix-procedure.mjs';
import { acquireFixDispatchClaim, releaseFixDispatchClaim } from './fix-dispatch-claim.mjs';
import { listFixDispatchClaims, fixDispatchClaimRoot } from './fix-claim-store.mjs';
import { cascadePolicy, readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { readDeclaredSettings } from '../lib/settings-files.mjs';
import { resolveFixPushPolicy } from '../lib/fix-push-policy.mjs';
import { fixPushGate } from '../lib/review-timing.mjs';
import { resolveTimingPolicy } from '../lib/review-timing-settings.mjs';
import { defaultPoolRoot } from '../lib/lane-pool-paths.mjs';
import { readRequiredStatusChecksDetailed } from '../lib/required-status-checks.mjs';
import { readReviewChecks } from '../lib/review-ci-gate-io.mjs';
import { defaultReverifyIo, reverifyConfig, legacyLoadQuiet } from './load-flake-reverify.mjs';
import { markFixPushAwaitingCi, filesToNumstat } from './fix-push-ci.mjs';
import { ghRepoSlug } from '../lib/constellation-repos.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { standDownComments, buildStandDownComment, emitFixQuestion } from './stand-down.mjs';
import { isLegacyLoadFlakeHoldSuperseded, loadFlakeHolds } from './load-flake-hold.mjs';
import { findResolvedSideBranch, resolvedSideBranchEvidenceReadable, resolvedBranchName, FULL_SHA,
  MAX_RESOLVED_BRANCHES, MAX_RESOLVED_ANCESTORS, laneHeadRef, resolvedPushBody, isResolvedRepairAuthor } from './resolved-side-branch.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const APP_GITHUB_CREDENTIAL = 'credential.https://github.com.helper=!f() { echo username=x-access-token; printf "password=%s\\n" "$WE_RESOLVED_PUSH_TOKEN"; }; f';
const FALLBACK = 'operator inspection required; use the normal guarded await-verify/load-flake push path';
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


/** Conservative admission: saved refs carry no live verify waiter, so never early-push one.
 * A load-flake record belongs to its retry-limited worker, even if a later marker looks green. */
export function resolvedPushAdmission({ pr, candidate, policy, verification, previousCi, timing, now } = {}) {
  if (!policy || policy.invalid?.length || typeof policy.pushBeforeGate !== 'boolean') return false;
  if (loadFlakeHolds(pr?.comments).length) return false;
  if (verification?.sha !== candidate?.sha || verification?.status !== 'green') return false;
  if (!previousCi || previousCi.head !== pr.headRefOid || !Array.isArray(previousCi.checks)
    || !Array.isArray(previousCi.required) || !previousCi.required.length || !timing
    || typeof timing.pushAfterCi !== 'boolean') return false;
  return fixPushGate({ previousHeadChecks: previousCi.checks, requiredChecks: previousCi.required,
    firstHeldAt: previousCi.firstHeldAt, now, policy: timing }).action === 'push';
}

/** Questions are written for the new head before it can become visible. No acceptance is copied. */
export function resolvedProtectionBodies(pr, candidate) {
  if (!Array.isArray(pr.comments)) throw Error('unreadable questions');
  const questions = pr.comments.filter((c, i) => standDownComments([c], { lapseOnNewHead: 'off' }).length
    && !isLegacyLoadFlakeHoldSuperseded(pr.comments, i));
  return [resolvedPushBody({ head: pr.headRefOid, sha: candidate.sha, branch: candidate.name }),
    ...questions.map(c => {
      // Bind the existing question itself, preserving reason and finding/run subjects.
      const body = c.body.replace(/<!-- stand-down reason=([a-z-]+)(?: head=[a-f0-9]{7,40})?/, (_all, reason) =>
        `<!-- stand-down reason=${reason} head=${candidate.sha}`);
      if (!body.includes(`head=${candidate.sha}`)) throw Error('unbound legacy question; operator must re-emit it');
      return body;
    })];
}

const refusalMarker = candidate => `<!-- resolved-side-branch-refused sha=${candidate.sha} -->`;
const hasUnansweredRefusal = (pr, candidate) => pr.comments.some((c, i) => c.body?.includes(refusalMarker(candidate))
  && standDownComments([c], { headRefOid: pr.headRefOid, lapseOnNewHead: 'off' }).length
  && !isLegacyLoadFlakeHoldSuperseded(pr.comments, i));

/** A PR cursor is a number, matching the existing daemon cursor persistence. Skipped PRs are not refusals. */
export async function runResolvedSideBranchPass({ repo, maxPrs = 8, cursor, deadlineAt = Infinity,
  now = Date.now, shouldYield } = {}, io = defaultResolvedSideBranchIo()) {
  if (!Number.isSafeInteger(maxPrs) || maxPrs < 0 || maxPrs > 8) throw Error(`invalid scan bound; ${FALLBACK}`);
  const rows = [], prs = (await io.listPrs(repo)).filter(p => p.state === 'OPEN' && p.isCrossRepository === false);
  const start = prs.findIndex(p => p.number === cursor);
  const ordered = start > 0 ? [...prs.slice(start), ...prs.slice(0, start)] : prs;
  let handled = 0;
  for (let index = 0; index < ordered.length; index++) {
    const pr = { ...ordered[index] };
    if (handled >= maxPrs || now() >= deadlineAt || shouldYield?.()) {
      return Object.assign(rows, { handled, deferred: ordered.slice(index).map(p => p.number),
        nextCursor: pr.number, yieldedForAdoption: !!shouldYield?.(), deadlineSkipped: now() >= deadlineAt });
    }
    handled++;
    let claim, pushed = false, candidate;
    const same = live => live?.state === 'OPEN' && live.isCrossRepository === false
      && live.headRefOid === pr.headRefOid && live.headRefName === pr.headRefName
      && live.baseRefOid === pr.baseRefOid && live.baseRefName === pr.baseRefName;
    try {
      if (!laneHeadRef(pr.headRefName)) throw Error('destination must be a lane');
      if (!Array.isArray(pr.comments)) {
        const full = await io.readPr(repo, pr.number);
        if (!same(full) || !Array.isArray(full.comments)) throw Error('unreadable PR/comments');
        pr.comments = full.comments;
      }
      const branches = await io.readBranches(pr, repo);
      if (!resolvedSideBranchEvidenceReadable({ pr, branches })) throw Error('unreadable repair evidence');
      candidate = findResolvedSideBranch({ pr, branches });
      if (!candidate) continue;
      claim = await io.acquireClaim({ repo, pr });
      if (claim?.ok !== true) throw Error('claim unavailable');
      if (await io.checkClaim({ repo, pr, claim }) !== true) throw Error('claim unreadable or lost');
      const live = await io.readPr(repo, pr.number);
      if (!same(live)) throw Error('head/base moved before preparation');
      const freshBranches = await io.readBranches(live, repo);
      if (findResolvedSideBranch({ pr: live, branches: freshBranches })?.sha !== candidate.sha) throw Error('repair record changed');
      const token = await io.appToken(repo);
      if (typeof token !== 'string' || !/^ghs_[\w]+(?![\s\S])/.test(token)) throw Error('App token unavailable');
      // Preparation includes normal verification in a leased lane BEFORE the final PR read.
      const prepared = await io.preparePush({ repo, pr: live, candidate, token, claim });
      try {
        if (await io.admitPush({ repo, pr: live, candidate, verification: prepared.verification }) !== true) throw Error('push admission refused');
        const protectedBodies = resolvedProtectionBodies(live, candidate);
        await io.protect({ repo, pr: live, candidate, bodies: protectedBodies });
        const final = await io.readPr(repo, pr.number);
        if (!same(final)) throw Error('head/base moved after preparation');
        if (resolvedProtectionBodies(final, candidate).some(body => !protectedBodies.includes(body))) throw Error('unanswered question changed during preparation');
        if (findResolvedSideBranch({ pr: final, branches: freshBranches })?.sha !== candidate.sha) throw Error('repair authorization changed');
        if (await io.checkClaim({ repo, pr, claim }) !== true) throw Error('claim changed');
        if (await io.admitPush({ repo, pr: final, candidate, verification: prepared.verification }) !== true) throw Error('push admission changed');
        await prepared.push({ expectedHead: pr.headRefOid });
        pushed = true;
        const after = await io.readPr(repo, pr.number);
        if (!same({ ...after, headRefOid: pr.headRefOid }) || after.headRefOid !== candidate.sha) throw Error('head/base moved after push');
        await io.record({ repo, pr: pr.number, head: pr.headRefOid, sha: candidate.sha, branch: candidate.name });
      } finally { await prepared.close?.(); }
      rows.push({ pr: pr.number, result: 'pushed', sha: candidate.sha, branch: candidate.name });
    } catch (error) {
      rows.push({ pr: pr.number, result: pushed ? 'pushed-unrecorded' : 'refused',
        ...(pushed ? { sha: candidate.sha, branch: candidate.name } : {}), why: FALLBACK });
      io.log(`push-resolved-side-branch: PR #${pr.number} ${pushed ? 'pushed-unrecorded' : 'refused'} — ${FALLBACK}`);
      if (!pushed && candidate && claim?.ok && io.escalate) {
        try { await io.escalate({ repo, pr, candidate, reason: error?.code ?? 'admission-unreadable' }); }
        catch { io.log(`push-resolved-side-branch: PR #${pr.number} question publication failed — ${FALLBACK}`); }
      }
    } finally {
      if (claim?.ok) {
        try { await io.releaseClaim({ repo, pr, claim }); }
        catch { io.log(`push-resolved-side-branch: PR #${pr.number} claim release failed — ${FALLBACK}`); }
      }
    }
  }
  return Object.assign(rows, { handled, deferred: [] });
}

/** Take the same fixing lease as fix-begin, plus BOTH dispatch leases. A race at any step unwinds our leases. */
export function acquireResolvedPushClaim({ repo, pr, lockRoot = fixDispatchClaimRoot() }) {
  const key = repoKeyOf(repo), who = `saved-repair-${randomUUID()}`, owner = who;
  listFixDispatchClaims(lockRoot, { strict: true });
  const fixing = acquireFixClaim({ repo: key, pr: pr.number, branch: pr.headRefName, headSha: pr.headRefOid, who, lockRoot });
  if (!fixing.ok) return fixing;
  const claims = [], claim = { ok: true, key, who, owner, token: fixing.token, claims, lockRoot };
  try {
    for (const kind of ['fix', 'ci-heal']) {
      const held = acquireFixDispatchClaim({ repo: key, pr: pr.number, kind, owner, headSha: pr.headRefOid, lockRoot });
      if (!held.ok) throw Error('dispatch claim held');
      claims.push(kind);
    }
    return claim;
  } catch (error) { releaseResolvedPushClaim({ pr, claim }); throw error; }
}
export function releaseResolvedPushClaim({ pr, claim }) {
  for (const kind of claim.claims) releaseFixDispatchClaim({ repo: claim.key, pr: pr.number, kind, owner: claim.owner, lockRoot: claim.lockRoot });
  return releaseFixClaim({ repo: claim.key, pr: pr.number, who: claim.who, token: claim.token, lockRoot: claim.lockRoot });
}
export function checkResolvedPushClaim({ repo, pr, claim }) {
  const entries = listFixDispatchClaims(claim.lockRoot, { strict: true, liveOnly: true });
  const owned = kind => entries.some(e => e.meta.repo === claim.key && e.meta.pr === pr.number && e.meta.kind === kind && e.meta.headSha === pr.headRefOid
    && (kind === 'fixing' ? isClaimHolder(e, { who: claim.who, token: claim.token }) : e.owner === claim.owner));
  return ['fixing', 'fix', 'ci-heal'].every(owned)
    && pushRefusal({ repo, branch: pr.headRefName, who: claim.who, token: claim.token, strict: true, lockRoot: claim.lockRoot }) === null;
}

/** All API reads use a real executable from a fixed system search path, one shared call budget, App-only auth. */
export function defaultResolvedSideBranchIo({ exec = execFileSyncThrottled, env = process.env,
  tokenForRepo = repo => ownerInstallationToken(repo, { env }), log = line => console.error(line),
  record = row => appendDaemonEvent({ kind: 'resolved-side-branch-pushed', repo: row.repo, pr: row.pr, detail: row }),
  maxCalls = 128, ghBin = resolveRealGhBinary({ pathEnv: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }),
  reverifyIo, questionEvent = emitFixQuestion,
  markPush = markFixPushAwaitingCi,
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
  // Shared readers get complete, bounded pages; each actual page spends the SAME tick budget.
  const readPaged = repo => args => {
    const endpoint = args.at(-1);
    if (!args.includes('--paginate')) return JSON.stringify(gh(repo, ['api', '--hostname', 'github.com', endpoint]));
    const pages = [];
    for (let page = 1; page <= 8; page++) {
      const url = new URL(`https://github.com/${endpoint}`);
      url.searchParams.set('per_page', '100'); url.searchParams.set('page', String(page));
      const row = gh(repo, ['api', '--hostname', 'github.com', `${url.pathname.slice(1)}${url.search}`]);
      const entries = Array.isArray(row) ? row : row?.check_runs ?? row?.statuses;
      if (!Array.isArray(entries)) throw Error('CI page unreadable');
      pages.push(row);
      if (entries.length < 100) return JSON.stringify(pages);
    }
    throw Error(`CI pagination incomplete; ${FALLBACK}`);
  };
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
        GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', WE_RESOLVED_PUSH_TOKEN: token };
      const git = (...args) => String(exec('/usr/bin/git', ['-c', 'core.commitGraph=false', '-c', 'credential.helper=', '-c', 'http.extraHeader=',
        '-c', APP_GITHUB_CREDENTIAL,
        ...args], { cwd: scratch, env: clean, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).trim();
      git('init', '--bare', '.');
      return use(git, scratch, `https://github.com/${repo}.git`);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  };
  return {
    log, record: row => {
      // The ordinary post-push CI/size handoff uses the same App and API budget.
      markPush({ repo: row.repo, pr: row.pr, head: row.sha }, {
        run: (_bin, args) => gh(row.repo, args, false),
        readRequired: () => readRequiredStatusChecksDetailed({ repo: row.repo, gh: readPaged(row.repo), readOnly: true }).checks,
        readNumstat: ({ expectedFiles }) => {
          const files = JSON.parse(readPaged(row.repo)(['api', '--paginate', '--slurp', `repos/${row.repo}/pulls/${row.pr}/files`])).flat();
          if (!Number.isSafeInteger(expectedFiles) || files.length !== expectedFiles) throw Error('incomplete PR files');
          return filesToNumstat(files.map(f => JSON.stringify({ ...f, hasPatch: f.patch != null })).join('\n') + (files.length ? '\n' : ''));
        },
      });
      return record(row);
    }, appToken: tokenForRepo,
    acquireClaim: acquireResolvedPushClaim, releaseClaim: releaseResolvedPushClaim, checkClaim: checkResolvedPushClaim,
    admitPush: ({ repo, pr, candidate, verification }) => {
      const tool = readDeclaredSettings(), platform = readPlatformPreferences({ env });
      if (tool.errors.length || platform.errors.length) throw Error('push policy unreadable');
      const policy = resolveFixPushPolicy({ tool: tool.settings.fix, platform: platform.prefs.fix, env });
      log(`fix-push-policy: pushBeforeGate=${policy.pushBeforeGate} (source: ${policy.source})`);
      if (verification?.sha !== candidate.sha || verification.status !== 'green') return false;
      const timing = resolveTimingPolicy({ env, fix: tool.settings.fix, platformFix: platform.prefs.fix, log }).fix;
      const run = readPaged(repo);
      const required = readRequiredStatusChecksDetailed({ repo, branch: pr.baseRefName, gh: run, readOnly: true }).checks;
      const checks = readReviewChecks({ repo, headSha: pr.headRefOid, run });
      if (checks.rowsComplete !== true || checks.rowsHead !== pr.headRefOid) return false;
      return resolvedPushAdmission({ pr, candidate, policy, verification, timing,
        previousCi: { head: pr.headRefOid, checks, required }, now: Date.now() });
    },
    preparePush: async ({ repo, pr, candidate, token }) => {
      if (!/^[\w.-]+\/[\w.-]+(?![\s\S])/.test(repo ?? '') || !/^ghs_[\w]+(?![\s\S])/.test(token ?? '')) throw Error('App target unavailable');
      if (loadFlakeHolds(pr.comments).length) throw Error('saved load-flake retry belongs to capped worker');
      if (hasUnansweredRefusal(pr, candidate)) throw Error('saved repair awaits operator');
      const config = reverifyConfig(env);
      const scratch = mkdtempSync(join(tmpdir(), 'we-resolved-lane-'));
      // Hooks get App credentials only. Verification uses defaultReverifyIo's separate scrubbed env.
      const clean = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: scratch, TMPDIR: tmpdir(),
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
        GH_HOST: 'github.com', GH_TOKEN: token, GITHUB_TOKEN: token, GH_PROMPT_DISABLED: '1',
        GH_CONFIG_DIR: '/dev/null', LANE_POOL_ROOT: defaultPoolRoot(ROOT, env),
        WE_RESOLVED_PUSH_TOKEN: token, WE_SAVED_PUSH_REPO: repo };
      const run = (bin, args, opts) => exec(bin === 'git' ? '/usr/bin/git' : bin, bin === 'git' ? [
        '-c', 'credential.helper=', '-c', 'http.extraHeader=', '-c',
        APP_GITHUB_CREDENTIAL, ...args,
      ] : args, { ...opts, env: { ...clean, ...opts.env } });
      let lane;
      const io = reverifyIo ?? defaultReverifyIo({ run, env, normalPush: true, verifyEnvAllow: config.verifyEnvAllow });
      const close = async () => {
        try { if (lane) await io.release(lane); }
        finally { rmSync(scratch, { recursive: true, force: true }); }
      };
      try {
        const load = io.loadavg(), cores = io.cpuCount();
        const decision = await io.admission({ load, cores, config });
        if (decision ? decision.verdict !== 'admit' : !legacyLoadQuiet(load, cores, config)) {
          throw Object.assign(Error('host load deferred'), { code: 'host-load' });
        }
        await io.prepare(repo, candidate.name, pr.headRefName);
        lane = await io.acquire(candidate.sha, pr.number);
        if (await io.head(lane.path) !== candidate.sha || await io.resolveSha(candidate.sha, lane.path) !== candidate.sha) throw Error('lane head mismatch');
        const verified = await io.verify(lane.path);
        if (verified?.ok !== true) throw Object.assign(Error('normal verify red or unreadable'), { code: 'verify-not-green' });
        if (await io.head(lane.path) !== candidate.sha) throw Error('lane head moved during verify');
        return { verification: { sha: candidate.sha, status: 'green' }, close,
          push: async ({ expectedHead }) => {
            if (await io.head(lane.path) !== candidate.sha) throw Error('lane head moved after verify');
            return io.push(lane.path, candidate.sha, pr.headRefName, { expectedHead, env: clean });
          } };
      } catch (error) { await close(); throw error; }
    },
    escalate: async ({ repo, pr, candidate, reason }) => {
      const live = { ...view(api(repo, `pulls/${pr.number}`)), comments: comments(repo, pr.number) };
      if (live.state !== 'OPEN' || live.headRefOid !== pr.headRefOid || live.baseRefOid !== pr.baseRefOid) return;
      const marker = refusalMarker(candidate);
      if (hasUnansweredRefusal(live, candidate)) return;
      const body = buildStandDownComment({ head: pr.headRefOid, reason: 'needs-judgment',
        detail: `Saved repair could not pass normal lane verification/push admission (${['host-load', 'verify-not-green'].includes(reason) ? reason : 'guard refused or evidence unreadable'}). Operator inspection required. ${marker}` });
      const written = gh(repo, ['api', '--hostname', 'github.com', '--method', 'POST', `repos/${repo}/issues/${pr.number}/comments`, '-f', `body=${body}`]);
      if (!written.id || written.body !== body || !isResolvedRepairAuthor(written)) throw Error('question publication unverified');
      await questionEvent({ repo, pr: pr.number, head: pr.headRefOid });
    },
    protect: ({ repo, pr, bodies }) => {
      for (const body of bodies) {
        const written = gh(repo, ['api', '--hostname', 'github.com', '--method', 'POST', `repos/${repo}/issues/${pr.number}/comments`, '-f', `body=${body}`]);
        if (!isResolvedRepairAuthor(written) || written.body !== body || !written.id) throw Error('protection publication unverified');
        if (!comments(repo, pr.number).some(c => c.node_id === written.node_id && c.body === body && isResolvedRepairAuthor(c))) throw Error('protection readback failed');
      }
    },
    listPrs: repo => {
      const rows = api(repo, 'pulls?state=open&per_page=100');
      if (!Array.isArray(rows) || rows.length >= 100) throw Error(`PR inventory incomplete; ${FALLBACK}`);
      return rows.map(view);
    },
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
      scanned.set(pr.number, { ...pr, comments: live.comments, baseRefOid: live.baseRefOid,
        resolvedSideBranches: io.readBranches(live, repo) });
    } catch { scanned.set(pr.number, { ...pr, resolvedSideBranches: null }); }
  }
  if (selected.length && prs.length > selected.length) cursors.set(repo, prs[(start + selected.length) % prs.length].number);
  else cursors.delete(repo);
  return prs.map(pr => {
    const { resolvedSideBranches: _staleEvidence, ...unscanned } = pr;
    return scanned.get(pr.number) ?? unscanned;
  });
}
