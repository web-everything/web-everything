/**
 * we:scripts/conveyor/fix-resume.mjs — round N>1 of a fix: resume the previous round's fixer session, and move to a
 * stronger model from round 3 (card xrbu1bp, items 2 and 3 after card xx0055i).
 *
 * "The session's lane is still the PR's lane" is read on the BRANCH: the PR head is exactly the sha the session left
 * in its lane (nobody else pushed or rebased the PR since), and the base was not rewritten. The checkout itself is
 * reused when it is still the session's (its lease, or free and untouched since); a finished session's lease is
 * reaped at once and a busy pool reuses the lane within minutes, so otherwise the resumed session re-takes a lane at
 * the PR ref (step 1 of its brief) and keeps its memory of the work.
 *
 * Before: every fix round was a cold start. Live, PR #4689 had six `fix-4689` sessions in one day, each one
 * re-reading the card, re-acquiring a lane and re-learning the PR. And the model only got stronger after a finding
 * came back against an operator `block` ruling (`we:scripts/lib/fixer-escalation-policy.mjs`), never because rounds
 * kept failing.
 *
 * Two decisions live here, both PURE:
 *  - {@link planRoundEscalation}: from round `fix.strongerModelFromRound` (default 3) an ordinary fix round goes on
 *    the fixer ladder's stronger-model rung. The model is the routing policy's answer for that rung, never hand-set.
 *  - {@link planRoundResume}: resume the previous round's session instead of a cold start, only when it is still
 *    resumable AND its own lane is still this PR's lane at the PR head AND the base was not rebased under it AND
 *    the round does not need a different model than the session runs on. Anything else is a cold start with the
 *    round-history brief (card xx0055i), and the reason is reported.
 *
 * The IO half ({@link readRoundResumeInputs}) only READS: the `claude agents --json --all` listing (the session
 * named `fix-<pr>`), its job record under `~/.claude/jobs/<id>/state.json`, its transcript, the lane leases under the
 * pool root (`.git/.lane-lease`, whose `ownerSession` is the session that acquired the lane) and the pool's lane journal
 * (a finished session's lease is reaped, the journal still names the lane it acquired), and git in that lane.
 * It writes nothing.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isLeaseStale, LEASE_FILENAME } from '../lib/lane-lease.mjs';
import { defaultPoolRoot } from '../lib/lane-pool-paths.mjs';

/** Listing states a `claude --bg` session can be resumed from. A `working` (or idle-but-running) session would fork. */
export const RESUMABLE_STATES = Object.freeze(['done', 'stopped', 'failed', 'error']);

const lower = (s) => String(s ?? '').toLowerCase();
const sameSha = (a, b) => Boolean(a && b) && (lower(a).startsWith(lower(b)) || lower(b).startsWith(lower(a)));

/** The round this dispatch is: the rounds already spent plus one. */
export function roundOf(planned) {
  const spent = Number(planned?.attempts);
  return (Number.isFinite(spent) && spent > 0 ? Math.floor(spent) : 0) + 1;
}

/**
 * PURE: the stronger-model route for an ordinary fix round, or null. `fromRound` 0 turns it off. Only a rung this
 * dispatch path can launch counts (a `dispatch` rung that is available and routes to Claude): the `stronger-model`
 * rung when it is launchable, else the first launchable rung with its own route. No such rung: null (ordinary route).
 * @returns {null|{round:number, fromRound:number, rung:{id:string, label:string, taskType:?string, model:?string}, route:object}}
 */
export function planRoundEscalation({ round, fromRound, fixerLadder } = {}) {
  if (!Number.isInteger(fromRound) || fromRound < 1 || !Number.isInteger(round) || round < fromRound) return null;
  const rungs = fixerLadder?.policy?.rungs ?? [];
  const available = fixerLadder?.available ?? (() => true);
  const routes = fixerLadder?.routes ?? {};
  const launchable = rungs.filter((r) => r.action === 'dispatch' && r.taskType && available(r) && routes[r.id]?.provider === 'claude');
  const rung = launchable.find((r) => r.id === 'stronger-model') ?? launchable[0] ?? null;
  if (!rung) return null;
  return {
    round, fromRound, route: routes[rung.id],
    rung: { id: rung.id, label: rung.label ?? rung.id, taskType: rung.taskType ?? null, model: routes[rung.id]?.model ?? null },
  };
}

