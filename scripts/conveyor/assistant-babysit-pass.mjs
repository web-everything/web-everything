/** Local observer: shadow-only, no action execution or GitHub writes. */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { actionKey, decideActions } from './assistant-babysit-actions.mjs';
import { classifyPr, nextActor, human } from './assistant-babysit-rules.mjs';

const DEFAULT_REPOS = ['web-everything/web-everything', 'plateauapp/plateau-app'];
export const DEFAULT_CLAIM_TTL_MIN = 10; // matches the dispatch claim store default lease
const PR_LIST_LIMIT = 500;
const stamp = (value, field = 'timestamp evidence') => {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`Invalid ${field}`);
  return ms;
};
const readJson = (io, path, fallback) => {
  try { return JSON.parse(io.readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};
function findWhy(io) {
  let root = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const path = join(root, 'scripts/operations/run.mjs');
    if (io.existsSync(path)) return path;
    const parent = dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}
function loadClaims(io, coordDir) {
  const root = join(coordDir, 'fix-dispatch-claims');
  const claims = [];
  const badClaims = [];
  let entries;
  try { entries = io.readdirSync(root); }
  catch (error) { if (error.code === 'ENOENT') return { claims, badClaims }; throw error; }
  for (const entry of entries) {
    const path = join('fix-dispatch-claims', entry, 'lock.json');
    let repo;
    let pr;
    try {
      let lock;
      try { lock = JSON.parse(io.readFileSync(join(coordDir, path), 'utf8')); }
      catch (error) { throw new Error(error instanceof SyntaxError ? 'Invalid claim JSON' : `Unreadable claim: ${error.code ?? error.message}`); }
      const meta = lock?.meta;
      if (typeof meta?.repo === 'string' && meta.repo.trim()) repo = meta.repo;
      if (['number', 'string'].includes(typeof meta?.pr) && Number.isInteger(Number(meta.pr)) && Number(meta.pr) > 0) pr = Number(meta.pr);
      if (!repo) throw new Error('Missing or invalid meta.repo');
      if (!pr) throw new Error('Missing or invalid meta.pr');
      // Legacy claim files without a kind are skipped by the canonical store reader too; they are not bad claims.
      if (meta.kind === undefined) continue;
      if (typeof meta.kind !== 'string' || !meta.kind.trim()) throw new Error('Missing or invalid meta.kind');
      if (typeof lock.owner !== 'string' || !lock.owner.trim()) throw new Error('Missing or invalid owner');
      const ttlMinutes = meta.ttlMinutes ?? DEFAULT_CLAIM_TTL_MIN;
      if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) throw new Error('Invalid ttlMinutes');
      const claimedAtMs = stamp(meta.claimedAt, 'claimedAt');
      const heartbeatAtMs = stamp(lock.heartbeatAt, 'heartbeatAt');
      if (!['fix', 'fixing', 'ci-heal'].includes(meta.kind)) continue;
      claims.push({ repo, pr, kind: meta.kind === 'ci-heal' ? 'ci-heal' : 'fix',
        claimedAtMs, heartbeatAtMs, ttlMinutes, headShaAtClaim: meta.headSha });
    } catch (error) {
      badClaims.push({ path, ...(pr === undefined ? {} : { pr }), ...(repo === undefined ? {} : { repo }), problem: error.message });
    }
  }
  return { claims, badClaims };
}
const matchesRepo = (claim, repo) => [repo, repo.split('/')[1], ...(repo === 'web-everything/web-everything' ? ['we'] : [])].includes(claim.repo);
const cell = (value) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\|/g, '\\|');

