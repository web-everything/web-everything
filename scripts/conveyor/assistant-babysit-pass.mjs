/** Local observer: report-only, no actions, no GitHub writes. Uses only builtins and its new pure rules sibling. */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyPr, nextActor } from './assistant-babysit-rules.mjs';

const DEFAULT_REPOS = ['web-everything/web-everything', 'plateauapp/plateau-app'];
const stamp = (value) => {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('Invalid timestamp evidence');
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
  let entries;
  try { entries = io.readdirSync(root); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.flatMap((entry) => {
    const lock = readJson(io, join(root, entry, 'lock.json'), null);
    if (!lock || !['fix', 'fixing', 'ci-heal'].includes(lock.meta?.kind)) return [];
    const { meta } = lock;
    if (!meta.repo || !Number.isInteger(Number(meta.pr)) || !Number.isFinite(meta.ttlMinutes) || meta.ttlMinutes < 0) throw new Error('Incomplete claim evidence');
    return [{ repo: meta.repo, pr: Number(meta.pr), kind: meta.kind === 'ci-heal' ? 'ci-heal' : 'fix',
      claimedAtMs: stamp(meta.claimedAt), heartbeatAtMs: stamp(lock.heartbeatAt), ttlMinutes: meta.ttlMinutes, headShaAtClaim: meta.headSha }];
  });
}
const cell = (value) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\|/g, '\\|');

export function runTick({ repos = DEFAULT_REPOS, outDir = join(homedir(), '.plateau/assistant'), nowMs = Date.now(),
  exec = execFileSync, io = fs, env = process.env,
  coordDir = env.WE_COORDINATION_ROOT || join(homedir(), 'workspace/.operations/coordination'),
  whyCli, maxDetail = 25 } = {}) {
  if (!Number.isInteger(maxDetail) || maxDetail < 0) throw new Error('max-detail must be a nonnegative integer');
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
  const claims = loadClaims(io, coordDir);
  const whyPath = whyCli === undefined ? findWhy(io) : whyCli;
  const gh = (args) => exec('gh', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024, env: { ...env, GH_CALLER: 'wev-assistant' } });
  const at = new Date(nowMs).toISOString();
  const summary = { type: 'tick', at, repos, open: 0, owing: 0, reports: 0, skipped: 0 };
  const reports = [];
  let detailed = 0;
  for (const repo of repos) {
    const prs = JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number,labels,isDraft,mergeable,headRefOid,updatedAt,statusCheckRollup']));
    if (!Array.isArray(prs)) throw new Error('Incomplete PR list evidence');
    summary.open += prs.length;
    const candidates = [];
    for (const pr of prs) {
      if (!Number.isInteger(pr.number) || !Array.isArray(pr.labels) || !Array.isArray(pr.statusCheckRollup)
        || typeof pr.isDraft !== 'boolean' || !['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(pr.mergeable)
        || !/^[a-f0-9]+$/i.test(pr.headRefOid ?? '')) throw new Error('Incomplete PR evidence');
      const labels = pr.labels.map((label) => typeof label === 'string' ? label : label.name);
      if (labels.some((label) => typeof label !== 'string')) throw new Error('Incomplete label evidence');
      const snapshot = { repo, number: pr.number, labels, isDraft: pr.isDraft, mergeable: pr.mergeable,
        headSha: pr.headRefOid, nowMs, ciFailing: pr.statusCheckRollup.some((check) => ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR'].includes(String(check.conclusion || check.state).toUpperCase())),
        claims: claims.filter((claim) => claim.pr === pr.number && [repo, repo.split('/')[1], ...(repo === 'web-everything/web-everything' ? ['we'] : [])].includes(claim.repo)) };
      const { owed } = classifyPr(snapshot);
      if (owed.length) summary.owing++;
      const needsDetail = owed.length || labels.includes('ready-to-merge') || snapshot.claims.length
        || labels.some((label) => ['status:fixing', 'review-status:fixing'].includes(label));
      if (needsDetail) candidates.push({ snapshot, updatedAt: pr.updatedAt, updatedMs: stamp(pr.updatedAt) });
    }
    candidates.sort((a, b) => a.updatedMs - b.updatedMs || a.snapshot.number - b.snapshot.number);
    for (const { snapshot, updatedAt } of candidates) {
      if (detailed >= maxDetail) { summary.skipped++; continue; }
      detailed++;
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
      const current = classifyPr(snapshot).reports;
      if (current.length && whyPath && io.existsSync(whyPath)) {
        try {
          const why = JSON.parse(exec('node', [whyPath, 'why', `--pr=${snapshot.number}`, `--repo=${repo}`, '--json'], { encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024, env }));
          const verdict = why.verdict;
          const daemons = (verdict?.sections ?? why.sections)?.find((section) => section.name === 'daemons')?.lines ?? why.daemons;
          const lines = typeof daemons === 'string' ? daemons.split('\n') : Array.isArray(daemons) ? daemons : [];
          const fixLogLine = lines.find((line) => typeof line === 'string' && /^fix:/.test(line));
          for (const report of current) {
            if (verdict?.owner) report.owner = nextActor(snapshot, verdict);
            if (verdict?.waitingFor !== undefined) report.waitingFor = verdict.waitingFor;
            if (fixLogLine !== undefined) report.fixLogLine = fixLogLine;
          }
        } catch { /* Optional local explanation cannot invalidate observed reports. */ }
      }
      reports.push(...current);
    }
  }
  summary.reports = reports.length;
  const lines = [];
  for (const report of reports) {
    const key = JSON.stringify([report.repo, report.pr, report.rule, report.reason]);
    if (Number.isFinite(state.lastReported[key]) && nowMs - state.lastReported[key] < 60 * 60000) continue;
    lines.push(JSON.stringify({ type: 'report', at, ...report }));
    state.lastReported[key] = nowMs;
  }
  lines.push(JSON.stringify(summary));
  io.appendFileSync(join(outDir, 'reports.jsonl'), `${lines.join('\n')}\n`);
  const rows = reports.slice(0, 50).map((r) => `| ${[`${r.repo}#${r.pr}`, r.rule, r.minutes === null ? '' : Math.floor(r.minutes), r.owner, r.reason, r.fixLogLine].map(cell).join(' | ')} |`);
  io.writeFileSync(join(outDir, 'digest.md'), `# Assistant digest — ${at}\n\nOpen: ${summary.open}; owing: ${summary.owing}; reports: ${summary.reports}; skipped: ${summary.skipped}.\n\nSkipped PRs need operator inspection or a higher --max-detail; table limited to 50 current reports.\n\n| PR | rule | min | owner | reason | fix-log |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`);
  io.writeFileSync(join(outDir, 'state.json'), JSON.stringify(state, null, 2));
  return { summary, reports };
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