/** The `--model` value a job record's launch flags carry, or null. */
export function jobModel(job) {
  const flags = Array.isArray(job?.respawnFlags) ? job.respawnFlags : [];
  const i = flags.indexOf('--model');
  return i >= 0 && typeof flags[i + 1] === 'string' ? flags[i + 1] : null;
}

/** The latest listing row for this session slug (the previous round's fixer), or null. */
export function latestSessionRow(agentsAll, slug) {
  const rows = (Array.isArray(agentsAll) ? agentsAll : []).filter((a) => a && a.name === slug && a.sessionId);
  rows.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
  return rows[0] ?? null;
}

/**
 * PURE: resume the previous round's session, or cold-start. `{ resume: true, sessionId, lane }` or
 * `{ resume: false, reason, why }`. Checked in order, so the reason is the FIRST bound that fails.
 * @param {object} o
 * @param {object} o.planned          the planned fix entry (`pr`, `headRefOid`, `attempts`, `takeover`, `isConflict`, `restack`)
 * @param {object} [o.settings]       resolved `fix.*` settings (`resumeAcrossRounds`)
 * @param {?object} o.prior           the previous session's listing row
 * @param {?object} o.job             its job record (`{ template, respawnFlags }`), null when gone
 * @param {boolean} o.transcript      its transcript file still exists
 * @param {?object} o.lane            {@link findSessionLane}'s answer (`{ lane, path, held, head, sessionHead }`), null when none
 * @param {?object} o.base            `{ rebased: boolean|null }`
 * @param {?string} [o.desiredModel]  the `--model` this round must run on (null = the ordinary fix route: any)
 * @param {?string} [o.scratchRoot]   the dispatch scratch root (`dispatch-lane-io.mjs#dispatchScratchRoot`): the
 *   resume trigger starts in the previous session's cwd, so that cwd must be one of its direct children
 * @param {(p:string)=>string} [o.realpath] resolves symlinks (identity by default; the IO caller passes the real one)
 */
export function planRoundResume({ planned, settings, prior, job, transcript, lane, base, desiredModel = null, scratchRoot = null, realpath = (p) => p } = {}) {
  const no = (reason, why) => ({ resume: false, reason, why });
  if (settings?.resumeAcrossRounds === 'off') return no('setting-off', 'fix.resumeAcrossRounds is off');
  const round = roundOf(planned);
  if (round < 2) return no('first-round', 'round 1 has no earlier fixer session');
  if (planned?.takeover) return no('takeover', 'a takeover is a fresh focused session by design');
  if (planned?.isConflict) return no('conflict', 'a conflict bounce has its own resume path');
  if (planned?.restack) return no('restack', 'a restack starts fresh');
  if (!prior) return no('no-prior-session', 'no earlier fixer session is listed for this PR');
  if (!RESUMABLE_STATES.includes(prior.state)) {
    return no('prior-session-busy', `the earlier session ${prior.id ?? prior.sessionId} is ${prior.state} (resuming it would fork a copy)`);
  }
  if (!job) return no('job-record-gone', `no job record for ${prior.id ?? prior.sessionId}`);
  if (job.template && job.template !== 'bg') return no('not-a-bg-session', `job template ${job.template}`);
  if (!transcript) return no('transcript-gone', `the transcript of ${prior.sessionId} is gone`);
  if (!isScratchSessionDir(prior.cwd, scratchRoot, realpath)) {
    return no('prior-cwd-not-scratch', `the earlier session's cwd is not a dispatch scratch directory (a lane checkout would load its project settings and hooks, #4174)`);
  }
  const had = jobModel(job);
  if (desiredModel && had !== desiredModel) {
    return no('model-escalated', `this round runs on ${desiredModel}; the earlier session ran on ${had ?? 'the default route'}`);
  }
  if (!lane) return no('lane-not-found', `no lane acquired by ${prior.sessionId} was found (lease or pool journal)`);
  if (!lane.sessionHead) return no('session-head-unknown', `what ${prior.sessionId} left in lane-${lane.lane} is unknown`);
  if (!sameSha(lane.sessionHead, planned?.headRefOid)) {
    return no('pr-moved', `the PR head is ${String(planned?.headRefOid ?? '?').slice(0, 9)}, but the earlier session left `
      + `${String(lane.sessionHead).slice(0, 9)} — the PR branch moved under it (another push or a rebase)`);
  }
  if (base?.rebased === true) return no('base-rebased', `the base branch ${planned?.baseRefName ?? ''} was rewritten under the PR`);
  if (base?.rebased !== false) return no('base-unknown', `could not prove the base was not rebased${base?.why ? ` (${base.why})` : ''}`);
  return { resume: true, sessionId: prior.sessionId, id: prior.id ?? null, lane, round };
}

