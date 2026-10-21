/** Read → plan → re-read → sanctioned mutation → verification → durable attribution. All IO injectable. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { resolveCoordinationRoot } from './coordination-root.mjs';
import { listBuildDispatchHolds, releaseBuildDispatchHold } from '../conveyor/build-dispatch-claim.mjs';
import { clearBuildFailure } from '../conveyor/build-dispatch-failures.mjs';
import { listFixDispatchClaims, readFixDispatchClaim } from '../conveyor/fix-claim-store.mjs';
import { isClaimSessionLive, releaseFixDispatchClaim } from '../conveyor/fix-dispatch-claim.mjs';
import { releaseOwnPrepareHolds } from '../../skills-src/conveyor/build-dispatch-daemon.mjs';
import { refreshOntoMain } from '../conveyor/ci-red-recovery-watch.mjs';
import { recordRefreshed, refreshedStatePath, requiredCheckFact, loadMergeQueueSettings } from '../lib/merge-queue-hook.mjs';
import { createExtendRoundsSinks, runRedTeamGateForPr } from './extend-rounds-io.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { planOperatorControl, validateControlInput, controlFingerprint, parseOperatorActions, buildOperatorActionComment, isPrepareHold, OPERATOR_CONTROL_EFFECT } from './operator-controls.mjs';

export const CONTROL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gh = args => execFileSyncThrottled('gh', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
export function createOperatorControlsReader({ root = CONTROL_ROOT, coord = resolveCoordinationRoot(), runGh = gh,
  runGit = git, readText = path => readFileSync(path, 'utf8'), pathExists = existsSync,
  readComments = (repo, pr) => readCompletePrComments(pr, { repo }),
  readHolds = () => listBuildDispatchHolds({ lockRoot: join(coord, 'build-dispatch-holds') }),
  listClaims = () => listFixDispatchClaims(join(coord, 'fix-dispatch-claims')),
  readClaim = args => readFixDispatchClaim({ ...args, lockRoot: join(coord, 'fix-dispatch-claims') }),
  readAgents = () => JSON.parse(execFileSync('claude', ['agents', '--json', '--all'], { encoding: 'utf8', timeout: 30000 })),
  readCheck = (repo, head) => {
    const settings = loadMergeQueueSettings();
    const pages = JSON.parse(runGh(['api', `repos/${repo}/commits/${head}/check-runs?check_name=${encodeURIComponent(settings.requiredCheck ?? 'test')}&per_page=100`, '--paginate', '--slurp']));
    return requiredCheckFact(pages.flatMap(p => p.check_runs ?? []), head);
  },
  now = () => new Date().toISOString(),
} = {}) {
  const readJson = (path, fallback) => pathExists(path) ? JSON.parse(readText(path)) : fallback;
  const readPr = (repo, pr) => {
    const p = JSON.parse(runGh(['pr', 'view', String(pr), '--repo', repo, '--json', 'state,labels,headRefOid,headRefName,isCrossRepository']));
    if (!p.headRefOid || !Array.isArray(p.labels) || !p.state) throw new Error('incomplete PR state');
    return { state: p.state, labels: p.labels.map(l => l.name ?? l), head: p.headRefOid, headRef: p.headRefName, crossRepo: p.isCrossRepository, comments: readComments(repo, pr) };
  };
  return (name, input) => {
    if (input.item) validateControlInput(name, input);
    const at = now();
    if (input.item) {
      const holds = readHolds().filter(h => String(h.num ?? h.meta?.num) === input.item && (h.meta?.repo ?? 'we') === 'we');
      const ledger = readJson(join(coord, name === 'unpark' ? 'build-dispatch-failures.json' : 'prepare-failures.json'), {});
      const failures = Object.values(name === 'unpark' ? ledger.items ?? {} : ledger.failures ?? {}).filter(f => String(f.num) === input.item);
      return { holds, failures, now: at };
    }
    if (name === 'clear-claim') {
      const key = repoKeyForSlug(input.repo) ?? input.repo;
      let claims;
      if (input.file) claims = listClaims().filter(c => [key, input.repo].includes(c.meta?.repo) && ['fix', 'ci-heal'].includes(c.meta?.kind) && Array.isArray(c.meta?.scope) && c.meta.scope.includes(input.file));
      else { const c = readClaim({ repo: key, pr: input.pr, kind: input.kind ?? 'fix' }); claims = c ? [c] : []; }
      if (claims.length) {
        const listing = readAgents(), agents = listing.agents ?? listing;
        if (!Array.isArray(agents)) throw new Error('claim liveness unavailable: expected agents array');
        claims = claims.map(c => ({ ...c, live: isClaimSessionLive({ repo: c.meta.repo, pr: c.meta.pr, kind: c.meta.kind, agentsAll: agents, name: c.meta.who ?? null }) }));
      }
      const comments = claims.flatMap(c => readComments(input.repo, c.meta.pr));
      return { claims, comments, now: at };
    }
    const p = readPr(input.repo, input.pr);
    if (name === 'refresh' && p.state === 'OPEN' && !p.crossRepo) {
      const checkout = input.checkout || root;
      // Read the repository's live main, not a potentially stale local tracking ref.
      p.main = String(runGh(['api', `repos/${input.repo}/commits/main`, '--jq', '.sha'])).trim();
      if (!p.main) throw new Error('remote main unavailable');
      p.requiredCheck = readCheck(input.repo, p.head);
      // Missing objects are uncertainty, never proof that the head is stale. No fetch in a preview.
      runGit(checkout, ['cat-file', '-e', `${p.head}^{commit}`]);
      try { runGit(checkout, ['cat-file', '-e', `${p.main}^{commit}`]); }
      catch (error) {
        if (![1, 128].includes(error.status)) throw error;
        if (input.preview) return { ...p, containsMain: false, now: at };
        runGit(checkout, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
        runGit(checkout, ['cat-file', '-e', `${p.main}^{commit}`]);
      }
      try { runGit(checkout, ['merge-base', '--is-ancestor', p.main, p.head]); p.containsMain = true; }
      catch (error) { if (error.status !== 1) throw error; p.containsMain = false; }
    }
    return { ...p, now: at };
  };
}

export function createOperatorControlsSinks({ root = CONTROL_ROOT, coord = resolveCoordinationRoot(),
  readContext = createOperatorControlsReader({ root, coord }), run = execFileSync, runGh = gh,
  readText = path => readFileSync(path, 'utf8'), pathExists = existsSync,
  makeDir = mkdirSync, writeText = writeFileSync, rename = renameSync, chmod = chmodSync, append = appendFileSync,
  releaseHold = releaseBuildDispatchHold, clearFailure = clearBuildFailure, releaseClaim = releaseFixDispatchClaim,
  releasePrepare = releaseOwnPrepareHolds, refresh = refreshOntoMain, rememberRefresh = recordRefreshed,
  refreshStatePath = refreshedStatePath,
  extensionSink = createExtendRoundsSinks({ readThread: (repo, pr) => readContext('grant-rounds', { repo, pr }), regate: runRedTeamGateForPr })['github.round-extension'],
  readRecords, writeRecord, mutate, verify,
} = {}) {
  const actionPath = join(coord, 'operator-actions.jsonl');
  const readItemRecords = () => pathExists(actionPath) ? readText(actionPath).split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const getRecords = readRecords ?? ((p, state) => p.input.item ? readItemRecords() : parseOperatorActions(state.comments));
  const putRecord = writeRecord ?? (async record => {
    if (record.item) {
      makeDir(coord, { recursive: true });
      // One O_APPEND write per complete JSON line: concurrent appenders cannot replace one another's records.
      append(actionPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      if (!readItemRecords().some(r => r.key === record.key)) throw new Error('operator action append verification failed');
    } else {
      runGh(['pr', 'comment', String(record.pr), '--repo', record.repo, '--body', buildOperatorActionComment(record)]);
      const state = await readContext('grant-rounds', { repo: record.repo, pr: record.pr });
      if (!parseOperatorActions(state.comments).some(r => r.key === record.key)) throw new Error('operator action comment verification failed');
    }
  });
  const child = (script, args) => {
    const out = run(process.execPath, [join(root, script), ...args], { cwd: root, encoding: 'utf8', timeout: 120000 });
    const result = JSON.parse(String(out).trim().split('\n').at(-1));
    if (result.ok !== true || result.error || result.refused) throw new Error(result.error || result.reason || `${script} did not confirm success`);
    return result;
  };
  const apply = mutate ?? (async (name, p) => {
    const i = p.input, attribution = [`--repo=${i.repo}`, `--actor=${i.actor}`, `--channel=${i.channel}`];
    if (name === 'unpark') {
      if (i.item) {
        if (p.steps.some(s => s.startsWith('releaseBuild'))) await releaseHold({ repo: 'we', num: Number(i.item), lockRoot: join(coord, 'build-dispatch-holds') });
        if (p.steps.some(s => s.startsWith('clearBuild'))) await clearFailure(Number(i.item), { path: join(coord, 'build-dispatch-failures.json') });
      } else child('scripts/review-set-label.mjs', [String(i.pr), '--to=clear-human', ...attribution, `--reason=${i.reason}`]);
    } else if (name === 'retry-prepare') {
      const path = join(coord, 'prepare-failures.json');
      const source = pathExists(path) ? readText(path) : null;
      const state = source === null ? { failures: {} } : JSON.parse(source);
      const latest = await readContext(name, i);
      if (controlFingerprint(name, latest, i) !== p.fingerprint) throw new Error('prepare state changed since plan');
      let changed = false;
      for (const f of Object.values(state.failures)) if (String(f.num) === i.item && f.held && !f.completed) { Object.assign(f, { held: false, retry: true }); changed = true; }
      // prepare-failure-policy's private save path, identical atomic rename and owner-only permissions.
      if ((pathExists(path) ? readText(path) : null) !== source) throw new Error('prepare ledger changed before save');
      if (changed) { makeDir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; writeText(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); chmod(temp, 0o600); rename(temp, path); }
      const holds = latest.holds.filter(isPrepareHold).map(h => ({ num: h.num ?? h.meta.num, reason: h.reason ?? h.meta.reason }));
      // The daemon helper owns prepare-unstamped. A pending stamp hold uses the same release primitive.
      await releasePrepare({ nums: [Number(i.item)], holds, release: ({ num }) => releaseHold({ repo: 'we', num: Number(num), lockRoot: join(coord, 'build-dispatch-holds') }) });
      for (const h of holds.filter(h => h.reason === 'prepare-stamp-pending')) await releaseHold({ repo: 'we', num: Number(h.num), lockRoot: join(coord, 'build-dispatch-holds') });
    } else if (name === 'rearm') child('scripts/conveyor/rearm-review.mjs', [String(i.pr), ...attribution]);
    else if (name === 'refresh') {
      const before = await readContext(name, i);
      if (controlFingerprint(name, before, i) !== p.fingerprint) throw new Error('refresh state changed before mutation');
      const result = await refresh(before.headRef, { root: i.checkout || root, base: before.main, prNumber: i.pr, repo: i.repo });
      if (!result.ok) throw new Error(result.error || 'refresh failed');
      const after = await readContext(name, i);
      if (!after.containsMain || !after.head || (result.newCommit && result.newCommit !== after.head)) throw new Error('could not verify refreshed PR head');
      await rememberRefresh(refreshStatePath(), `${i.repo}#${i.pr}`, after.head, { pass: before.requiredCheck ?? null });
    } else if (name === 'grant-rounds') await extensionSink(p.extension);
    else for (const c of p.claims) {
      const result = await releaseClaim({ repo: c.meta.repo, pr: c.meta.pr, kind: c.meta.kind, owner: c.owner, lockRoot: join(coord, 'fix-dispatch-claims') });
      if (!result.released) throw new Error(`claim release refused: ${result.reason}`);
    }
  });
  const prove = verify ?? ((p, after) => {
    if (p.op === 'refresh') return after.state === 'OPEN' && after.containsMain;
    if (p.op === 'grant-rounds') return true; // wrapped extension sink proves the trusted count and exact body
    if (p.op === 'clear-claim') return !after.claims.some(c => p.claims.some(old => old.meta.repo === c.meta.repo && old.meta.pr === c.meta.pr && old.meta.kind === c.meta.kind));
    if (p.op === 'rearm') return !after.labels.includes('review:changes') && (after.labels.includes('review:pending') || after.labels.includes('review:human'));
    if (p.op === 'unpark') return p.input.item ? !after.holds.length && !after.failures.length : !after.labels.includes('review:human');
    return !after.failures.some(f => f.held && !f.completed) && !after.holds.some(isPrepareHold);
  });
  return { [OPERATOR_CONTROL_EFFECT]: async p => {
    validateControlInput(p.op, p.input);
    if (p.input.preview || p.action === 'noop') return { action: 'noop', why: 'preview or nothing to do' };
    const before = await readContext(p.op, p.input), existing = await getRecords(p, before);
    if (p.records.every(r => existing.some(old => old.key === r.key))) return { action: 'noop', why: 'operator action key already recorded' };
    if (controlFingerprint(p.op, before, p.input) !== p.fingerprint) throw new Error('state changed since operator plan; re-run');
    const validated = planOperatorControl(p.op, { ...before, now: p.record.at }, p.input);
    if (validated.body !== p.body || JSON.stringify(validated.records) !== JSON.stringify(p.records) || validated.action !== 'apply') throw new Error('operator plan no longer valid');
    const effective = p.op === 'clear-claim' && existing.length ? { ...validated,
      claims: validated.claims.filter((_c, idx) => !existing.some(r => r.key === validated.records[idx].key)),
      records: validated.records.filter(r => !existing.some(old => old.key === r.key)),
    } : validated;
    await apply(p.op, effective);
    const after = await readContext(p.op, p.input);
    if (!await prove(effective, after)) throw new Error('could not verify operator mutation; no operator-action record written');
    for (const record of p.records) if (!existing.some(r => r.key === record.key)) await putRecord(record);
    return { action: 'apply', keys: p.records.map(r => r.key) };
  } };
}
