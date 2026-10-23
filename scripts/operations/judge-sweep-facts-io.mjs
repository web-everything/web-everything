/** GitHub/file observations for judge-sweep-facts. No GitHub mutations or agent dispatches. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { labelNames, listArgv, LIST_LIMIT } from './pr-status-io.mjs';
import { reduceCheckState } from './pr-status.mjs';
import { defaultListPrComments } from '../conveyor/pr-comments-list.mjs';
import { readFixLoopRows } from '../conveyor/fix-loop-ledger.mjs';
import { parseLiveJobs } from './pr-sweep-io.mjs';
import { redTeamRulingRow } from './operator-queue.mjs';
import { readReviewRound, readReviewRoundAsOf } from './review-pr-io.mjs';
import { parseLedgerEvents, verdictLedgerPath, verdictClears } from '../lib/verdict-ledger.mjs';
import { parseAdvisories, advisoryCoversHead, trustedAdvisoryComments } from '../lib/advisory-labels.mjs';
import { liveResultGateState, gateRoundCap, gateRoundGrants, readRedTeamDisposition, CONFIRMED_BREAKS_DEFAULTS } from '../lib/red-team-gate.mjs';
import { referralFindingKey } from '../lib/jury-core.mjs';
import { findingDefectClass } from '../lib/review-round-rules.mjs';
import { resolveRoundCap } from '../conveyor/reconcile-core.mjs';
import { liveReferralState } from '../lib/referral-live-context.mjs';
import { openReferralFindings } from './record-referral-ruling.mjs';
import { referralCardReadable } from '../lib/referral-card-readable.mjs';
import { ignoredRulings } from '../lib/ruling-ledger.mjs';
import { openOperatorSendBacks } from '../lib/operator-send-backs.mjs';
import { parseFindings } from '../review-corpus/mine-review-corpus.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { JUDGE_SWEEP_REPO } from './judge-sweep-facts.mjs';

const rootDir = () => join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_CALLS = 128;
const CACHE_ENTRIES = 256;
const CACHE_BYTES = 128 * 1024;
const RED_TEAM_JUDGMENT_LABELS = new Set(['red-team:blocked', 'red-team:clear']);
const failure = what => new Error(`judge-sweep-facts: ${what}; inspect PR evidence and rerun a narrower/operator query`);

/** Operator credential only, through the shared throttle. One attempt keeps the sweep budget inclusive of retries. */
export function operatorGh(args, options = {}) {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return runGhSync(args, { ...options, env,
    throttle: { bin: '/opt/homebrew/bin/gh', personalRoute: false, maxAttempts: 1 } });
}

/** A disposable, bounded head-and-base cache. Legacy head-only entries are misses. */
export function createShapeCache({ cacheDir = join(homedir(), '.claude', 'conveyor'),
  read = path => {
    if (statSync(path).size > CACHE_BYTES) throw failure('shape cache oversized');
    return readFileSync(path, 'utf8');
  }, write = (path, data) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(temp, data, { mode: 0o600 });
    renameSync(temp, path);
  } } = {}) {
  const path = join(cacheDir, 'judge-sweep-shape-cache.json');
  let entries;
  return {
    get(key) {
      if (!entries) {
        try {
          const parsed = JSON.parse(read(path));
          entries = new Map(Object.entries(parsed).filter(([k, v]) =>
            /^[\w.-]+\/[\w.-]+:[a-f0-9]{40}:[a-f0-9]{40}$/.test(k) && typeof v === 'boolean').slice(-CACHE_ENTRIES));
        } catch { entries = new Map(); }
      }
      return entries.get(key);
    },
    set(key, value) {
      this.get(key);
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > CACHE_ENTRIES) entries.delete(entries.keys().next().value);
      write(path, JSON.stringify(Object.fromEntries(entries)));
    },
  };
}