/**
 * PURE (given `realpath`): is `cwd` a direct child of the dispatch scratch root, named like a dispatch id? The round
 * resume starts its `claude --bg --resume` trigger in the previous session's listing cwd (where its transcript is
 * filed), and that cwd is trusted on the way in; a cwd anywhere else (a lane checkout the session `cd`'d into, a
 * sibling `dispatch-x`, `..`) is refused, never launched in. A path that cannot be resolved compares as given.
 */
export function isScratchSessionDir(cwd, scratchRoot, realpath = (p) => p) {
  if (typeof cwd !== 'string' || !cwd || typeof scratchRoot !== 'string' || !scratchRoot) return false;
  if (!isAbsolute(cwd) || !isAbsolute(scratchRoot)) return false;
  const real = (p) => { try { return realpath(p) || p; } catch { return p; } };
  const rel = relative(real(resolve(scratchRoot)), real(resolve(cwd)));
  return /^[0-9a-zA-Z][0-9a-zA-Z_-]{0,79}$/.test(rel);
}

/**
 * The prompt a resumed fixer gets: what is new, where its lane is, the brief steps to redo, then every round so far
 * (the last one is this round's findings). Quoted PR text is marked as DATA by the history section itself.
 */
export function buildRoundResumePrompt({ pr, itemNum = null, round, cap = null, lane, headRefOid, history = '' }) {
  const item = itemNum ? `item #${itemNum}` : 'no backlog item';
  const sha = String(headRefOid ?? '').slice(0, 9);
  const retake = lane?.held === 'own'
    ? `You still hold lane-${lane?.lane} (\`${lane?.path}\`), at the PR head \`${sha}\`. Work there: \`cd "${lane?.path}"\`.`
    : lane?.held === 'free' && sameSha(lane?.head, headRefOid)
      ? `Your lane was lane-${lane?.lane} (\`${lane?.path}\`); it was released when your last turn ended and nobody has taken it since. `
        + `Re-take it first with the SAME \`lane-pool.mjs acquire\` command as step 1 of your brief, but with \`--lane=${lane?.lane} --no-reset\` `
        + 'in place of `--base=...` (the two cannot be combined), then `cd` into it.'
      : `Your old lane-${lane?.lane} was released when your last turn ended and has been reused since. The PR head is exactly `
        + `the \`${sha}\` you left, so nothing is lost: acquire a fresh lane exactly as step 1 of your brief says (\`--base=\` the PR ref).`;
  return [
    `# New review round — PR #${pr} (${item}), round ${round}${cap ? ` of ${cap}` : ''}`,
    '',
    'You fixed the previous round of this PR in this session. The reviewer sent it back again after your push. You are',
    'resumed (not restarted) so you keep what you learned: do not re-read what you already know, read what is new.',
    '',
    retake,
    `Then confirm \`git rev-parse HEAD\` there is \`${sha}\`. If an acquire fails or HEAD is anything else, do NOT work in that lane:`,
    'acquire a fresh lane exactly as step 1 of your brief says (`--base=` the PR ref) and continue from there.',
    '',
    'Do this round exactly as the fix brief you already have says: step 0 (report `started`) and step 0b (`fix-begin`),',
    'then steps 2 to 9 (step 1 is the lane above). Answer every finding below, especially any marked as raised again.',
    '',
    history || '(no round history could be read for this PR — read the newest review comments on the PR first)',
  ].join('\n');
}

// ── IO ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `~/.claude/jobs/<id>/state.json`, or null. */
export function readJobRecord(id, { home = homedir(), read = (f) => readFileSync(f, 'utf8') } = {}) {
  if (!/^[0-9a-f]{8}$/i.test(String(id ?? ''))) return null;
  try { return JSON.parse(read(join(home, '.claude', 'jobs', String(id), 'state.json'))); } catch { return null; }
}