export function runTick({ repos = DEFAULT_REPOS, outDir = join(homedir(), '.plateau/assistant'), nowMs = Date.now(),
  exec = execFileSync, io = fs, env = process.env,
  coordDir = env.WE_COORDINATION_ROOT || join(homedir(), 'workspace/.operations/coordination'),
  whyCli, maxDetail = 25, maxWhy = 6, stderr = (line) => process.stderr.write(line) } = {}) {
  if (!Number.isInteger(maxDetail) || maxDetail < 0) throw new Error('max-detail must be a nonnegative integer');
  if (!Number.isInteger(maxWhy) || maxWhy < 0) throw new Error('max-why must be a nonnegative integer');
  io.mkdirSync(outDir, { recursive: true });
  const state = readJson(io, join(outDir, 'state.json'), { events: {}, heads: {}, lastReported: {} });
  // Earlier caches contain only page one and cannot establish the latest change.
  if (state.labelEventsVersion !== 2) {
    state.events = {};
    state.labelEventsVersion = 2;
  }
  state.events ??= {};
  state.heads ??= {};
  state.lastReported ??= {};
  state.lastDetailAt ??= {};
  state.requiredChecks ??= {};
  state.whyCache ??= {};
  state.actions ??= {};
  state.escalations ??= {};
  let mode;
  try { mode = readJson(io, join(outDir, 'settings.json'), { mode: 'shadow' })?.mode; }
  catch { mode = 'off'; }
  if (mode === 'act') { stderr('act mode not built; shadow only\n'); mode = 'shadow'; }
  if (!['shadow', 'off'].includes(mode)) mode = 'off';
  const decisions = [];
  const warnings = [];
  const append = (file, line) => {
    try { io.appendFileSync(join(outDir, file), `${JSON.stringify(line)}\n`); return true; }
    catch (error) { stderr(`assistant ${file} append failed: ${cell(error.message)}\n`); return false; }
  };
  const { claims, badClaims } = loadClaims(io, coordDir);
  const whyPath = whyCli === undefined ? findWhy(io) : whyCli;
  const gh = (args) => exec('gh', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024, env: { ...env, GH_CALLER: 'wev-assistant' } });
  const at = new Date(nowMs).toISOString();
  const summary = { type: 'tick', at, repos, open: 0, owing: 0, reports: 0, wouldAct: 0, escalated: 0, badClaims: badClaims.length, skipped: 0, whySkipped: 0, truncated: false, repoSummaries: [] };
  // Named local evidence problems do not depend on the PR list or detail budget.
  const badByPr = new Map();
  for (const claim of badClaims) {
    if (claim.repo === undefined || claim.pr === undefined) continue;
    const repo = [...repos, ...DEFAULT_REPOS].find((repo) => matchesRepo(claim, repo)) ?? claim.repo;
    const key = JSON.stringify([repo, claim.pr]);
    if (!badByPr.has(key)) badByPr.set(key, { repo, number: claim.pr, nowMs, badClaims: [] });
    badByPr.get(key).badClaims.push(claim);
  }
  const reports = [...badByPr.values()].flatMap((snapshot) => classifyPr(snapshot).reports);
  const candidates = [];
  let detailed = 0;
  for (const repo of repos) {
    const listArgs = ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', 'number,labels,isDraft,mergeable,mergeStateStatus,headRefOid,updatedAt,statusCheckRollup,isInMergeQueue'];
    let prs;
    let queueFallback = false;
    try { prs = JSON.parse(gh(listArgs)); }
    catch (error) {
      if (!/unknown (?:json )?field[^\n]*isInMergeQueue/i.test(String(error.stderr ?? error.message))) throw error;
      // Older gh: require QUEUED plus auto-merge intent or the ready label; intent alone is not queue evidence.
      // Live probing is prohibited by the task's no-gh rule.
      queueFallback = true;
      listArgs[listArgs.length - 1] = listArgs.at(-1).replace('isInMergeQueue', 'autoMergeRequest');
      prs = JSON.parse(gh(listArgs));
    }
    let required = state.requiredChecks[repo];
    if (!required || required.version !== 2 || !Number.isFinite(required.at) || nowMs < required.at || nowMs - required.at >= 60 * 60000
      || !(required.names === null || (Array.isArray(required.names) && required.names.length && required.names.every((name) => typeof name === 'string' && name)))) {
      const names = [];
      const valid = (value) => Array.isArray(value) && value.length && value.every((name) => typeof name === 'string' && name.length);
      try {
        const value = JSON.parse(gh(['api', `repos/${repo}/branches/main/protection/required_status_checks`, '--jq', '[.contexts[], (.checks[]?.context)]']));
        if (valid(value)) names.push(...value);
      } catch { /* Still read the additive ruleset requirements. */ }
      try {
        const rules = JSON.parse(gh(['api', `repos/${repo}/rules/branches/main`]));
        const value = rules.filter((rule) => rule.type === 'required_status_checks')
          .flatMap((rule) => rule.parameters.required_status_checks.map((check) => check.context));
        if (valid(value)) names.push(...value);
      } catch { /* Explicit fallback below keeps the missing evidence visible. */ }
      // Version 2 caches the union; older classic-only caches must be refreshed.
      required = state.requiredChecks[repo] = { version: 2, at: nowMs, names: names.length ? [...new Set(names)] : null };
    }
    if (required.names === null) warnings.push(`required checks unavailable for ${repo}; using all checks`);
    const requiredNames = required.names === null ? null : new Set(required.names);
    if (!Array.isArray(prs)) throw new Error('Incomplete PR list evidence');
    const truncated = prs.length >= PR_LIST_LIMIT;
    summary.repoSummaries.push({ repo, open: prs.length, truncated });
    summary.truncated ||= truncated;
    summary.open += prs.length;
    for (const pr of prs) {
      if (!Number.isInteger(pr.number) || !Array.isArray(pr.labels) || !Array.isArray(pr.statusCheckRollup)
        || (queueFallback ? !Object.hasOwn(pr, 'autoMergeRequest') : typeof pr.isInMergeQueue !== 'boolean') || typeof pr.isDraft !== 'boolean' || !['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(pr.mergeable)
        || !/^[a-f0-9]+$/i.test(pr.headRefOid ?? '')) throw new Error('Incomplete PR evidence');
      const labels = pr.labels.map((label) => typeof label === 'string' ? label : label.name);
      if (labels.some((label) => typeof label !== 'string')) throw new Error('Incomplete label evidence');
      const failedChecks = pr.statusCheckRollup.filter((check) => requiredNames === null || requiredNames.has(check.name ?? check.context)).filter((check) => ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR', 'STARTUP_FAILURE'].includes(String(check.conclusion || check.state).toUpperCase()))
        .map((check) => ({ name: check.name ?? check.context, conclusion: String(check.conclusion || check.state).toUpperCase(),
          runId: /\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(check.detailsUrl ?? '')?.[1] ?? null }));
      const snapshot = { repo, number: pr.number, inMergeQueue: queueFallback ? pr.mergeStateStatus === 'QUEUED' && (pr.autoMergeRequest != null || labels.includes('status:ready-to-merge')) : pr.isInMergeQueue, labels, isDraft: pr.isDraft, mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus, failedChecks,
        headSha: pr.headRefOid, nowMs, ciFailing: failedChecks.length > 0,
        claims: claims.filter((claim) => claim.pr === pr.number && matchesRepo(claim, repo)) };
      const { owed } = classifyPr(snapshot);
      if (owed.length) summary.owing++;
      const needsDetail = owed.length || snapshot.ciFailing || labels.some((l) => ['status:stood-down', 'review-status:stood-down'].includes(l)) || snapshot.mergeStateStatus === 'BEHIND' || labels.includes('ready-to-merge') || snapshot.claims.length
        || labels.some((label) => ['status:fixing', 'review-status:fixing'].includes(label));
      if (needsDetail) {
        const detailKey = JSON.stringify([repo, pr.number]);
        const lastDetailAt = Number.isFinite(state.lastDetailAt[detailKey]) ? state.lastDetailAt[detailKey] : -Infinity;
        candidates.push({ snapshot, updatedAt: pr.updatedAt, updatedMs: stamp(pr.updatedAt), detailKey, lastDetailAt });
      }
    }
  }
  candidates.sort((a, b) => a.lastDetailAt - b.lastDetailAt || a.updatedMs - b.updatedMs || a.snapshot.number - b.snapshot.number);
  const observed = [];
  for (const { snapshot, updatedAt, detailKey } of candidates) {
    if (detailed >= maxDetail) { summary.skipped++; continue; }
    detailed++;
    const { repo } = snapshot;
    const key = JSON.stringify([repo, snapshot.number, updatedAt]);
    if (!Object.hasOwn(state.events, key)) {
      // gh follows all Link pages sequentially; timeout/maxBuffer bound the read.
      // Any failed or oversized read aborts the tick rather than caching a prefix.
      const pages = JSON.parse(gh(['api', `repos/${repo}/issues/${snapshot.number}/events?per_page=100`, '--paginate', '--slurp']));
      if (!Array.isArray(pages) || !pages.length || pages.some((page) => !Array.isArray(page))) throw new Error('Incomplete events evidence');
      const times = pages.flat().filter((event) => ['labeled', 'unlabeled'].includes(event.event)).map((event) => stamp(event.created_at));
      state.events[key] = times.length ? Math.max(...times) : null;
    }
    if (!Object.hasOwn(state.heads, snapshot.headSha)) {
      state.heads[snapshot.headSha] = stamp(String(gh(['api', `repos/${repo}/commits/${snapshot.headSha}`, '--jq', '.commit.committer.date'])).trim());
    }
    snapshot.labelChangedAtMs = state.events[key];
    snapshot.headChangedAtMs = state.heads[snapshot.headSha];
    observed.push({ snapshot, current: classifyPr(snapshot).reports });
    state.lastDetailAt[detailKey] = nowMs;
  }
  const whyKey = (snapshot) => `${snapshot.repo}#${snapshot.number}@${snapshot.headSha}`;
  const cacheAt = (snapshot) => Number.isFinite(state.whyCache[whyKey(snapshot)]?.at) ? state.whyCache[whyKey(snapshot)].at : -Infinity;
  observed.sort((a, b) => cacheAt(a.snapshot) - cacheAt(b.snapshot));
  let whyCalls = 0;
  for (const { snapshot, current } of observed) {
    const { repo } = snapshot;
    let explanation = {};
    if ((current.length || snapshot.ciFailing || (human(snapshot.labels) && classifyPr(snapshot).owed.length)) && whyPath && io.existsSync(whyPath)) {
      const key = whyKey(snapshot);
      const cached = state.whyCache[key];
      if (cached && Number.isFinite(cached.at) && nowMs >= cached.at && nowMs - cached.at < 30 * 60000
        && cached.verdict && typeof cached.verdict === 'object') explanation = cached.verdict;
      else if (whyCalls >= maxWhy) summary.whySkipped++;
      else {
        whyCalls++;
        try {
          // Six default calls at 20s leave time for the other tick reads within the three-minute target.
          const why = JSON.parse(exec('node', [whyPath, 'why', `--pr=${snapshot.number}`, `--repo=${repo}`, '--json'], { encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024, env }));
          const verdict = why.verdict ?? why;
          const daemons = (verdict.sections ?? why.sections)?.find((section) => section.name === 'daemons')?.lines ?? why.daemons;
          const lines = typeof daemons === 'string' ? daemons.split('\n') : Array.isArray(daemons) ? daemons : [];
          const fixLogLine = lines.find((line) => typeof line === 'string' && /^fix:/.test(line));
          explanation = { ...verdict, fixLogLine };
          state.whyCache[key] = { at: nowMs, verdict: explanation };
        } catch { /* Optional local explanation cannot invalidate observed reports. */ }
      }
      for (const report of current) {
        if (explanation.owner) report.owner = nextActor(snapshot, explanation);
        if (explanation.waitingFor !== undefined) report.waitingFor = explanation.waitingFor;
        if (explanation.fixLogLine !== undefined) report.fixLogLine = explanation.fixLogLine;
      }
    }
    if (mode === 'shadow') {
      const minutes = (nowMs - Math.max(snapshot.headChangedAtMs, snapshot.labelChangedAtMs ?? -Infinity)) / 60000;
      for (const report of current.length ? current : [null]) {
        const result = decideActions(snapshot, report, { why: explanation, minutes, settings: { mode }, done: state.actions });
        for (const action of result.actions) {
          const decision = { type: 'would-act', at, mode: 'shadow', action: action.type, repo, pr: snapshot.number,
            head: snapshot.headSha, argv: action.argv, reason: action.reason };
          if (append('actions.jsonl', decision)) {
            state.actions[actionKey(action)] = nowMs;
            decisions.push(decision);
            summary.wouldAct++;
          }
        }
        for (const escalation of result.escalations) {
          const key = JSON.stringify([repo, snapshot.number, snapshot.headSha, report.rule]);
          if (Number.isFinite(state.escalations[key]) && nowMs - state.escalations[key] < 60 * 60000) continue;
          const decision = { ...escalation, at, rule: report.rule };
          if (append('actions.jsonl', decision)) {
            state.escalations[key] = nowMs;
            decisions.push(decision);
            summary.escalated++;
          }
        }
      }
    }
    reports.push(...current);
  }
  summary.reports = reports.length;
  for (const report of reports) {
    const key = JSON.stringify([report.repo, report.pr, report.rule, report.reason]);
    if (Number.isFinite(state.lastReported[key]) && nowMs - state.lastReported[key] < 60 * 60000) continue;
    if (append('reports.jsonl', { type: 'report', at, ...report })) state.lastReported[key] = nowMs;
  }
  append('reports.jsonl', summary);
  const rows = reports.slice(0, 50).map((r) => `| ${[`${r.repo}#${r.pr}`, r.rule, r.minutes === null ? '' : Math.floor(r.minutes), r.owner, r.reason, r.fixLogLine].map(cell).join(' | ')} |`);
  const truncation = summary.truncated ? ' — TRUNCATED: some open PRs not seen' : '';
  const problems = badClaims.length ? `\n\nMalformed claims (up to 10 shown; inspect claim files):\n${badClaims.slice(0, 10).map((claim) => `- ${cell(claim.path)}: ${cell(claim.problem)}`).join('\n')}` : '';
  io.writeFileSync(join(outDir, 'digest.md'), `# Assistant digest — ${at}${truncation}\n\nOpen: ${summary.open}; owing: ${summary.owing}; reports: ${summary.reports}; badClaims: ${summary.badClaims}; skipped: ${summary.skipped}; whySkipped: ${summary.whySkipped}.${problems}\n${warnings.map(cell).join('\n')}\n\nPRs without why detail need operator inspection or a higher --max-why. Skipped PRs need operator inspection or a higher --max-detail; table limited to 50 current reports.${summary.truncated ? '\n\nTruncated repositories need operator inspection of the full open PR list: ' + summary.repoSummaries.filter((r) => r.truncated).map((r) => cell(r.repo)).join(', ') + '.' : ''}\n\n| PR | rule | min | owner | reason | fix-log |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n## Would act (shadow)\n\nUp to 30 new decisions; inspect actions.jsonl for the full log.\n${decisions.slice(0, 30).map((d) => `- ${cell(d.repo)}#${d.pr}: ${cell(d.action ?? d.type)} — ${cell(d.reason)}`).join('\n')}\n`);
  io.writeFileSync(join(outDir, 'state.json'), JSON.stringify(state, null, 2));
  return { summary, reports, badClaims };
}

async function main(argv) {
  const options = {};
  let loop = false;
  let interval = 300000;
  for (const arg of argv) {
    if (arg === '--once') loop = false;
    else if (arg === '--loop') loop = true;
    else if (arg.startsWith('--interval-ms=')) interval = Number(arg.slice(14));
    else if (arg.startsWith('--out-dir=')) options.outDir = arg.slice(10);
    else if (arg.startsWith('--repos=')) options.repos = arg.slice(8).split(',');
    else if (arg.startsWith('--why-cli=')) options.whyCli = arg.slice(10);
    else if (arg.startsWith('--max-why=')) options.maxWhy = Number(arg.slice(10));
    else if (arg.startsWith('--max-detail=')) options.maxDetail = Number(arg.slice(13));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(interval) || interval <= 0 || interval > 2147483647) throw new Error('Invalid interval-ms');
  if (options.repos?.some((repo) => !/^[\w.-]+\/[\w.-]+$/.test(repo))) throw new Error('Invalid repo slug');
  const tick = () => {
    try { runTick(options); }
    catch (error) {
      process.stderr.write(`assistant tick failed: ${cell(error.message)}\n`);
      if (!loop) process.exitCode = 1;
    }
    if (loop) setTimeout(tick, interval);
  };
  tick();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${cell(error.message)}\n`); process.exitCode = 1; });
}