/** Reuse the published-finding parser and the canonical defect class; impact is the platform's severity. */
function commentVerdict(comment, advisory) {
  const body = comment.body;
  const findings = parseFindings(body).map(f => ({
    key: referralFindingKey(f.category, { file: f.path, line: f.line, summary: f.summary.replace(/ _\[.*$/, '') }),
    severity: f.impact, class: findingDefectClass(f),
  }));
  const expected = /### Findings \((\d+)\)/.exec(body);
  if (expected && Number(expected[1]) !== findings.length) throw failure('verdict findings incomplete');
  const table = body.split('### Panel verdicts')[1]?.split('### Findings')[0] ?? '';
  const lensVerdicts = Object.fromEntries([...table.matchAll(/^\| ([^|]+) \| (?:mandatory|advisory) \| ([^|]+) \|$/gm)]
    .map(m => [m[1].trim(), m[2].trim()]));
  return { headSha: advisory.head, at: new Date(advisory.time).toISOString(), accepted: advisory.outcome === 'accept', findings, lensVerdicts };
}

function readRows(repo) {
  const text = readFileSync(verdictLedgerPath(repo), 'utf8');
  const rows = parseLedgerEvents(text);
  if (rows.length !== text.split('\n').filter(l => l.trim()).length) throw failure('verdict ledger incomplete');
  return rows;
}

/** Injectable at every boundary; tests never need the host's credentials, process table, or ledgers. */
export function createJudgeSweepFactsReader({ gh = operatorGh, now = () => Date.now(),
  readLedgerRows = readRows, readFixRows = readFixLoopRows,
  readJobs = () => parseLiveJobs(execFileSync('ps', ['-axo', 'pid,etime,command'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })),
  readComments = defaultListPrComments, cache = createShapeCache(),
  shape = files => JSON.parse(execFileSync(process.execPath, [join(rootDir(), 'scripts/review-core-cli.mjs'), 'shape', '--json'], {
    // JSON stdin preserves commas, whitespace and shell syntax in filenames.
    input: JSON.stringify(files), cwd: rootDir(), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  })),
  baseCap = resolveRoundCap(process.env),
  cardReadable = ref => referralCardReadable(ref, rootDir(), { readOnPr: () => {
    // Remote card verification would break this operation's list + comments-only call budget.
    throw failure('remote referral card requires operator verification');
  } }),
} = {}) {
  return ({ repo = JUDGE_SWEEP_REPO } = {}) => {
    if (repo.length > 200 || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw failure('repo must be owner/name (at most 200 characters)');
    const start = now();
    let calls = 0;
    const boundedGh = args => {
      if (++calls > MAX_CALLS) throw failure('128-call budget exhausted');
      return String(gh(args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }));
    };
    const argv = listArgv({ repo });
    argv[argv.length - 1] += ',baseRefOid,updatedAt,files,changedFiles,author,assignees,body,createdAt,statusCheckRollup';
    const listing = JSON.parse(boundedGh(argv));
    if (!Array.isArray(listing) || listing.length >= LIST_LIMIT) throw failure('open PR listing incomplete (limit 200); use an exhaustive operator listing');
    let ledger = [], fixRows = [], jobs = [];
    const errors = [];
    try { ledger = readLedgerRows(repo); if (!Array.isArray(ledger)) throw failure('ledger shape'); } catch { errors.push('verdict ledger unreadable'); }
    try { fixRows = readFixRows(); if (!Array.isArray(fixRows)) throw failure('fix ledger shape'); } catch { errors.push('fix-loop ledger unreadable'); }
    try { jobs = readJobs(); if (!Array.isArray(jobs)) throw failure('jobs shape'); } catch { errors.push('live jobs unreadable'); }

    // The shared TSV reader asks for --paginate. Drive its pages here so *each* request consumes this sweep's budget.
    const commentsExec = (_file, args) => {
      const chunks = [];
      for (let page = 1; ; page++) {
        const chunk = boundedGh([...args.filter(a => a !== '--paginate'), '-F', `page=${page}`]);
        chunks.push(chunk);
        if (chunk.split('\n').filter(Boolean).length < 100) return chunks.join('\n');
      }
    };
    const prs = listing.map(p => {
      if (!Number.isSafeInteger(p?.number) || p.number <= 0 || !/^[a-f0-9]{40}$/i.test(p.headRefOid ?? '')
        || !Array.isArray(p.labels) || p.labels.some(l => typeof l?.name !== 'string')
        || !Number.isFinite(Date.parse(p.updatedAt)) || !Array.isArray(p.assignees)
        || p.assignees.some(a => typeof a?.login !== 'string' || !a.login)) throw failure('PR listing fields unreadable');
      const headSha = p.headRefOid.toLowerCase();
      const labels = labelNames(p.labels);
      const mine = ledger.filter(r => r.repo === repo && r.pr === p.number);
      const liveJobs = jobs.filter(j => j.repo === repo && j.pr === p.number);
      const fixerRunning = liveJobs.some(j => ['fix-run', 'ci-heal'].includes(j.kind));
      const owner = p.assignees[0]?.login ?? (liveJobs.length ? liveJobs[0].kind : null);
      const inCi = reduceCheckState((p.statusCheckRollup ?? []).map(c => c.status ? c : {
        ...c, name: c.context, status: c.state === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED',
        conclusion: c.state === 'ERROR' ? 'failure' : String(c.state ?? '').toLowerCase(),
      })).state === 'pending';
      const evidenceErrors = [...errors];
      const unscopedWorker = jobs.some(j => j.pr === p.number && !j.repo);
      if (unscopedWorker) evidenceErrors.push('worker repository unknown');
      const round = errors.includes('verdict ledger unreadable') ? null
        : readReviewRound({ repo, pr: p.number, head: headSha, readLedgerRows: () => mine });
      const fixes = fixRows.filter(r => [repo, repoKeyForSlug(repo)].includes(r.repo) && r.pr === p.number)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const lastFixLoop = fixes.length ? { kind: fixes[0].kind, outcome: fixes[0].outcome ?? null, at: fixes[0].at } : null;
      const result = { number: p.number, title: p.title, labels, headSha, round, cap: baseCap,
        redTeam: { state: 'unknown', latestResultId: null, latestOutcome: null }, latestVerdict: null,
        openReferrals: null, openSendBacks: null, lastFixLoop, humanRequired: null,
        minutesSinceUpdate: Math.max(0, (start - Date.parse(p.updatedAt)) / 60_000),
        fixerRunning: errors.includes('live jobs unreadable') || unscopedWorker ? null : fixerRunning,
        owner: (errors.includes('live jobs unreadable') || unscopedWorker) && !owner ? 'unknown' : owner,
        inCi, evidenceErrors, verdictHistory: [] };
      // Only a fresh, first-round PR with no historical findings or judgment labels is plainly in flight.
      const redTeamJudgmentLabel = labels.some(l => RED_TEAM_JUDGMENT_LABELS.has(l));
      const judgmentLabel = redTeamJudgmentLabel
        || labels.some(l => /human|changes|blocked|needs-you|escalated|round-limit|ruling-needed/.test(l));
      const skip = !evidenceErrors.length && round === 1 && !mine.length && !judgmentLabel
        && (fixerRunning || inCi || labels.includes('review:pending'));
      if (!skip) {
        try {
          const comments = readComments({ number: p.number, repo, exec: commentsExec });
          if (!Array.isArray(comments) || comments.some(c => typeof c?.body !== 'string' || !c.author?.login || !Number.isFinite(Date.parse(c.createdAt)))) throw failure('comments incomplete');
          const view = { ...p, repo, comments };
          const state = liveResultGateState(comments, p.number, headSha, repo);
          const ruling = redTeamRulingRow(repo, view);
          const disposition = readRedTeamDisposition({ comments, pr: p.number, head: headSha, repo, setting: CONFIRMED_BREAKS_DEFAULTS });
          const blocked = ruling || disposition.held.length || disposition.sendBack.length;
          result.redTeam = { state: blocked ? 'blocked' : labels.includes('red-team:pending') ? 'pending' : state.result ? 'clear' : 'unknown',
            latestResultId: state.resultId, latestOutcome: state.sendBackOutcome ?? [...state.outcomes].at(-1) ?? null };
          if (!state.result && redTeamJudgmentLabel) evidenceErrors.push('red-team label lacks live result evidence');
          const grants = gateRoundGrants(comments, p.number, repo);
          result.cap = gateRoundCap({ cap: baseCap, grants, roundAt: (at, g) => readReviewRoundAsOf({ repo, pr: p.number, at,
            head: Number.isInteger(state.headReviewIndex) && state.headReviewIndex < g.index ? headSha : null, readLedgerRows: () => mine }) });
          if (labels.includes('status:at-round-limit') && (round === null || round < result.cap - 1)) evidenceErrors.push('round-limit label disagrees with round evidence');
          const trusted = trustedAdvisoryComments(comments);
          result.verdictHistory = parseAdvisories(trusted).map(a => commentVerdict(trusted[a.index], a));
          const latest = result.verdictHistory[0];
          const current = mine.filter(r => r.type === 'verdict').at(-1);
          result.latestVerdict = latest && advisoryCoversHead({ head: latest.headSha }, headSha) ? latest
            : current?.coverage?.headSha === headSha ? { accepted: verdictClears(current.verdict), findings: null, lensVerdicts: null, evidence: 'ledger-only' } : null;
          if (result.latestVerdict?.evidence === 'ledger-only') evidenceErrors.push('verdict details unavailable');
          if (!result.latestVerdict && labels.some(l => ['advisory:accepted', 'review:accepted'].includes(l))) evidenceErrors.push('accepted label lacks live verdict evidence');
          if (result.latestVerdict && current?.coverage?.headSha === headSha && Date.parse(current.at) >= Date.parse(result.latestVerdict.at)
            && !verdictClears(current.verdict)) result.latestVerdict = { ...result.latestVerdict, accepted: false };
          const referrals = liveReferralState(view, { repo, pr: p.number, cardReadable });
          if (referrals.malformed) evidenceErrors.push('referral evidence malformed');
          const referralTargets = openReferralFindings({ comments, repo, pr: p.number, head: headSha,
            body: p.body, createdAt: p.createdAt, cardReadable });
          // These are active open targets. Superseded/dropped findings are excluded by the shared reader.
          result.openReferrals = [...referralTargets.open, ...referralTargets.disputed]
            .map(f => ({ key: f.key, ruled: f.state === 'blocked' || (f.rulingIds?.length ?? 0) > 0
              || referrals.records.some(r => r.rulings.some(rule => rule.key === f.key))
              || referrals.operatorRulings.some(rule => rule.key === f.key), superseded: false }));
          result.openSendBacks = openOperatorSendBacks(view);
          const ignored = ignoredRulings(view, { restackOf: () => false });
          result.ignoredFindingReturned = (ignored?.effectiveMisses ?? 0) >= 2;
        } catch { evidenceErrors.push('comment evidence unreadable or budget exhausted'); }
      }
      if (labels.includes('review:human')) {
        try {
          // A retarget or base advance can change the net files without changing the head.
          // Unknown base identity cannot reuse a prior non-human result.
          if (typeof p.baseRefOid !== 'string' || !/^[a-f0-9]{40}$/i.test(p.baseRefOid)) throw failure('base identity unreadable');
          const key = `${repo}:${headSha}:${p.baseRefOid.toLowerCase()}`;
          let human = cache.get(key);
          if (typeof human !== 'boolean') {
            if (!Array.isArray(p.files) || p.files.length !== p.changedFiles || !p.files.length
              || p.files.some(f => typeof f?.path !== 'string' || !f.path)
              || new Set(p.files.map(f => f.path)).size !== p.files.length) throw failure('net file list incomplete; inspect full diff');
            const shaped = shape(p.files.map(f => f.path));
            if (typeof shaped?.humanRequired !== 'boolean') throw failure('shape unreadable');
            human = shaped.humanRequired;
            cache.set(key, human);
          }
          result.humanRequired = human;
        } catch { result.humanRequired = null; evidenceErrors.push('shape unavailable; inspect full diff before delegating'); }
      }
      return result;
    });
    return { generatedAt: new Date(start).toISOString(), elapsedMs: Math.max(0, now() - start), prs };
  };
}