/** Does the session's transcript still exist? The job record names it; the cwd-derived path is the fallback. */
export function transcriptExists({ job, prior, home = homedir(), exists = existsSync }) {
  if (typeof job?.linkScanPath === 'string' && job.linkScanPath.endsWith('.jsonl') && exists(job.linkScanPath)) return true;
  if (!prior?.cwd || !prior?.sessionId) return false;
  return exists(join(home, '.claude', 'projects', String(prior.cwd).replace(/[^a-zA-Z0-9]/g, '-'), `${prior.sessionId}.jsonl`));
}

/** How much of a pool's lane journal is read (its tail): the previous round's acquire is hours old, not weeks. */
export const JOURNAL_TAIL_BYTES = 4 * 1024 * 1024;

/** The tail of a pool's `.lane-journal.jsonl` as parsed events (a torn first line is dropped). */
export function readJournalTail(file, { tailBytes = JOURNAL_TAIL_BYTES, open = openSync, fstat = fstatSync, readAt = readSync, close = closeSync } = {}) {
  let fd;
  try {
    fd = open(file, 'r');
    const size = fstat(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    readAt(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const out = [];
    for (const line of lines) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* torn line */ } }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { close(fd); } catch { /* read already done */ } }
  }
}

/**
 * PURE: the lane the session acquired, from a pool's journal events — the latest `acquire` whose actor session is
 * the session id and whose lease session is the slug — and whether anyone else acquired that lane since.
 * `releasedHead` is the lane's HEAD when that session's lease was released: what the session left.
 * @returns {null|{lane:number, takenSince:boolean, takenBy:?string, releasedHead:?string}}
 */
export function laneFromJournal(events, { slug, sessionId }) {
  const list = Array.isArray(events) ? events : [];
  let found = null;
  list.forEach((e, i) => {
    if (e?.action === 'acquire' && e.actor?.session === sessionId && e.session === slug && Number.isInteger(e.lane)) found = { lane: e.lane, i };
  });
  if (!found) return null;
  const after = list.slice(found.i + 1).filter((e) => e?.lane === found.lane);
  const release = after.find((e) => e?.action === 'release' && e.leaseOwnerSession === sessionId) ?? null;
  const later = after.find((e) => String(e?.action ?? '').startsWith('acquire') && e.actor?.session !== sessionId);
  return {
    lane: found.lane, takenSince: Boolean(later), takenBy: later?.session ?? later?.actor?.session ?? null,
    releasedHead: typeof release?.headBefore === 'string' ? release.headBefore : null,
  };
}

/**
 * The lane the session worked in and what it left there (`sessionHead`). The session's own lease is found first
 * (`ownerSession` is the session that acquired it). A finished session's lease is reaped (`lease-reaper`
 * `session-gone`), so otherwise the pool journal names the lane it acquired and the HEAD it was released at;
 * `held` says whether the checkout is still reusable (`own`, `free` and untouched since) or `taken`.
 * @returns {null|{lane:number, path:string, held:'own'|'free'|'taken', leaseLive:boolean, head:?string, sessionHead:?string, takenBy?:?string}}
 */
export function findSessionLane({ slug, sessionId, poolRoot, nowMs = Date.now(), list = readdirSync, read = (f) => readFileSync(f, 'utf8'), readJournal = readJournalTail, headOf }) {
  let pools = [];
  try { pools = list(poolRoot); } catch { return null; }
  const leaseOf = (path) => { try { return JSON.parse(read(join(path, '.git', LEASE_FILENAME))); } catch { return null; } };
  const headAt = (path) => { try { return headOf(path); } catch { return null; } };
  for (const pool of pools) {
    let lanes = [];
    try { lanes = list(join(poolRoot, pool)); } catch { continue; }
    for (const name of lanes) {
      const m = /^lane-(\d+)$/.exec(name);
      if (!m) continue;
      const path = join(poolRoot, pool, name);
      const lease = leaseOf(path);
      if (lease?.session !== slug || lease?.ownerSession !== sessionId) continue;
      const head = headAt(path);
      return { lane: Number(m[1]), path, held: 'own', leaseLive: !isLeaseStale(lease, nowMs), head, sessionHead: head };
    }
  }
  for (const pool of pools) {
    const hit = laneFromJournal(readJournal(join(poolRoot, pool, '.lane-journal.jsonl')), { slug, sessionId });
    if (!hit) continue;
    const path = join(poolRoot, pool, `lane-${hit.lane}`);
    const lease = leaseOf(path);
    const takenNow = Boolean(lease) && !isLeaseStale(lease, nowMs);
    const held = hit.takenSince || takenNow ? 'taken' : 'free';
    const head = headAt(path);
    return {
      lane: hit.lane, path, held, leaseLive: false, head,
      sessionHead: hit.releasedHead ?? (held === 'free' ? head : null),
      ...(held === 'taken' ? { takenBy: lease?.session ?? hit.takenBy ?? null } : {}),
    };
  }
  return null;
}

const SAFE_REF = /^(?!.*\.\.)[\w][\w./-]{0,200}$/;

/**
 * Was the base branch rewritten under the PR? `main` (the default branch) is never rewritten. For a stacked PR the
 * parent of the PR's first own commit (where the PR sits on its base) must still be an ancestor of the base tip:
 * GitHub's compare of `<parent>...<base>` answers `ahead` or `identical` exactly then. Read-only (`gh api`).
 * @param {{baseRefName:?string, firstParent:?string, repoSlug:string, defaultBranch?:string, ghApi:Function}} o
 */
export function baseRebasedUnder({ baseRefName, firstParent, repoSlug, defaultBranch = 'main', ghApi }) {
  if (!baseRefName || baseRefName === defaultBranch) return { rebased: false };
  if (!SAFE_REF.test(baseRefName)) return { rebased: null, why: 'unsafe base ref name' };
  if (!/^[0-9a-f]{40}$/i.test(String(firstParent ?? ''))) return { rebased: null, why: 'the PR\'s first commit parent is unknown' };
  try {
    const status = String(ghApi(`repos/${repoSlug}/compare/${firstParent}...${encodeURIComponent(baseRefName)}`, '.status') ?? '').trim();
    if (status === 'ahead' || status === 'identical') return { rebased: false };
    if (status === 'diverged' || status === 'behind') return { rebased: true };
    return { rebased: null, why: `compare status ${status || '(empty)'}` };
  } catch (e) {
    return { rebased: null, why: String(e?.message ?? e).split('\n')[0].slice(0, 160) };
  }
}

/**
 * The parent of the PR's first own commit, or null. Read from the REST pull-commits list (oldest first), whose
 * entries carry `parents`; `gh pr view --json commits` does not (its commits have only oid, dates, authors and
 * message), so a parent read there is always empty. Parsed here, not with `--jq`, so a test can feed the real payload.
 */
export function prFirstParent({ pr, repoSlug, exec }) {
  if (!Number.isSafeInteger(Number(pr)) || Number(pr) <= 0) return null;
  try {
    const out = exec('gh', ['api', `repos/${repoSlug}/pulls/${Number(pr)}/commits?per_page=1`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    const sha = String(JSON.parse(String(out ?? ''))?.[0]?.parents?.[0]?.sha ?? '').trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch { return null; }
}

const defaultGit = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
});

/**
 * Read everything {@link planRoundResume} needs for one planned entry. Never throws; a failed read leaves its field
 * null, which the plan reads as a cold start. Read-only: listing, job record, transcript, leases, journal, `git
 * rev-parse` in the lane, and (stacked PRs only) two `gh` reads for the base check.
 */
export function readRoundResumeInputs({
  planned, slug, root, listAgentsAll, repoSlug, defaultBranch = 'main',
  home = homedir(), poolRoot = defaultPoolRoot(root), git = defaultGit, readJob = (id) => readJobRecord(id, { home }),
  exec = execFileSync, nowMs = Date.now(),
} = {}) {
  let agents = [];
  try { agents = listAgentsAll() ?? []; } catch { agents = []; }
  const prior = latestSessionRow(agents, slug);
  if (!prior) return { prior: null };
  const job = readJob(prior.id ?? String(prior.sessionId).slice(0, 8));
  const transcript = transcriptExists({ job, prior, home });
  const lane = findSessionLane({ slug, sessionId: prior.sessionId, poolRoot, nowMs, headOf: (p) => git(p, ['rev-parse', 'HEAD']).trim() });
  const baseRefName = planned?.baseRefName ?? null;
  const stacked = baseRefName && baseRefName !== defaultBranch;
  const base = baseRebasedUnder({
    baseRefName, defaultBranch, repoSlug,
    firstParent: stacked ? prFirstParent({ pr: planned?.pr, repoSlug, exec }) : null,
    ghApi: (endpoint, jq) => exec('gh', ['api', endpoint, '--jq', jq], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }),
  });
  return { prior, job, transcript, lane, base };
}
